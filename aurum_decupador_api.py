from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from faster_whisper import WhisperModel
import subprocess, tempfile, pathlib, re, html, os

app=FastAPI(title="Aurum Decupador API")
app.add_middleware(CORSMiddleware,allow_origins=["*"],allow_credentials=False,allow_methods=["*"],allow_headers=["*"])
model=None
class LinkIn(BaseModel): url:str

def get_model():
    global model
    if model is None:
        model=WhisperModel("tiny",device="cpu",compute_type="int8",cpu_threads=2,num_workers=1)
    return model

def clean_chunks(chunks):
    bad=re.compile(r"^\s*[\[(]?(música|music|aplausos|applause|instrumental|som)[\])]?[.!]?\s*$",re.I)
    return [c for c in chunks if c["text"] and not bad.match(c["text"])]

def transcribe_path(path):
    segs,info=get_model().transcribe(str(path),language="pt",vad_filter=True,beam_size=1,condition_on_previous_text=False)
    chunks=[]
    for s in segs:
        t=(s.text or "").strip()
        if t: chunks.append({"start":round(float(s.start),2),"end":round(float(s.end),2),"text":t})
    chunks=clean_chunks(chunks)
    text=" ".join(x["text"] for x in chunks).strip()
    if len(text.split())<20: raise HTTPException(422,"Não encontrei fala suficiente neste arquivo.")
    return {"ok":True,"language":"pt","duration":round(float(getattr(info,"duration",0) or 0),2),"chunks":chunks,"text":text}

@app.get("/health")
def health(): return {"ok":True}

@app.post("/transcribe")
async def transcribe(file:UploadFile=File(...)):
    suffix=pathlib.Path(file.filename or "media.mp4").suffix or ".mp4"
    with tempfile.TemporaryDirectory() as td:
        p=pathlib.Path(td)/("media"+suffix)
        with p.open("wb") as f:
            while True:
                b=await file.read(1024*1024)
                if not b: break
                f.write(b)
        return transcribe_path(p)

def parse_vtt(text):
    chunks=[]; cur=None; lines=[]
    def flush():
        nonlocal cur,lines
        if cur and lines:
            t=re.sub(r"\s+"," ",html.unescape(re.sub(r"<[^>]+>",""," ".join(lines)))).strip()
            if t: chunks.append({"start":cur[0],"end":cur[1],"text":t})
        cur=None; lines=[]
    for raw in text.splitlines():
        line=raw.strip()
        if "-->" in line:
            flush()
            try:
                a,b=[x.strip().split(" ")[0] for x in line.split("-->")[:2]]
                def sec(v):
                    p=v.replace(",",".").split(":")
                    return float(p[-1])+60*float(p[-2])+(3600*float(p[-3]) if len(p)>2 else 0)
                cur=(sec(a),sec(b))
            except: cur=None
        elif cur and line and not line.isdigit() and not line.startswith(("WEBVTT","NOTE","Kind:","Language:")):
            lines.append(line)
    flush()
    out=[]
    for c in chunks:
        if not out or c["text"]!=out[-1]["text"]: out.append(c)
    return clean_chunks(out)

@app.post("/youtube-transcript")
def youtube_transcript(body:LinkIn):
    url=body.url.strip()
    if not url.startswith(("https://www.youtube.com/","https://youtube.com/","https://youtu.be/")): raise HTTPException(400,"Link do YouTube inválido.")
    with tempfile.TemporaryDirectory() as td:
        base=pathlib.Path(td)
        sub=str(base/"sub.%(ext)s")
        p=subprocess.run(["yt-dlp","--no-playlist","--skip-download","--write-subs","--write-auto-subs","--sub-langs","pt,pt-BR,pt-PT","--sub-format","vtt","-o",sub,url],capture_output=True,text=True,timeout=120)
        files=list(base.glob("sub*.vtt"))
        if files:
            chunks=parse_vtt(files[0].read_text(encoding="utf-8",errors="ignore"))
            text=" ".join(x["text"] for x in chunks).strip()
            if len(text.split())>=20:
                return {"ok":True,"language":"pt","duration":max(x["end"] for x in chunks),"chunks":chunks,"text":text}
        out=str(base/"audio.%(ext)s")
        p=subprocess.run(["yt-dlp","--no-playlist","-f","bestaudio/best","-o",out,url],capture_output=True,text=True,timeout=180)
        aud=[x for x in base.glob("audio.*") if x.is_file()]
        if not aud: raise HTTPException(422,"Não consegui obter áudio ou legenda deste vídeo.")
        return transcribe_path(aud[0])
