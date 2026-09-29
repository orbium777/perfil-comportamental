from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from faster_whisper import WhisperModel
import subprocess
import tempfile
import pathlib
import re
import html
import threading

app = FastAPI(title="Aurum Decupador API", version="3.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

_model = None
_model_lock = threading.Lock()
_inference_lock = threading.Lock()


class LinkIn(BaseModel):
    url: str


def get_model():
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                _model = WhisperModel(
                    "tiny",
                    device="cpu",
                    compute_type="int8",
                    cpu_threads=2,
                    num_workers=1,
                )
    return _model


def clean_text(text: str) -> str:
    text = text or ""
    text = re.sub(
        r"\[(?:música|music|aplausos|applause|instrumental|som|risos|laughter)\]",
        " ",
        text,
        flags=re.I,
    )
    text = re.sub(r"\s+", " ", text).strip()
    return text


def clean_chunks(chunks):
    out = []
    for c in chunks:
        t = clean_text(c.get("text", ""))
        if not t:
            continue
        if not re.search(r"[A-Za-zÀ-ÿ]{2,}", t):
            continue
        out.append({"start": c["start"], "end": c["end"], "text": t})
    return out


def transcribe_path(path: pathlib.Path):
    model = get_model()
    with _inference_lock:
        segments, info = model.transcribe(
            str(path),
            language="pt",
            task="transcribe",
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
            beam_size=2,
            condition_on_previous_text=False,
            temperature=0.0,
        )
        chunks = []
        for s in segments:
            t = clean_text(s.text or "")
            if t:
                chunks.append(
                    {
                        "start": round(float(s.start), 2),
                        "end": round(float(s.end), 2),
                        "text": t,
                    }
                )

    chunks = clean_chunks(chunks)
    text = " ".join(x["text"] for x in chunks).strip()
    if len(text.split()) < 3:
        raise HTTPException(422, "Não encontrei fala suficiente neste trecho.")

    return {
        "ok": True,
        "language": "pt",
        "duration": round(float(getattr(info, "duration", 0) or 0), 2),
        "chunks": chunks,
        "text": text,
    }


def safe_suffix(filename: str) -> str:
    suffix = pathlib.Path(filename or "audio.aac").suffix.lower()
    if not suffix or len(suffix) > 10 or not re.match(r"^\.[a-z0-9]+$", suffix):
        suffix = ".aac"
    return suffix


@app.get("/health")
def health():
    return {"ok": True, "model_loaded": _model is not None, "version": "3.0"}


@app.get("/warm")
def warm():
    get_model()
    return {"ok": True, "model_loaded": True, "version": "3.0"}


@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...)):
    suffix = safe_suffix(file.filename or "audio.aac")
    with tempfile.TemporaryDirectory() as td:
        path = pathlib.Path(td) / ("audio" + suffix)
        total = 0
        with path.open("wb") as out:
            while True:
                block = await file.read(1024 * 1024)
                if not block:
                    break
                total += len(block)
                if total > 64 * 1024 * 1024:
                    raise HTTPException(413, "Trecho de áudio grande demais.")
                out.write(block)
        if total < 512:
            raise HTTPException(400, "Trecho de áudio vazio.")
        return transcribe_path(path)


def parse_vtt(text):
    chunks = []
    current = None
    lines = []

    def flush():
        nonlocal current, lines
        if current and lines:
            t = clean_text(html.unescape(re.sub(r"<[^>]+>", "", " ".join(lines))))
            if t:
                chunks.append({"start": current[0], "end": current[1], "text": t})
        current = None
        lines = []

    def seconds(v):
        parts = v.replace(",", ".").split(":")
        return float(parts[-1]) + 60 * float(parts[-2]) + (3600 * float(parts[-3]) if len(parts) > 2 else 0)

    for raw in text.splitlines():
        line = raw.strip()
        if "-->" in line:
            flush()
            try:
                a, b = [x.strip().split(" ")[0] for x in line.split("-->")[:2]]
                current = (seconds(a), seconds(b))
            except Exception:
                current = None
        elif current and line and not line.isdigit() and not line.startswith(("WEBVTT", "NOTE", "Kind:", "Language:")):
            lines.append(line)
    flush()

    out = []
    for c in clean_chunks(chunks):
        if not out or c["text"] != out[-1]["text"]:
            out.append(c)
    return out


@app.post("/youtube-transcript")
def youtube_transcript(body: LinkIn):
    url = body.url.strip()
    if not url.startswith(("https://www.youtube.com/", "https://youtube.com/", "https://youtu.be/")):
        raise HTTPException(400, "Link do YouTube inválido.")

    with tempfile.TemporaryDirectory() as td:
        base = pathlib.Path(td)
        sub = str(base / "sub.%(ext)s")
        subprocess.run(
            [
                "yt-dlp",
                "--no-playlist",
                "--skip-download",
                "--write-subs",
                "--write-auto-subs",
                "--sub-langs",
                "pt,pt-BR,pt-PT",
                "--sub-format",
                "vtt",
                "-o",
                sub,
                url,
            ],
            capture_output=True,
            text=True,
            timeout=120,
        )
        files = list(base.glob("sub*.vtt"))
        if files:
            chunks = parse_vtt(files[0].read_text(encoding="utf-8", errors="ignore"))
            text = " ".join(x["text"] for x in chunks).strip()
            if len(text.split()) >= 20:
                return {
                    "ok": True,
                    "language": "pt",
                    "duration": max(x["end"] for x in chunks),
                    "chunks": chunks,
                    "text": text,
                }

        out = str(base / "audio.%(ext)s")
        subprocess.run(
            ["yt-dlp", "--no-playlist", "-f", "bestaudio/best", "-o", out, url],
            capture_output=True,
            text=True,
            timeout=240,
        )
        audio = [x for x in base.glob("audio.*") if x.is_file()]
        if not audio:
            raise HTTPException(422, "Não consegui obter áudio ou legenda deste vídeo.")
        return transcribe_path(audio[0])
