from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import subprocess, tempfile, pathlib, re, html

app = FastAPI(title='Aurum Decupador Link API')
app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_credentials=False,
    allow_methods=['GET','POST','OPTIONS'],
    allow_headers=['*'],
)

class LinkIn(BaseModel):
    url: str

@app.get('/health')
def health():
    return {'ok': True}

def parse_vtt(text: str):
    chunks=[]
    current_time=None
    current=[]
    for raw in text.splitlines():
        line=raw.strip()
        if not line or line.startswith('WEBVTT') or line.startswith('NOTE') or line.startswith('Kind:') or line.startswith('Language:'):
            if current_time and current:
                txt=' '.join(current)
                txt=re.sub(r'<[^>]+>', '', txt)
                txt=html.unescape(txt)
                txt=re.sub(r'\s+', ' ', txt).strip()
                if txt and (not chunks or txt != chunks[-1]['text']):
                    chunks.append({'start': current_time[0], 'end': current_time[1], 'text': txt})
            current_time=None; current=[]
            continue
        if '-->' in line:
            try:
                a,b=[x.strip().split(' ')[0] for x in line.split('-->')[:2]]
                def sec(v):
                    p=v.replace(',','.').split(':')
                    if len(p)==3: return float(p[0])*3600+float(p[1])*60+float(p[2])
                    return float(p[0])*60+float(p[1])
                current_time=(sec(a),sec(b))
                current=[]
            except Exception:
                current_time=None; current=[]
        elif current_time and not line.isdigit():
            current.append(line)
    if current_time and current:
        txt=' '.join(current)
        txt=re.sub(r'<[^>]+>', '', txt)
        txt=html.unescape(txt)
        txt=re.sub(r'\s+', ' ', txt).strip()
        if txt and (not chunks or txt != chunks[-1]['text']):
            chunks.append({'start': current_time[0], 'end': current_time[1], 'text': txt})
    return chunks

@app.post('/youtube-transcript')
def youtube_transcript(body: LinkIn):
    url=body.url.strip()
    if not url.startswith(('https://www.youtube.com/','https://youtube.com/','https://youtu.be/')):
        raise HTTPException(400,'Link do YouTube inválido.')
    with tempfile.TemporaryDirectory() as td:
        out=str(pathlib.Path(td)/'sub.%(ext)s')
        cmd=[
            'yt-dlp','--no-playlist','--skip-download',
            '--write-subs','--write-auto-subs',
            '--sub-langs','pt,pt-BR,pt-PT,en',
            '--sub-format','vtt',
            '-o',out,url
        ]
        p=subprocess.run(cmd,capture_output=True,text=True,timeout=90)
        files=list(pathlib.Path(td).glob('sub*.vtt'))
        if not files:
            detail='Este vídeo não disponibilizou legenda. Envie o arquivo de vídeo/áudio para a análise no navegador.'
            if p.stderr:
                low=p.stderr.lower()
                if 'sign in' in low or 'bot' in low:
                    detail='O YouTube bloqueou a leitura automática deste link. Envie o arquivo de vídeo/áudio para a análise no navegador.'
            raise HTTPException(422,detail)
        preferred=sorted(files,key=lambda x:(0 if '.pt' in x.name else 1,len(x.name)))[0]
        chunks=parse_vtt(preferred.read_text(encoding='utf-8',errors='ignore'))
        if not chunks:
            raise HTTPException(422,'A legenda foi encontrada, mas não pôde ser lida.')
        duration=max(c['end'] for c in chunks)
        return {'ok':True,'language':'pt','duration':duration,'chunks':chunks,'text':' '.join(c['text'] for c in chunks)}
