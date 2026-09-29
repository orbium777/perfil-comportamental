from fastapi import FastAPI, HTTPException, UploadFile, File, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from faster_whisper import WhisperModel
import subprocess, tempfile, pathlib, re, html, os, uuid, threading, shutil

app=FastAPI(title="Aurum Decupador API")
app.add_middleware(CORSMiddleware,allow_origins=["*"],allow_credentials=False,allow_methods=["*"],allow_headers=["*"])
model=None
model_lock=threading.Lock()
jobs={}
jobs_lock=threading.Lock()
UPLOAD_ROOT=pathlib.Path(tempfile.gettempdir())/"aurum_decupador_uploads"
UPLOAD_ROOT.mkdir(parents=True,exist_ok=True)

class LinkIn(BaseModel):
    url:str

class UploadStart(BaseModel):
    filename:str
    size:int
    chunks:int

def get_model():
    global model
    if model is None:
        with model_lock:
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
        if t:
            chunks.append({"start":round(float(s.start),2),"end":round(float(s.end),2),"text":t})
    chunks=clean_chunks(chunks)
    text=" ".join(x["text"] for x in chunks).strip()
    if len(text.split())<20:
        raise HTTPException(422,"Não encontrei fala suficiente neste arquivo.")
    return {"ok":True,"language":"pt","duration":round(float(getattr(info,"duration",0) or 0),2),"chunks":chunks,"text":text}

def safe_suffix(filename):
    suffix=pathlib.Path(filename or "media.mp4").suffix.lower()
    if not suffix or len(suffix)>10 or not re.match(r"^\.[a-z0-9]+$",suffix):
        suffix=".mp4"
    return suffix

def set_job(job_id, **fields):
    with jobs_lock:
        current=jobs.get(job_id,{})
        current.update(fields)
        jobs[job_id]=current

def process_chunked_upload(job_id):
    folder=UPLOAD_ROOT/job_id
    try:
        meta=jobs.get(job_id,{})
        total=int(meta.get("chunks",0))
        filename=meta.get("filename","media.mp4")
        set_job(job_id,status="assembling",message="Montando o arquivo de áudio/vídeo...")
        media=folder/("media"+safe_suffix(filename))
        with media.open("wb") as out:
            for i in range(total):
                part=folder/f"chunk_{i:06d}.part"
                if not part.exists():
                    raise RuntimeError(f"Parte {i+1} do arquivo não chegou ao servidor.")
                with part.open("rb") as src:
                    shutil.copyfileobj(src,out,1024*1024)
                try:
                    part.unlink()
                except Exception:
                    pass
        set_job(job_id,status="transcribing",message="Transcrevendo a fala do vídeo...")
        result=transcribe_path(media)
        set_job(job_id,status="done",message="Transcrição concluída.",result=result)
    except HTTPException as e:
        set_job(job_id,status="error",message=str(e.detail))
    except Exception as e:
        set_job(job_id,status="error",message=f"Falha no processamento: {e}")
    finally:
        try:
            shutil.rmtree(folder,ignore_errors=True)
        except Exception:
            pass

@app.get("/health")
def health():
    return {"ok":True,"jobs":len(jobs)}

@app.post("/upload/start")
def upload_start(body:UploadStart):
    if body.size<=0 or body.chunks<=0:
        raise HTTPException(400,"Arquivo inválido.")
    job_id=uuid.uuid4().hex
    folder=UPLOAD_ROOT/job_id
    folder.mkdir(parents=True,exist_ok=False)
    set_job(job_id,status="uploading",filename=body.filename,size=body.size,chunks=body.chunks,received=0,message="Recebendo arquivo...")
    return {"ok":True,"job_id":job_id}

@app.post("/upload/chunk/{job_id}/{index}")
async def upload_chunk(job_id:str,index:int,request:Request):
    folder=UPLOAD_ROOT/job_id
    with jobs_lock:
        meta=jobs.get(job_id)
    if not meta or not folder.exists():
        raise HTTPException(404,"Sessão de upload não encontrada.")
    total=int(meta.get("chunks",0))
    if index<0 or index>=total:
        raise HTTPException(400,"Parte inválida.")
    data=await request.body()
    if not data:
        raise HTTPException(400,"Parte vazia.")
    part=folder/f"chunk_{index:06d}.part"
    part.write_bytes(data)
    received=sum(1 for _ in folder.glob("chunk_*.part"))
    set_job(job_id,received=received,message=f"Recebendo arquivo: {received}/{total}")
    return {"ok":True,"received":received,"total":total}

@app.post("/upload/finish/{job_id}")
def upload_finish(job_id:str):
    with jobs_lock:
        meta=jobs.get(job_id)
    if not meta:
        raise HTTPException(404,"Sessão de upload não encontrada.")
    total=int(meta.get("chunks",0))
    received=int(meta.get("received",0))
    if received<total:
        raise HTTPException(409,f"Upload incompleto: {received}/{total} partes.")
    set_job(job_id,status="queued",message="Arquivo recebido. Preparando transcrição...")
    threading.Thread(target=process_chunked_upload,args=(job_id,),daemon=True).start()
    return {"ok":True,"job_id":job_id,"status":"queued"}

@app.get("/job/{job_id}")
def job_status(job_id:str):
    with jobs_lock:
        job=jobs.get(job_id)
        if not job:
            raise HTTPException(404,"Processamento não encontrado.")
        response={k:v for k,v in job.items() if k not in ("filename","size","chunks","received")}
    return {"ok":True,"job_id":job_id,**response}

@app.post("/transcribe")
async def transcribe(file:UploadFile=File(...)):
    suffix=safe_suffix(file.filename or "media.mp4")
    with tempfile.TemporaryDirectory() as td:
        p=pathlib.Path(td)/("media"+suffix)
        with p.open("wb") as f:
            while True:
                b=await file.read(1024*1024)
                if not b:
                    break
                f.write(b)
        return transcribe_path(p)

def parse_vtt(text):
    chunks=[]; cur=None; lines=[]
    def flush():
        nonlocal cur,lines
        if cur and lines:
            t=re.sub(r"\s+"," ",html.unescape(re.sub(r"<[^>]+>",""," ".join(lines)))).strip()
            if t:
                chunks.append({"start":cur[0],"end":cur[1],"text":t})
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
            except Exception:
                cur=None
        elif cur and line and not line.isdigit() and not line.startswith(("WEBVTT","NOTE","Kind:","Language:")):
            lines.append(line)
    flush()
    out=[]
    for c in chunks:
        if not out or c["text"]!=out[-1]["text"]:
            out.append(c)
    return clean_chunks(out)

@app.post("/youtube-transcript")
def youtube_transcript(body:LinkIn):
    url=body.url.strip()
    if not url.startswith(("https://www.youtube.com/","https://youtube.com/","https://youtu.be/")):
        raise HTTPException(400,"Link do YouTube inválido.")
    with tempfile.TemporaryDirectory() as td:
        base=pathlib.Path(td)
        sub=str(base/"sub.%(ext)s")
        subprocess.run(["yt-dlp","--no-playlist","--skip-download","--write-subs","--write-auto-subs","--sub-langs","pt,pt-BR,pt-PT","--sub-format","vtt","-o",sub,url],capture_output=True,text=True,timeout=120)
        files=list(base.glob("sub*.vtt"))
        if files:
            chunks=parse_vtt(files[0].read_text(encoding="utf-8",errors="ignore"))
            text=" ".join(x["text"] for x in chunks).strip()
            if len(text.split())>=20:
                return {"ok":True,"language":"pt","duration":max(x["end"] for x in chunks),"chunks":chunks,"text":text}
        out=str(base/"audio.%(ext)s")
        subprocess.run(["yt-dlp","--no-playlist","-f","bestaudio/best","-o",out,url],capture_output=True,text=True,timeout=180)
        aud=[x for x in base.glob("audio.*") if x.is_file()]
        if not aud:
            raise HTTPException(422,"Não consegui obter áudio ou legenda deste vídeo.")
        return transcribe_path(aud[0])
