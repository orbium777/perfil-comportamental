const API="https://aurum-decupador-engine.onrender.com";
let mode="file",lastText="",lastAnalysis=null,engineReady=false;
const $=s=>document.querySelector(s);

function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
function stat(t,e=false){$("#status").textContent=t;$("#status").classList.remove("hidden");$("#status").classList.toggle("error",e)}
function progress(v){$("#progressWrap").classList.remove("hidden");$("#progressBar").style.width=`${Math.max(0,Math.min(100,v))}%`}
function esc(v){return String(v??"").replace(/[&<>\"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#039;'}[x]))}
function time(s){s=Math.max(0,Number(s||0));const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),x=Math.floor(s%60);return h?`${h}:${String(m).padStart(2,"0")}:${String(x).padStart(2,"0")}`:`${m}:${String(x).padStart(2,"0")}`}
async function readJson(r){try{return await r.json()}catch{return{}}}

for(const b of document.querySelectorAll(".tab")){
  b.onclick=()=>{
    document.querySelectorAll(".tab").forEach(x=>x.classList.remove("active"));
    document.querySelectorAll(".pane").forEach(x=>x.classList.remove("active"));
    b.classList.add("active");mode=b.dataset.tab;
    $(mode==="file"?"#filePane":"#youtubePane").classList.add("active");
  };
}

async function ensureEngine(){
  if(engineReady)return true;
  stat("Iniciando o motor de transcrição...");progress(2);
  let alive=false;
  for(let i=0;i<30;i++){
    try{
      const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),7000);
      const r=await fetch(API+"/health?x="+Date.now(),{cache:"no-store",signal:ctl.signal});
      clearTimeout(timer);
      if(r.ok){alive=true;break}
    }catch{}
    stat(`Ligando o motor de transcrição... ${Math.min(150,(i+1)*5)}s`);
    await sleep(5000);
  }
  if(!alive)throw new Error("O motor de transcrição não iniciou. Tente novamente em alguns segundos.");

  stat("Carregando o modelo de voz...");progress(4);
  for(let attempt=0;attempt<2;attempt++){
    try{
      const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),180000);
      const r=await fetch(API+"/warm?x="+Date.now(),{cache:"no-store",signal:ctl.signal});
      clearTimeout(timer);
      if(r.ok){engineReady=true;return true}
    }catch{}
    if(attempt===0){await sleep(3000)}
  }
  throw new Error("O modelo de voz não conseguiu iniciar.");
}

function typeAt(u8,p){return String.fromCharCode(u8[p],u8[p+1],u8[p+2],u8[p+3])}
function u64(dv,p){return dv.getUint32(p)*4294967296+dv.getUint32(p+4)}

async function readTopBox(file,offset){
  const ab=await file.slice(offset,Math.min(file.size,offset+16)).arrayBuffer();
  if(ab.byteLength<8)throw new Error("MP4 inválido: cabeçalho incompleto.");
  const u8=new Uint8Array(ab),dv=new DataView(ab);let size=dv.getUint32(0),header=8;
  if(size===1){if(ab.byteLength<16)throw new Error("MP4 inválido: caixa estendida incompleta.");size=u64(dv,8);header=16}
  else if(size===0)size=file.size-offset;
  if(!Number.isFinite(size)||size<header||offset+size>file.size+1)throw new Error("MP4 inválido: estrutura inconsistente.");
  return{offset,size,header,type:typeAt(u8,4)};
}

function parseBoxes(ab,start=0,end=ab.byteLength){
  const u8=new Uint8Array(ab),dv=new DataView(ab),boxes=[];let p=start,guard=0;
  while(p+8<=end&&guard<100000){
    let size=dv.getUint32(p),header=8;const type=typeAt(u8,p+4);
    if(size===1){if(p+16>end)break;size=u64(dv,p+8);header=16}
    else if(size===0)size=end-p;
    if(!Number.isFinite(size)||size<header||p+size>end)break;
    boxes.push({start:p,end:p+size,size,header,type,payload:p+header});
    p+=size;guard++;
  }
  return boxes;
}

function children(ab,box){return parseBoxes(ab,box.payload,box.end)}
function child(ab,box,type){return children(ab,box).find(b=>b.type===type)||null}
function text4(u8,p){return String.fromCharCode(u8[p],u8[p+1],u8[p+2],u8[p+3])}

function parseAscObjectType(ab,entry){
  const u8=new Uint8Array(ab);
  const boxes=parseBoxes(ab,entry.start+36,entry.end);
  const esds=boxes.find(b=>b.type==="esds");
  if(!esds)return 2;
  for(let p=esds.payload+4;p<esds.end-3;p++){
    if(u8[p]!==0x05)continue;
    let q=p+1,len=0,n=0,b=0;
    do{if(q>=esds.end||n++>=4)break;b=u8[q++];len=(len<<7)|(b&0x7f)}while(b&0x80);
    if(len>=2&&len<=64&&q+len<=esds.end){const ot=(u8[q]>>3)&31;if(ot>=1&&ot<=31)return ot}
  }
  return 2;
}

function parseAudioTrackFromMoov(ab){
  const u8=new Uint8Array(ab),dv=new DataView(ab);
  const root=parseBoxes(ab);const moov=root.find(b=>b.type==="moov")||root[0];
  if(!moov||moov.type!=="moov")throw new Error("Metadados MP4 inválidos.");
  const traks=children(ab,moov).filter(b=>b.type==="trak");
  for(const trak of traks){
    const mdia=child(ab,trak,"mdia");if(!mdia)continue;
    const hdlr=child(ab,mdia,"hdlr");if(!hdlr||hdlr.payload+12>hdlr.end)continue;
    if(text4(u8,hdlr.payload+8)!=="soun")continue;
    const mdhd=child(ab,mdia,"mdhd"),minf=child(ab,mdia,"minf");
    const stbl=minf&&child(ab,minf,"stbl");
    if(!mdhd||!stbl)continue;

    const version=u8[mdhd.payload];
    const timescale=version===1?dv.getUint32(mdhd.payload+20):dv.getUint32(mdhd.payload+12);
    if(!timescale)throw new Error("Timescale de áudio inválido.");

    const stsd=child(ab,stbl,"stsd"),stts=child(ab,stbl,"stts"),stsc=child(ab,stbl,"stsc"),stsz=child(ab,stbl,"stsz");
    const stco=child(ab,stbl,"stco")||child(ab,stbl,"co64");
    if(!stsd||!stts||!stsc||!stsz||!stco)throw new Error("Tabela de áudio incompleta no MP4.");

    const entryCount=dv.getUint32(stsd.payload+4);if(!entryCount)throw new Error("MP4 sem descrição de áudio.");
    const entryStart=stsd.payload+8,entrySize=dv.getUint32(entryStart),entryType=text4(u8,entryStart+4);
    if(entryType!=="mp4a")throw new Error(`Codec de áudio ${entryType} ainda não é suportado. Use MP4 com áudio AAC ou envie MP3/WAV.`);
    if(entrySize<36||entryStart+entrySize>stsd.end)throw new Error("Descrição AAC inválida.");
    const channels=dv.getUint16(entryStart+24)||2;
    const sampleRate=(dv.getUint32(entryStart+32)>>>16)||timescale;
    const objectType=parseAscObjectType(ab,{start:entryStart,end:entryStart+entrySize});
    if(objectType!==2)throw new Error(`Perfil AAC ${objectType} não é suportado neste vídeo. Exporte com AAC-LC ou envie o áudio em MP3/WAV.`);

    const defaultSize=dv.getUint32(stsz.payload+4),sampleCount=dv.getUint32(stsz.payload+8);
    if(!sampleCount)throw new Error("Faixa de áudio vazia.");
    const sizes=new Uint32Array(sampleCount);
    if(defaultSize){sizes.fill(defaultSize)}
    else{
      let p=stsz.payload+12;
      if(p+sampleCount*4>stsz.end)throw new Error("Tabela de tamanho de áudio corrompida.");
      for(let i=0;i<sampleCount;i++,p+=4)sizes[i]=dv.getUint32(p);
    }

    const stscCount=dv.getUint32(stsc.payload+4),sc=[];let p=stsc.payload+8;
    for(let i=0;i<stscCount;i++,p+=12){sc.push({first:dv.getUint32(p),per:dv.getUint32(p+4)})}
    if(!sc.length)throw new Error("Mapa de chunks de áudio vazio.");

    const chunkCount=dv.getUint32(stco.payload+4),chunkOffsets=new Array(chunkCount);p=stco.payload+8;
    if(stco.type==="stco"){for(let i=0;i<chunkCount;i++,p+=4)chunkOffsets[i]=dv.getUint32(p)}
    else{for(let i=0;i<chunkCount;i++,p+=8)chunkOffsets[i]=u64(dv,p)}

    const samples=new Array(sampleCount);let si=0,sci=0;
    for(let chunkNo=1;chunkNo<=chunkCount&&si<sampleCount;chunkNo++){
      while(sci+1<sc.length&&chunkNo>=sc[sci+1].first)sci++;
      let off=chunkOffsets[chunkNo-1];const per=sc[sci].per;
      for(let j=0;j<per&&si<sampleCount;j++){
        const size=Number(sizes[si]);samples[si]={offset:off,size,dts:0,duration:0};off+=size;si++;
      }
    }
    if(si<sampleCount)throw new Error("Não consegui mapear todas as amostras de áudio.");

    const sttsCount=dv.getUint32(stts.payload+4);p=stts.payload+8;let idx=0,dts=0;
    for(let i=0;i<sttsCount;i++,p+=8){
      const count=dv.getUint32(p),delta=dv.getUint32(p+4);
      for(let k=0;k<count&&idx<sampleCount;k++,idx++){samples[idx].dts=dts;samples[idx].duration=delta;dts+=delta}
    }
    if(idx<sampleCount)throw new Error("Tabela temporal de áudio incompleta.");
    return{samples,timescale,rate:sampleRate,channels,objectType,duration:dts/timescale};
  }
  throw new Error("Este vídeo não possui uma faixa de áudio AAC utilizável.");
}

async function getAudioTrack(file){
  stat("Localizando os metadados do vídeo...");progress(5);
  let offset=0,moov=null,steps=0;
  while(offset<file.size&&steps<10000){
    const b=await readTopBox(file,offset);
    if(b.type==="moov"){moov=b;break}
    offset+=b.size;steps++;
    if(steps%25===0)await sleep(0);
  }
  if(!moov)throw new Error("Não encontrei os metadados deste MP4.");
  if(moov.size>192*1024*1024)throw new Error("Os metadados deste vídeo são grandes demais para processar no navegador.");
  stat(`Lendo ${(moov.size/1024/1024).toFixed(1)} MB de metadados...`);progress(7);
  const ab=await file.slice(moov.offset,moov.offset+moov.size).arrayBuffer();
  const meta=parseAudioTrackFromMoov(ab);
  progress(9);stat(`Áudio localizado: ${(meta.duration/60).toFixed(1)} min. Preparando ${Math.ceil(meta.duration/180)} blocos...`);
  return meta;
}

function aacFreqIndex(rate){const rates=[96000,88200,64000,48000,44100,32000,24000,22050,16000,12000,11025,8000,7350];const i=rates.indexOf(Number(rate));if(i<0)throw new Error("Taxa de áudio AAC não suportada: "+rate+" Hz.");return i}
function adtsHeader(payload,rate,channels,objectType=2){const fi=aacFreqIndex(rate),profile=Math.max(0,Math.min(3,objectType-1)),len=payload+7,ch=Math.max(1,Math.min(7,Number(channels)||2));const h=new Uint8Array(7);h[0]=0xff;h[1]=0xf1;h[2]=(profile<<6)|(fi<<2)|((ch>>2)&1);h[3]=((ch&3)<<6)|((len>>11)&3);h[4]=(len>>3)&255;h[5]=((len&7)<<5)|0x1f;h[6]=0xfc;return h}

function splitAudioSamples(samples,timescale,seconds=180){
  const out=[];let current=[],start=Number(samples[0].dts||0)/timescale;
  for(const s of samples){
    const t=Number(s.dts||0)/timescale;
    if(current.length&&t-start>=seconds){out.push({startSec:start,samples:current});current=[];start=t}
    current.push(s);
  }
  if(current.length)out.push({startSec:start,samples:current});
  return out;
}

async function buildAacSegment(file,segment,rate,channels,objectType,index,total){
  stat(`Extraindo áudio do bloco ${index+1} de ${total}...`);
  const MAX_GAP=1024*1024,MAX_SPAN=32*1024*1024,ranges=[];let g=null;
  for(const s of segment.samples){
    const so=Number(s.offset),sz=Number(s.size),end=so+sz;
    if(!g||so-g.end>MAX_GAP||end-g.start>MAX_SPAN){g={start:so,end,items:[]};ranges.push(g)}else g.end=Math.max(g.end,end);
    g.items.push(s);
  }
  const buffers=new Array(ranges.length);let next=0;
  async function worker(){
    while(true){
      const i=next++;if(i>=ranges.length)return;
      buffers[i]=new Uint8Array(await file.slice(ranges[i].start,ranges[i].end).arrayBuffer());
    }
  }
  const workers=Math.min(4,Math.max(2,Math.floor((navigator.hardwareConcurrency||4)/2)));
  await Promise.all(Array.from({length:workers},()=>worker()));

  let totalBytes=0;for(const s of segment.samples)totalBytes+=7+Number(s.size);
  const packed=new Uint8Array(totalBytes);let pos=0,ri=0;
  for(const s of segment.samples){
    const so=Number(s.offset),sz=Number(s.size);
    while(ri<ranges.length-1&&so>=ranges[ri].end)ri++;
    const gr=ranges[ri],u8=buffers[ri],rel=so-gr.start,h=adtsHeader(sz,rate,channels,objectType);
    if(rel<0||rel+sz>u8.length)throw new Error("Falha ao montar um bloco de áudio.");
    packed.set(h,pos);pos+=7;packed.set(u8.subarray(rel,rel+sz),pos);pos+=sz;
  }
  return new File([packed],`aurum-bloco-${String(index+1).padStart(2,"0")}.aac`,{type:"audio/aac"});
}

async function transcribeAudioPart(file,index,total,offsetSec){
  for(let attempt=0;attempt<4;attempt++){
    try{
      stat(`Transcrevendo bloco ${index+1} de ${total}...`);
      const fd=new FormData();fd.append("file",file,file.name);
      const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),8*60*1000);
      const r=await fetch(API+"/transcribe",{method:"POST",body:fd,signal:ctl.signal});clearTimeout(timer);
      const body=await readJson(r);
      if(r.status===422)return{chunks:[],text:""};
      if(!r.ok)throw new Error(body.detail||`Falha ao transcrever o bloco ${index+1}.`);
      const chunks=(body.chunks||[]).map(c=>({start:Number(c.start||0)+offsetSec,end:Number(c.end||0)+offsetSec,text:c.text||""}));
      return{chunks,text:chunks.map(c=>c.text).join(" ")};
    }catch(e){
      if(attempt===3)throw e;
      engineReady=false;
      stat(`Reconectando o motor no bloco ${index+1}...`);
      await ensureEngine();await sleep(1000);
    }
  }
}

async function transcribeVideo(file){
  const meta=await getAudioTrack(file);
  const segments=splitAudioSamples(meta.samples,meta.timescale,180);
  if(!segments.length)throw new Error("Não encontrei áudio utilizável neste vídeo.");
  await ensureEngine();
  const all=[],textParts=[];
  for(let i=0;i<segments.length;i++){
    const base=10+Math.round(76*i/segments.length);progress(base);
    const audio=await buildAacSegment(file,segments[i],meta.rate,meta.channels,meta.objectType,i,segments.length);
    const part=await transcribeAudioPart(audio,i,segments.length,segments[i].startSec);
    all.push(...part.chunks);if(part.text)textParts.push(part.text);
    progress(10+Math.round(76*(i+1)/segments.length));
    await sleep(0);
  }
  all.sort((a,b)=>a.start-b.start);
  const text=textParts.join(" ").replace(/\s+/g," ").trim();
  if(text.split(/\s+/).length<20)throw new Error("Não encontrei fala suficiente neste vídeo.");
  return{ok:true,language:"pt",duration:meta.duration||Math.max(0,...all.map(c=>c.end)),chunks:all,text};
}

async function transcribeFile(file){
  const isVideo=(file.type||"").startsWith("video/")||/\.(mp4|m4v|mov)$/i.test(file.name);
  if(isVideo)return transcribeVideo(file);
  await ensureEngine();
  const part=await transcribeAudioPart(file,0,1,0);
  if(!part.chunks.length)throw new Error("Não encontrei fala suficiente neste áudio.");
  return{ok:true,language:"pt",duration:Math.max(0,...part.chunks.map(c=>c.end)),chunks:part.chunks,text:part.text};
}

async function transcribeYoutube(){
  const url=$("#youtubeUrl").value.trim();if(!url)throw new Error("Cole o link do YouTube.");
  if(!$("#rights").checked)throw new Error("Confirme que tem autorização para processar este conteúdo.");
  await ensureEngine();stat("Lendo a legenda disponível do vídeo...");progress(30);
  const r=await fetch(API+"/youtube-transcript",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({url})});
  const body=await readJson(r);if(!r.ok)throw new Error(body.detail||"Não foi possível ler este vídeo.");progress(86);return body;
}

const stop=new Set("a o os as um uma uns umas de da do das dos em no na nos nas e é que para por com sem se ao aos à às como mais menos muito muita muitos muitas eu você vocês ele ela eles elas me te isso isto já não sim foi era ser ter tem tinha vai vou só também aí então porque quando onde quem qual quais meu minha seu sua nosso nossa gente pra pro".split(" "));
const emotion=new Set("chorei chorar medo dor milagre cura curado curada perdi perder morreu morte família filho filha mãe pai deus fé esperança sonho sofrimento difícil impossível vitória venceu superou salvou doença câncer hospital médico emocionante agradeço".split(" "));
const impact=new Set("nunca sempre ninguém todos verdade segredo erro maior melhor pior mudou transformou descobri aconteceu surpresa inacreditável absurdo atenção importante precisa deve pare".split(" "));
const teach=new Set("aprendi ensinar ensino dica passo fazer como forma maneira estratégia resultado funciona explicar explico primeiro segundo terceiro exemplo regra erro entender ensina ensinou palavra bíblia evangelho".split(" "));
function toks(t){return(t.toLowerCase().match(/[a-zà-öø-ÿ0-9]+/g)||[])}
function keywords(t,n=5){const c={};toks(t).filter(x=>x.length>3&&!stop.has(x)).forEach(x=>c[x]=(c[x]||0)+1);return Object.entries(c).sort((a,b)=>b[1]-a[1]).slice(0,n).map(x=>x[0])}
function cat(t){const s=new Set(toks(t)),e=[...s].filter(x=>emotion.has(x)).length,i=[...s].filter(x=>impact.has(x)).length,k=[...s].filter(x=>teach.has(x)).length;if(e>=Math.max(i,k)&&e)return"Emocional";if(k>=Math.max(e,i)&&k)return"Ensinamento";if(i)return"Impactante";return"Mensagem"}
function score(t,d){const s=new Set(toks(t)),e=[...s].filter(x=>emotion.has(x)).length,i=[...s].filter(x=>impact.has(x)).length,k=[...s].filter(x=>teach.has(x)).length;const fit=Math.max(0,1-Math.abs(d-42)/42),rich=Math.min(1,s.size/50);let v=46+14*fit+13*rich+5*e+4*i+4*k;if(/[.!?…][\"'”’)]?$/.test(t.trim()))v+=6;if(/^(e |mas |então |porque |que |aí )/i.test(t.trim()))v-=6;return Math.min(100,Math.round(v))}
function overlap(a,b){const l=Math.max(a.start,b.start),r=Math.min(a.end,b.end);return r<=l?0:(r-l)/Math.min(a.duration,b.duration)}

function analyze(data){
  const min=Number($("#minSec").value)||20,max=Math.min(59,Number($("#maxSec").value)||59),limit=Number($("#maxCuts").value)||20;
  const chunks=(data.chunks||[]).map(c=>({...c,text:(c.text||"").replace(/\[(música|music|aplausos|applause|instrumental|som|risos|laughter)\]/gi," ").replace(/\s+/g," ").trim()})).filter(c=>c.text&&c.text.split(/\s+/).length>=2);
  if(!chunks.length)throw new Error("Não foi encontrada fala utilizável para fazer a decupagem.");
  const wins=[];
  for(let i=0;i<chunks.length;i++){
    const st=chunks[i].start;const parts=[];
    for(let j=i;j<chunks.length;j++){
      if(j>i&&chunks[j].start-chunks[j-1].end>5)break;
      parts.push(chunks[j].text);const en=chunks[j].end,d=en-st;if(d>max+2)break;
      if(d>=min&&d<=max){
        const tx=parts.join(" ").replace(/\s+/g," ").trim(),words=tx.split(/\s+/).length;
        if(words>=30)wins.push({start:st,end:en,duration:d,text:tx,score:score(tx,d),category:cat(tx)});
      }
    }
  }
  wins.sort((a,b)=>b.score-a.score);
  const sel=[];for(const w of wins){if(sel.every(s=>overlap(w,s)<.25))sel.push(w);if(sel.length>=limit)break}
  sel.sort((a,b)=>a.start-b.start);
  if(!sel.length)throw new Error(`A fala foi transcrita, mas não encontrei trechos completos entre ${min} e ${max} segundos.`);
  const groups={};
  for(const x of sel){
    const low=x.text.toLowerCase();let sub="Mensagem";
    if(/deus|fé|jesus|senhor|oração|milagre|bíblia|evangelho|palavra/.test(low))sub="Mensagem de fé";
    else if(/família|filho|filha|mãe|pai|casamento/.test(low))sub="Família";
    else if(/testemunho|aconteceu comigo|eu passei|eu vivi/.test(low))sub="Testemunho";
    else if(x.category==="Emocional")sub="Mensagem emocional";
    else if(x.category==="Ensinamento")sub="Ensinamento";
    else if(x.category==="Impactante")sub="Mensagem de impacto";
    x.subject=sub;(groups[sub]??=[]).push(x);
  }
  const allkw=keywords(sel.map(x=>x.text).join(" "),8);
  return{summary:`Análise focada somente no áudio falado. Foram encontrados ${sel.length} trechos de mensagem entre ${min} e ${max} segundos. Temas recorrentes: ${allkw.join(", ")||"mensagem"}.`,subjects:Object.keys(groups),groups,cuts:sel};
}

function title(t){const s=t.split(/[.!?]/)[0].trim().split(/\s+/).slice(0,12).join(" ");return s+(t.split(/\s+/).length>12?"...":"")}
function render(a,data){
  $("#summary").textContent=a.summary;
  $("#subjects").innerHTML=a.subjects.map(s=>`<span class="chip">${esc(s)}</span>`).join("");
  $("#cutsTitle").textContent=`${a.cuts.length} cortes encontrados`;
  $("#transcriptText").textContent=data.text||"";
  $("#groups").innerHTML=Object.entries(a.groups).map(([sub,cuts])=>`<section class="subjectGroup"><div class="subjectTitle"><h3>${esc(sub)}</h3><span class="subjectCount">${cuts.length} trecho${cuts.length>1?"s":""}</span></div><div class="cuts">${cuts.map(c=>`<article class="cut"><div class="cutTop"><div><div class="eyebrow">${esc(c.category)}</div><h4>${esc(title(c.text))}</h4><div class="meta">${Math.round(c.duration)} segundos</div></div><div class="score">${c.score}</div></div><div class="timecode">${time(c.start)} → ${time(c.end)}</div><div class="hook">“${esc(c.text.slice(0,180))}”</div><div class="context">${esc(c.text.slice(0,430))}</div></article>`).join("")}</div></section>`).join("");
  lastAnalysis=a;lastText=a.cuts.map((c,i)=>`${i+1}. ${c.subject} | ${time(c.start)} → ${time(c.end)} | ${c.category} | ${title(c.text)}`).join("\n");
  $("#results").classList.remove("hidden");
}

$("#copyAll").onclick=async()=>{await navigator.clipboard.writeText(lastText);stat("Lista copiada.")};
$("#exportExcel").onclick=()=>{
  if(!lastAnalysis||!lastAnalysis.cuts?.length){stat("Faça uma análise antes de exportar.",true);return}
  const rows=[["Nº","Assunto","Categoria","Início","Fim","Duração (s)","Pontuação","Título","Trecho transcrito"]];
  lastAnalysis.cuts.forEach((c,i)=>rows.push([i+1,c.subject,c.category,time(c.start),time(c.end),Math.round(c.duration),c.score,title(c.text),c.text]));
  const xml='<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Decupagem"><Table>'+rows.map(r=>"<Row>"+r.map(v=>"<Cell><Data ss:Type=\""+(typeof v==="number"?"Number":"String")+"\">"+esc(v)+"</Data></Cell>").join("")+"</Row>").join("")+"</Table></Worksheet></Workbook>";
  const blob=new Blob(["\ufeff",xml],{type:"application/vnd.ms-excel"}),url=URL.createObjectURL(blob),a=document.createElement("a");
  a.href=url;a.download="aurum-decupagem-"+new Date().toISOString().slice(0,10)+".xls";document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);stat("Excel exportado.");
};

$("#analyzeBtn").onclick=async()=>{
  $("#analyzeBtn").disabled=true;$("#results").classList.add("hidden");progress(1);
  try{
    let data;
    if(mode==="file"){
      const f=$("#fileInput").files[0];if(!f)throw new Error("Escolha um vídeo ou áudio.");
      data=await transcribeFile(f);
    }else data=await transcribeYoutube();
    stat("Selecionando os melhores trechos de mensagem...");progress(90);
    const a=analyze(data);render(a,data);progress(100);stat("Análise concluída.");
  }catch(e){console.error(e);stat((e&&e.message)?e.message:"Falha no processamento. Tente novamente.",true);progress(0)}
  finally{$("#analyzeBtn").disabled=false}
};
