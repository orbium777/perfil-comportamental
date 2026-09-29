import * as MP4Box from "https://cdn.jsdelivr.net/npm/mp4box@2.4.1/+esm";

const API="https://aurum-decupador-engine.onrender.com";
let mode="file",lastText="",lastAnalysis=null;
const $=s=>document.querySelector(s);

document.querySelectorAll(".tab").forEach(b=>b.onclick=()=>{document.querySelectorAll(".tab").forEach(x=>x.classList.remove("active"));document.querySelectorAll(".pane").forEach(x=>x.classList.remove("active"));b.classList.add("active");mode=b.dataset.tab;$(mode==="file"?"#filePane":"#youtubePane").classList.add("active")});
function stat(t,e=false){$("#status").textContent=t;$("#status").classList.remove("hidden");$("#status").classList.toggle("error",e)}
function progress(v){$("#progressWrap").classList.remove("hidden");$("#progressBar").style.width=`${Math.max(0,Math.min(100,v))}%`}
function esc(v){return String(v??"").replace(/[&<>\"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#039;'}[x]))}
function time(s){s=Math.max(0,Number(s||0));let h=Math.floor(s/3600),m=Math.floor((s%3600)/60),x=Math.floor(s%60);return h?`${h}:${String(m).padStart(2,"0")}:${String(x).padStart(2,"0")}`:`${m}:${String(x).padStart(2,"0")}`}
async function readJson(r){try{return await r.json()}catch(e){return{}}}
function sleep(ms){return new Promise(r=>setTimeout(r,ms))}

async function wakeServer(){
  stat("Preparando o motor de transcrição...");progress(3);
  for(let i=0;i<24;i++){
    try{
      const ctl=new AbortController(),t=setTimeout(()=>ctl.abort(),7000);
      const r=await fetch(API+"/health?x="+Date.now(),{cache:"no-store",signal:ctl.signal});
      clearTimeout(t);if(r.ok)return true;
    }catch(e){}
    stat("Iniciando o motor de transcrição... "+Math.min(120,(i+1)*5)+"s");
    await sleep(5000);
  }
  throw new Error("O motor de transcrição não iniciou.");
}

function boxType(u8,o=4){return String.fromCharCode(u8[o],u8[o+1],u8[o+2],u8[o+3])}
async function readBox(file,offset){
  const ab=await file.slice(offset,Math.min(file.size,offset+16)).arrayBuffer();
  if(ab.byteLength<8)throw new Error("MP4 inválido: cabeçalho incompleto.");
  const u8=new Uint8Array(ab),dv=new DataView(ab);let size=dv.getUint32(0),header=8;
  if(size===1){if(ab.byteLength<16)throw new Error("MP4 inválido: caixa estendida incompleta.");size=dv.getUint32(8)*4294967296+dv.getUint32(12);header=16}else if(size===0)size=file.size-offset;
  if(!Number.isFinite(size)||size<header||offset+size>file.size+1)throw new Error("MP4 inválido: estrutura de arquivo inconsistente.");
  return{offset,size,header,type:boxType(u8)};
}
function aacFreqIndex(rate){const rates=[96000,88200,64000,48000,44100,32000,24000,22050,16000,12000,11025,8000,7350];const i=rates.indexOf(Number(rate));if(i<0)throw new Error("Taxa de áudio AAC não suportada: "+rate+" Hz.");return i}
function adtsHeader(payload,rate,channels,objectType=2){const fi=aacFreqIndex(rate),profile=Math.max(0,Math.min(3,objectType-1)),len=payload+7,ch=Math.max(1,Math.min(7,Number(channels)||2));const h=new Uint8Array(7);h[0]=0xff;h[1]=0xf1;h[2]=(profile<<6)|(fi<<2)|((ch>>2)&1);h[3]=((ch&3)<<6)|((len>>11)&3);h[4]=(len>>3)&255;h[5]=((len&7)<<5)|0x1f;h[6]=0xfc;return h}

async function getAudioTrack(file){
  stat("Lendo a estrutura do vídeo...");progress(5);
  let offset=0,ftyp=null,moov=null,steps=0;
  while(offset<file.size&&steps<10000){
    const b=await readBox(file,offset);
    if(b.type==="ftyp")ftyp=b;
    if(b.type==="moov"){moov=b;break}
    offset+=b.size;steps++;
    if(steps%20===0)await sleep(0);
  }
  if(!moov)throw new Error("Não encontrei os metadados deste MP4.");
  if(moov.size>128*1024*1024)throw new Error("Os metadados deste MP4 são grandes demais.");

  const mp4=MP4Box.createFile();
  const ready=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error("A leitura do MP4 demorou demais.")),15000);
    mp4.onReady=info=>{clearTimeout(timer);resolve(info)};
    mp4.onError=e=>{clearTimeout(timer);reject(new Error("Não consegui ler o MP4: "+e))};
  });
  if(ftyp){const b=await file.slice(ftyp.offset,ftyp.offset+ftyp.size).arrayBuffer();b.fileStart=ftyp.offset;mp4.appendBuffer(b)}
  const m=await file.slice(moov.offset,moov.offset+moov.size).arrayBuffer();m.fileStart=moov.offset;mp4.appendBuffer(m);mp4.flush();
  const info=await ready;
  const track=(info.audioTracks&&info.audioTracks[0])||info.tracks.find(t=>t.audio);
  if(!track)throw new Error("Este vídeo não possui faixa de áudio.");
  if(!/^mp4a\.40\.2/i.test(track.codec||""))throw new Error("O áudio deste MP4 não é AAC-LC. Envie o áudio em MP3/WAV ou use MP4 com áudio AAC.");
  const trak=mp4.getTrackById(track.id),samples=(trak&&trak.samples)||[];
  if(!samples.length)throw new Error("Não consegui localizar as amostras de áudio do vídeo.");
  const timescale=Number(track.timescale||trak?.timescale||48000);
  const rate=Number(track.audio?.sample_rate||48000),channels=Number(track.audio?.channel_count||2);
  return{samples,timescale,rate,channels,duration:Number(track.duration||0)/timescale};
}

function splitAudioSamples(samples,timescale,seconds=180){
  const valid=samples.filter(s=>Number.isFinite(Number(s.offset))&&Number(s.size)>0);
  if(!valid.length)return[];
  const out=[];let current=[],start=Number(valid[0].dts||0)/timescale;
  for(const s of valid){
    const t=Number(s.dts||0)/timescale;
    if(current.length&&t-start>=seconds){out.push({startSec:start,samples:current});current=[];start=t}
    current.push(s);
  }
  if(current.length)out.push({startSec:start,samples:current});
  return out;
}

async function buildAacSegment(file,segment,rate,channels,index,total){
  stat(`Extraindo áudio do trecho ${index+1} de ${total}...`);
  const MAX_GAP=512*1024,MAX_SPAN=24*1024*1024;
  const ranges=[];let g=null;
  for(const s of segment.samples){
    const so=Number(s.offset),sz=Number(s.size),end=so+sz;
    if(!g||so-g.end>MAX_GAP||end-g.start>MAX_SPAN){g={start:so,end,items:[]};ranges.push(g)}else g.end=Math.max(g.end,end);
    g.items.push(s);
  }
  let next=0;const buffers=new Array(ranges.length);
  async function worker(){while(true){const i=next++;if(i>=ranges.length)return;buffers[i]=new Uint8Array(await file.slice(ranges[i].start,ranges[i].end).arrayBuffer())}}
  const workers=Math.min(6,Math.max(2,Math.floor((navigator.hardwareConcurrency||4)/2)));
  await Promise.all(Array.from({length:workers},()=>worker()));
  let totalBytes=0;for(const s of segment.samples)totalBytes+=7+Number(s.size);
  const packed=new Uint8Array(totalBytes);let pos=0,ri=0;
  for(const s of segment.samples){
    const so=Number(s.offset),sz=Number(s.size);
    while(ri<ranges.length-1&&so>=ranges[ri].end)ri++;
    const gr=ranges[ri],u8=buffers[ri],rel=so-gr.start,h=adtsHeader(sz,rate,channels,2);
    packed.set(h,pos);pos+=7;packed.set(u8.subarray(rel,rel+sz),pos);pos+=sz;
  }
  return new File([packed],`trecho-${String(index+1).padStart(2,"0")}.aac`,{type:"audio/aac"});
}

async function transcribeAudioPart(file,index,total,offsetSec){
  for(let attempt=0;attempt<3;attempt++){
    try{
      stat(`Transcrevendo trecho ${index+1} de ${total}...`);
      const fd=new FormData();fd.append("file",file,file.name);
      const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),6*60*1000);
      const r=await fetch(API+"/transcribe",{method:"POST",body:fd,signal:ctl.signal});clearTimeout(timer);
      const body=await readJson(r);
      if(r.status===422)return{chunks:[],text:""};
      if(!r.ok)throw new Error(body.detail||`Falha ao transcrever o trecho ${index+1}.`);
      const chunks=(body.chunks||[]).map(c=>({start:Number(c.start||0)+offsetSec,end:Number(c.end||0)+offsetSec,text:c.text||""}));
      return{chunks,text:chunks.map(c=>c.text).join(" ")};
    }catch(e){
      if(attempt===2)throw e;
      stat(`Reconectando o trecho ${index+1}...`);
      await wakeServer();await sleep(1000);
    }
  }
}

async function transcribeVideo(file){
  const meta=await getAudioTrack(file);
  const segments=splitAudioSamples(meta.samples,meta.timescale,180);
  if(!segments.length)throw new Error("Não encontrei áudio utilizável neste vídeo.");
  await wakeServer();
  const all=[];let textParts=[];
  for(let i=0;i<segments.length;i++){
    progress(8+Math.round(76*i/segments.length));
    const audio=await buildAacSegment(file,segments[i],meta.rate,meta.channels,i,segments.length);
    const part=await transcribeAudioPart(audio,i,segments.length,segments[i].startSec);
    all.push(...part.chunks);if(part.text)textParts.push(part.text);
    progress(8+Math.round(76*(i+1)/segments.length));
    await sleep(0);
  }
  const text=textParts.join(" ").replace(/\s+/g," ").trim();
  if(text.split(/\s+/).length<20)throw new Error("Não encontrei fala suficiente neste vídeo.");
  return{ok:true,language:"pt",duration:meta.duration||Math.max(0,...all.map(c=>c.end)),chunks:all,text};
}

async function transcribeFile(file){
  const isVideo=(file.type||"").startsWith("video/")||/\.(mp4|m4v|mov)$/i.test(file.name);
  if(isVideo)return transcribeVideo(file);
  await wakeServer();
  const part=await transcribeAudioPart(file,0,1,0);
  if(!part.chunks.length)throw new Error("Não encontrei fala suficiente neste áudio.");
  return{ok:true,language:"pt",duration:Math.max(0,...part.chunks.map(c=>c.end)),chunks:part.chunks,text:part.text};
}

async function transcribeYoutube(){const url=$("#youtubeUrl").value.trim();if(!url)throw new Error("Cole o link do YouTube.");if(!$("#rights").checked)throw new Error("Confirme que tem autorização para processar o conteúdo.");await wakeServer();stat("Lendo a legenda disponível do vídeo...");progress(30);const r=await fetch(API+"/youtube-transcript",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({url})});const body=await readJson(r);if(!r.ok)throw new Error(body.detail||"Não foi possível ler este vídeo.");progress(82);return body}

const stop=new Set("a o os as um uma uns umas de da do das dos em no na nos nas e é que para por com sem se ao aos à às como mais menos muito muita muitos muitas eu você vocês ele ela eles elas me te isso isto já não sim foi era ser ter tem tinha vai vou só também aí então porque quando onde quem qual quais meu minha seu sua nosso nossa gente pra pro".split(" "));const emotion=new Set("chorei chorar medo dor milagre cura curado curada perdi perder morreu morte família filho filha mãe pai deus fé esperança sonho sofrimento difícil impossível vitória venceu superou salvou doença câncer hospital médico emocionante agradeço".split(" "));const impact=new Set("nunca sempre ninguém todos verdade segredo erro maior melhor pior mudou transformou descobri aconteceu surpresa inacreditável absurdo atenção importante precisa deve pare".split(" "));const teach=new Set("aprendi ensinar ensino dica passo fazer como forma maneira estratégia resultado funciona explicar explico primeiro segundo terceiro exemplo regra erro".split(" "));
function toks(t){return(t.toLowerCase().match(/[a-zà-öø-ÿ0-9]+/g)||[])}function keywords(t,n=5){let c={};toks(t).filter(x=>x.length>3&&!stop.has(x)).forEach(x=>c[x]=(c[x]||0)+1);return Object.entries(c).sort((a,b)=>b[1]-a[1]).slice(0,n).map(x=>x[0])}function cat(t){let s=new Set(toks(t)),e=[...s].filter(x=>emotion.has(x)).length,i=[...s].filter(x=>impact.has(x)).length,k=[...s].filter(x=>teach.has(x)).length;if(e>=Math.max(i,k)&&e)return"Emocional";if(k>=Math.max(e,i)&&k)return"Ensinamento";if(i)return"Impactante";return"Informativo"}function score(t,d){let s=new Set(toks(t)),e=[...s].filter(x=>emotion.has(x)).length,i=[...s].filter(x=>impact.has(x)).length,k=[...s].filter(x=>teach.has(x)).length;let fit=Math.max(0,1-Math.abs(d-40)/40),rich=Math.min(1,s.size/45);return Math.min(100,Math.round(48+14*fit+12*rich+5*e+4*i+3*k))}function overlap(a,b){let l=Math.max(a.start,b.start),r=Math.min(a.end,b.end);return r<=l?0:(r-l)/Math.min(a.duration,b.duration)}
function analyze(data){let min=Number($("#minSec").value)||20,max=Math.min(59,Number($("#maxSec").value)||59),limit=Number($("#maxCuts").value)||20;let chunks=(data.chunks||[]).map(c=>({...c,text:(c.text||"").replace(/\[(música|music|aplausos|applause|instrumental|som)\]/gi," ").replace(/\s+/g," ").trim()})).filter(c=>c.text&&c.text.split(/\s+/).length>=2);if(!chunks.length)throw new Error("Não foi encontrada fala utilizável para fazer a decupagem.");let wins=[];for(let i=0;i<chunks.length;i++){let st=chunks[i].start,parts=[];for(let j=i;j<chunks.length;j++){parts.push(chunks[j].text);let en=chunks[j].end,d=en-st;if(d>max+2)break;if(d>=min&&d<=max){let tx=parts.join(" ").replace(/\s+/g," ").trim(),words=tx.split(/\s+/).length;if(words>=35){let ending=/[.!?…][\"'”’)]?$/.test(tx),opening=/^(e |mas |então |porque |que |aí )/i.test(tx)?-5:3,sc=score(tx,d)+(ending?10:0)+opening;wins.push({start:st,end:en,duration:d,text:tx,score:Math.min(100,sc),category:cat(tx)})}}}}wins.sort((a,b)=>b.score-a.score);let sel=[];for(let w of wins){if(sel.every(s=>overlap(w,s)<.28))sel.push(w);if(sel.length>=limit)break}sel.sort((a,b)=>a.start-b.start);if(!sel.length)throw new Error("A fala foi transcrita, mas não encontrei trechos completos entre "+min+" e "+max+" segundos.");let groups={};for(let x of sel){let low=x.text.toLowerCase(),sub="Mensagem";if(/deus|fé|jesus|senhor|oração|milagre|palavra/.test(low))sub="Mensagem de fé";else if(/família|filho|filha|mãe|pai|casamento/.test(low))sub="Família";else if(/testemunho|aconteceu comigo|eu passei|eu vivi/.test(low))sub="Testemunho";else if(x.category==="Emocional")sub="Mensagem emocional";else if(x.category==="Ensinamento")sub="Ensinamento";else if(x.category==="Impactante")sub="Mensagem de impacto";x.subject=sub;(groups[sub]??=[]).push(x)}let allkw=keywords(sel.map(x=>x.text).join(" "),8);return{summary:`Análise focada somente no áudio falado. Foram encontrados ${sel.length} trechos de mensagem entre ${min} e ${max} segundos, prontos para você localizar no vídeo original. Temas recorrentes: ${allkw.join(", ")||"mensagem"}.`,subjects:Object.keys(groups),groups,cuts:sel}}
function title(t){let s=t.split(/[.!?]/)[0].trim().split(/\s+/).slice(0,12).join(" ");return s+(t.split(/\s+/).length>12?"...":"")}
function render(a,data){$("#summary").textContent=a.summary;$("#subjects").innerHTML=a.subjects.map(s=>`<span class="chip">${esc(s)}</span>`).join("");$("#cutsTitle").textContent=`${a.cuts.length} cortes encontrados`;$("#transcriptText").textContent=data.text||"";$("#groups").innerHTML=Object.entries(a.groups).map(([sub,cuts])=>`<section class="subjectGroup"><div class="subjectTitle"><h3>${esc(sub)}</h3><span class="subjectCount">${cuts.length} trecho${cuts.length>1?"s":""}</span></div><div class="cuts">${cuts.map(c=>`<article class="cut"><div class="cutTop"><div><div class="eyebrow">${esc(c.category)}</div><h4>${esc(title(c.text))}</h4><div class="meta">${Math.round(c.duration)} segundos</div></div><div class="score">${c.score}</div></div><div class="timecode">${time(c.start)} → ${time(c.end)}</div><div class="hook">“${esc(c.text.slice(0,180))}”</div><div class="context">${esc(c.text.slice(0,430))}</div></article>`).join("")}</div></section>`).join("");lastAnalysis=a;lastText=a.cuts.map((c,i)=>`${i+1}. ${c.subject} | ${time(c.start)} → ${time(c.end)} | ${c.category} | ${title(c.text)}`).join("\n");$("#results").classList.remove("hidden")}
$("#copyAll").onclick=async()=>{await navigator.clipboard.writeText(lastText);stat("Lista copiada.")};
$("#exportExcel").onclick=()=>{if(!lastAnalysis||!lastAnalysis.cuts?.length){stat("Faça uma análise antes de exportar.",true);return}const rows=[["Nº","Assunto","Categoria","Início","Fim","Duração (s)","Pontuação","Título","Trecho transcrito"]];lastAnalysis.cuts.forEach((c,i)=>rows.push([i+1,c.subject,c.category,time(c.start),time(c.end),Math.round(c.duration),c.score,title(c.text),c.text]));const xml='<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Decupagem"><Table>'+rows.map(r=>"<Row>"+r.map(v=>"<Cell><Data ss:Type=\""+(typeof v==="number"?"Number":"String")+"\">"+esc(v)+"</Data></Cell>").join("")+"</Row>").join("")+"</Table></Worksheet></Workbook>";const blob=new Blob(["\ufeff",xml],{type:"application/vnd.ms-excel"});const url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download="aurum-decupagem-"+new Date().toISOString().slice(0,10)+".xls";document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);stat("Excel exportado.")};
$("#analyzeBtn").onclick=async()=>{$("#analyzeBtn").disabled=true;$("#results").classList.add("hidden");progress(2);try{let data;if(mode==="file"){let f=$("#fileInput").files[0];if(!f)throw new Error("Escolha um vídeo ou áudio.");data=await transcribeFile(f)}else data=await transcribeYoutube();stat("Separando os melhores assuntos e trechos...");progress(90);let a=analyze(data);render(a,data);progress(100);stat("Análise concluída.")}catch(e){console.error(e);stat((e&&e.message)?e.message:"Falha no processamento. Tente novamente.",true);progress(0)}finally{$("#analyzeBtn").disabled=false}};