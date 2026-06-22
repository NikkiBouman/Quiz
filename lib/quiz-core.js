/* quiz-core.js — gedeelde, DOM-loze kern voor de quizshow.
 *
 * Gebruikt door:
 *   - index.html   (het spel: laadt/normaliseert vragensets, speler-zoekopdrachten)
 *   - quizzes.html (de quiz-editor/-beheerder)
 *   - questions.html (de persoonlijke vragenbank)
 *
 * Alles hier is puur data + localStorage + fetch — geen game-state, geen rendering.
 * Eén bron van waarheid voor de vraag-pijplijn, de opslag en de bibliotheek-catalogus.
 */

export const TMDB_PROXY = "https://quiz-tmdb-proxy.nikkibouman.workers.dev";

export const esc = s => String(s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

/* ============================================================
   VRAAG-PIJPLIJN  (flatten → validate → normalize → shuffle)
   ============================================================ */
export function flattenQuiz(data){
  if(Array.isArray(data)) return { questions:data.slice(), rounds:[{name:'',intro:'',start:0,end:data.length}] };
  if(data && Array.isArray(data.rounds)){
    const questions=[], rounds=[];
    data.rounds.forEach(rd=>{
      const qs = Array.isArray(rd.questions)?rd.questions:[];
      const start=questions.length;
      qs.forEach(q=>questions.push(q));
      rounds.push({ name:rd.name||'', intro:rd.intro||'', start, end:questions.length });
    });
    return { questions, rounds };
  }
  return { questions:[], rounds:[{name:'',intro:'',start:0,end:0}] };
}

export function validateQuiz(raw){
  if(raw && !Array.isArray(raw) && Array.isArray(raw.rounds)){
    for(let ri=0; ri<raw.rounds.length; ri++){
      const rd=raw.rounds[ri];
      if(!rd || typeof rd!=='object') return `Ronde ${ri+1} is ongeldig.`;
      if(!Array.isArray(rd.questions) || !rd.questions.length) return `Ronde ${ri+1} ("${rd.name||''}") heeft geen vragen.`;
    }
  }
  const data = flattenQuiz(raw).questions;
  return validateQuestions(data);
}

export function validateQuestions(data){
  if(!Array.isArray(data) || !data.length) return 'Het bestand moet een niet-lege lijst met vragen zijn.';
  for(let i=0;i<data.length;i++){
    const q=data[i], n=i+1;
    if(!q || typeof q!=='object') return `Vraag ${n} is ongeldig.`;
    const apiOpts = typeof q.options==='string' && [':tmdb',':deezer'].includes(q.options);
    const textOpts = q.options===':text';
    const listOpts = Array.isArray(q.options);
    if(!apiOpts && !textOpts && !listOpts) return `Vraag ${n}: 'options' moet een lijst zijn of ":tmdb"/":deezer"/":text".`;
    if(listOpts && q.options.length<2) return `Vraag ${n}: minstens 2 opties nodig.`;
    if(textOpts){
      if(q.answer==null && !q.answerLabel) return `Vraag ${n}: bij ":text" is 'answer' of 'answerLabel' nodig.`;
    } else {
      const ans = q.answer!=null ? q.answer : q.correctIndex;
      if(ans==null) return `Vraag ${n}: 'answer' ontbreekt.`;
      if(listOpts && (typeof ans!=='number' || ans<0 || ans>=q.options.length)) return `Vraag ${n}: 'answer' moet een geldige index zijn.`;
      if(apiOpts && !q.answerLabel) return `Vraag ${n}: bij ":tmdb"/":deezer" is 'answerLabel' nodig.`;
    }
    if(q.stages!=null){
      if(!Array.isArray(q.stages)||!q.stages.length) return `Vraag ${n}: 'stages' moet een niet-lege lijst zijn.`;
      for(let j=0;j<q.stages.length;j++){
        const s=q.stages[j];
        const has = s && (s.text!=null||s.image!=null||s.audio!=null||s.video!=null||(s.type&&s.display!=null));
        if(!has) return `Vraag ${n}, stage ${j+1}: heeft tekst, image, audio of video nodig.`;
      }
      if(Array.isArray(q.pointsByStage) && q.pointsByStage.length!==q.stages.length) return `Vraag ${n}: 'pointsByStage' moet even lang zijn als 'stages'.`;
    } else if(!q.question && !q.image && !q.video && !q.audio){
      return `Vraag ${n}: 'question' of media (image/video/audio) nodig.`;
    }
  }
  return null;
}

export function normStage(s){
  const o={};
  if(s.type && s.display!=null){ if(s.type==='image')o.image=s.display; else if(s.type==='audio')o.audio=s.display; else if(s.type==='video')o.video=s.display; else o.text=s.display; }
  if(s.text!=null)o.text=s.text; if(s.image!=null)o.image=s.image; if(s.audio!=null)o.audio=s.audio; if(s.video!=null)o.video=s.video;
  if(s.label!=null)o.label=s.label;
  if(s.betMultiplier!=null)o.betMultiplier=s.betMultiplier;
  return o;
}

export function normalizeQuiz(arr){
  return arr.map(q=>{
    const out = Object.assign({}, q);
    if(Array.isArray(q.stages)) out.stages = q.stages.map(normStage);
    if(typeof q.options==='string')        out.optionsMode = q.options===':tmdb'?'tmdb':q.options===':deezer'?'deezer':q.options===':text'?'text':'list';
    else if(Array.isArray(q.options))      out.optionsMode = q.search ? 'listsearch' : 'list';
    else if(['tmdb','deezer','text','listsearch'].includes(q.optionsMode)) out.optionsMode = q.optionsMode;
    else { out.optionsMode='list'; out.options = out.options||[]; }
    if(!['list','listsearch'].includes(out.optionsMode)) delete out.options;
    if(out.answer==null && q.correctIndex!=null) out.answer = q.correctIndex;
    if(Array.isArray(out.stages)){
      const muls = out.stages.map(s=>s.betMultiplier);
      if(muls.some(m=>m!=null)){ out.betting=true; out.betMultipliers = out.stages.map(s=>s.betMultiplier!=null?s.betMultiplier:1); }
      const ap = out.stages.find(s=>s.audio);
      if(ap){
        const folder = ap.audio.split('/').slice(-2,-1)[0]||'';
        const m = folder.match(/\(\s*(\d{4})\s*[_ ]\s*([\d.]+\s*[kmbKMB]?)\s*[_ ]\s*par[-_ ]*(\d+)\s*\)/);
        if(m){ if(out.year==null) out.year=+m[1]; if(out.views==null) out.views=m[2].toUpperCase().replace(/\s+/g,''); if(out.par==null) out.par=+m[3]; }
      }
    }
    if(out.answerLabel==null && ['list','listsearch'].includes(out.optionsMode) && Array.isArray(out.options) && out.options[out.answer]!=null)
      out.answerLabel = out.options[out.answer];
    if(out.optionsMode==='text' && out.answerLabel==null && out.answer!=null) out.answerLabel = String(out.answer);
    if(out.points==null) out.points = 100;
    return out;
  });
}

/* meerkeuze met shuffle-vlag: eerste optie is juist; husselt en wijst 'answer' opnieuw aan */
export function applyShuffles(quiz){
  quiz.forEach(q=>{
    if(q.shuffle && Array.isArray(q.options) && q.options.length>1){
      const correct = q.options[q.answer!=null?q.answer:0];
      for(let i=q.options.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [q.options[i],q.options[j]]=[q.options[j],q.options[i]]; }
      q.answer = q.options.indexOf(correct);
      q.answerLabel = correct;
    }
  });
  return quiz;
}

/* instrumentlabel uit een bestandsnaam, bv "1-drums+bass.m4a" → "Drums + Bass" */
export function labelFromFile(path){
  let b = path.split('/').pop().replace(/\.[^.]+$/,'');
  b = b.replace(/^\s*\d+\s*[-_.]\s*/,'');
  b = b.replace(/[-_]+/g,' ').replace(/\s*\+\s*/g,' + ').trim();
  if(!b || /^\d+$/.test(b)) return '';
  return b.split(/\s+/).map(w=> w.charAt(0).toUpperCase()+w.slice(1)).join(' ');
}

export function defaultBetMults(n){
  const t = {1:[1], 2:[2,1], 3:[3,2,1], 4:[3,2,1.5,1], 5:[3,2,1.5,1.25,1], 6:[3,2.5,2,1.5,1.25,1]};
  if(t[n]) return t[n];
  return Array.from({length:n}, (_,i)=> n<=1 ? 1 : Math.round((3 - 2*i/(n-1))*100)/100);
}

/* leesbare titel + type van een vraag-object */
export function qLabel(q){
  if(q.question) return q.question;
  if(q.answerLabel) return q.answerLabel;
  if(typeof q.answer==='string') return q.answer;
  if(Array.isArray(q.options) && q.options[q.answer]!=null) return q.options[q.answer];
  return '(vraag)';
}
export function qTypeLabel(q){
  if(q.options===':text'||q.optionsMode==='text') return 'open';
  if(q.options===':tmdb'||q.optionsMode==='tmdb') return 'film';
  if(q.options===':deezer'||q.optionsMode==='deezer') return 'lied';
  if(Array.isArray(q.stages)) return 'hints';
  return 'meerkeuze';
}

/* ============================================================
   BIBLIOTHEEK-CATALOGUS + TMDB
   ============================================================ */
const personImgCache = {};

export function itemLabel(rd, it){
  if(rd.mode===':deezer') return it.label || '';
  if(rd.mode===':tmdb')   return it.label || '';
  if(rd.mode===':text')   return it.answer || '';
  if(rd.mode==='listsearch') return it.breed || '';
  return '';
}

/* library.json + alle round.json ophalen (paden relatief t.o.v. de pagina) */
export async function loadCatalog(){
  const lib = await (await fetch('library.json', {cache:'no-cache'})).json();
  const folders = Array.isArray(lib.rounds) ? lib.rounds : [];
  const cat = [];
  for(const folder of folders){
    try{
      const rd = await (await fetch(`${folder}/round.json`, {cache:'no-cache'})).json();
      if(!rd || !rd.items) continue;
      cat.push({
        folder,
        name: rd.name || folder,
        intro: rd.intro || '',
        mode: rd.mode || '',
        betting: !!rd.betting,
        heading: rd.heading || rd.name || '',
        breeds: Array.isArray(rd.breeds) ? rd.breeds : null,
        items: rd.items,
      });
    }catch(e){ /* ontbrekende/foute ronde overslaan */ }
  }
  return cat;
}

/* acteurnaam → profielfoto-URL via de TMDB-proxy (gecachet) */
export async function actorImage(a){
  const name = typeof a==='string' ? a : (a.name||'');
  const id   = (typeof a==='object' && a.id!=null) ? a.id : null;
  if(typeof a==='object' && a.img) return a.img;
  const cacheKey = id!=null ? ('id:'+id) : ('nm:'+name);
  if(personImgCache[cacheKey]!==undefined) return personImgCache[cacheKey];
  let url = null;
  try{
    const res = await fetch(`${TMDB_PROXY}/search?type=person&query=${encodeURIComponent(name)}`, {headers:{accept:'application/json'}});
    const data = await res.json();
    const list = data.results || [];
    const person = (id!=null ? list.find(p=>p.id===id) : null) || list[0];
    if(person && person.profile_path) url = `https://image.tmdb.org/t/p/w500${person.profile_path}`;
  }catch(e){}
  personImgCache[cacheKey] = url;
  return url;
}

/* films zoeken (antwoord-zoekveld + film-bouwer) */
export async function tmdbSearch(q){
  const res = await fetch(`${TMDB_PROXY}/search?query=${encodeURIComponent(q)}`, { headers:{ accept:'application/json' } });
  const data = await res.json();
  return (data.results||[]).slice(0,8).map(m=>({
    id:m.id,
    label:m.title,
    thumb:m.poster_path?`https://image.tmdb.org/t/p/w92${m.poster_path}`:null,
  }));
}

/* cast van een film (top-N met foto) via de TMDB-proxy */
export async function movieCast(id, max=5){
  try{
    const res = await fetch(`${TMDB_PROXY}/search?type=credits&id=${encodeURIComponent(id)}`, {headers:{accept:'application/json'}});
    const data = await res.json();
    return (data.cast||[]).filter(c=>c.profile_path).slice(0,max).map(c=>({
      id:c.id, name:c.name, img:`https://image.tmdb.org/t/p/w500${c.profile_path}`,
    }));
  }catch(e){ return []; }
}

/* één bibliotheek-item → één vraag-object (zelfde schema als questions.json) */
export async function buildQuestion(rd, key, it){
  if(rd.mode===':deezer'){
    const tracks = it.tracks || [];
    const mults = defaultBetMults(tracks.length);
    return { question: rd.heading, options: ':deezer', answer: it.deezerId, answerLabel: it.label,
      stages: tracks.map((t,i)=>({ audio:`${rd.folder}/${key}/${t}`, label: labelFromFile(t) || ('Fragment '+(i+1)), betMultiplier: mults[i] })) };
  }
  if(rd.mode===':text'){
    const parts = it.parts || [];
    const mults = defaultBetMults(parts.length);
    const q = { question: rd.heading, options: ':text', answer: it.answer, accept: it.accept || [],
      stages: parts.map((p,i)=>({ image:`${rd.folder}/${key}/${p}`, betMultiplier: mults[i] })) };
    if(it.full) q.answerImage = `${rd.folder}/${key}/${it.full}`;
    return q;
  }
  if(rd.mode===':tmdb'){
    const actors = it.actors || [];
    const mults = defaultBetMults(actors.length);
    const stages = [];
    for(let i=0;i<actors.length;i++){
      const img = await actorImage(actors[i]);
      const name = typeof actors[i]==='string' ? actors[i] : (actors[i].name||'');
      stages.push(img ? { image: img, betMultiplier: mults[i] } : { text: name, betMultiplier: mults[i] });
    }
    return { question: rd.heading, options: ':tmdb', answer: it.tmdbId, answerLabel: it.label, stages };
  }
  if(rd.mode==='listsearch'){
    const breeds = rd.breeds || [];
    return { question: rd.heading, options: breeds, search: true, image:`${rd.folder}/${key}`,
      answer: breeds.indexOf(it.breed) };
  }
  return { question: rd.heading || 'Vraag', options: [], answer: 0 };
}

/* ============================================================
   OPSLAG  (per apparaat — localStorage)
   ============================================================ */
export const SAVED_KEY = 'quiz:saved:v1';       // { naam: quizObject }
export const BANK_KEY  = 'quiz:questions:v1';    // [ {bucket, label, q} ]
export const ACTIVE_KEY = 'quiz:active';         // quiz die in het spel geladen moet worden

export function loadSavedQuizzes(){ try{ return JSON.parse(localStorage.getItem(SAVED_KEY)||'{}'); }catch(e){ return {}; } }
export function saveQuizToDevice(name, quiz){
  const all = loadSavedQuizzes(); all[name] = quiz;
  try{ localStorage.setItem(SAVED_KEY, JSON.stringify(all)); return true; }catch(e){ return false; }
}
export function deleteSavedQuiz(name){
  const all = loadSavedQuizzes(); delete all[name];
  try{ localStorage.setItem(SAVED_KEY, JSON.stringify(all)); }catch(e){}
}
export function loadBank(){ try{ return JSON.parse(localStorage.getItem(BANK_KEY)||'[]'); }catch(e){ return []; } }
export function saveBank(b){ try{ localStorage.setItem(BANK_KEY, JSON.stringify(b)); return true; }catch(e){ return false; } }
export function addToBank(item){ const b=loadBank(); b.push(item); return saveBank(b); }
export function deleteBankItem(i){ const b=loadBank(); b.splice(i,1); return saveBank(b); }

/* een quiz klaarzetten om in het spel te hosten, daarna naar index.html */
export function setActiveQuiz(name, quiz){ try{ localStorage.setItem(ACTIVE_KEY, JSON.stringify({name, quiz})); }catch(e){} }
export function takeActiveQuiz(){ try{ const v=localStorage.getItem(ACTIVE_KEY); if(!v)return null; localStorage.removeItem(ACTIVE_KEY); return JSON.parse(v); }catch(e){ return null; } }

/* quiz als .json downloaden */
export function exportQuizJSON(name, quiz){
  try{
    const blob = new Blob([JSON.stringify(quiz, null, 2)], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = (name||'quiz').replace(/[^a-z0-9._-]+/gi,'_') + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=> URL.revokeObjectURL(url), 1000);
  }catch(e){ alert('Exporteren mislukt: '+e.message); }
}

export function copyText(txt, cb){
  const fallback=()=>{ const ta=document.createElement('textarea'); ta.value=txt; ta.style.position='fixed'; ta.style.opacity='0'; document.body.appendChild(ta); ta.select(); try{document.execCommand('copy');}catch(e){} ta.remove(); if(cb)cb(); };
  if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(txt).then(()=>{ if(cb)cb(); }).catch(fallback); }
  else fallback();
}
