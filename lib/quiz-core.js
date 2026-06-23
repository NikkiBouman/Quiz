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
      // inzetten is optioneel: expliciete q.bet wint; anders afleiden uit aanwezige betMultipliers
      const hasMul = out.stages.some(s=>s.betMultiplier!=null);
      const betOn = q.bet!=null ? !!q.bet : hasMul;
      if(betOn){ const dm=defaultBetMults(out.stages.length); out.betting=true; out.betMultipliers = out.stages.map((s,i)=>s.betMultiplier!=null?s.betMultiplier:dm[i]); }
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
/* het juiste antwoord van een vraag, als leesbare tekst (voor de bewerk-lijsten) */
export function answerText(q){
  if(q.answerLabel) return q.answerLabel;
  if(Array.isArray(q.options) && q.options[q.answer]!=null) return q.options[q.answer];
  if(typeof q.answer==='string') return q.answer;
  return '';
}

/* net, goed zichtbaar verwijder-icoon (wit op de rode .mini.danger-knop) */
export const ICON_TRASH = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';

/* sleep-greep (zes puntjes) — pak hier vast om te herordenen */
export const ICON_GRIP = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="display:block"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>';

/* ============================================================
   BIBLIOTHEEK-CATALOGUS + TMDB
   ============================================================ */
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

/* Snelkeuze-rooster met bekende films voor de quizmaker (alleen in de editor).
   De id's komen overeen met TMDB, zodat een keuze hier identiek aan een
   zoekresultaat verwerkt wordt. Alfabetisch getoond ("The" genegeerd). */
export const POPULAR_MOVIES = [
  { id:530915, title:'1917',                          poster:'/iZf0KyrE25z1sage4SYFLCCrMi9.jpg' },
  { id:812,    title:'Aladdin',                        poster:'/eLFfl7vS8dkeG1hKp5mwbm37V83.jpg' },
  { id:19995,  title:'Avatar',                         poster:'/wvn700u83dxVb3mryWKnNyBf7yb.jpg' },
  { id:24428,  title:'The Avengers',                   poster:'/RYMX2wcKCBAr24UyPD7xwmjaTn.jpg' },
  { id:105,    title:'Back to the Future',             poster:'/j10G3Wlz8VshXf9aky0OVdhXyvQ.jpg' },
  { id:346698, title:'Barbie',                         poster:'/tnS9DqsJvFjmg4FK4R2LghvOhs5.jpg' },
  { id:155,    title:'The Dark Knight',                poster:'/xGSOgu01djJmKGAiWgeqIfpYvs4.jpg' },
  { id:562,    title:'Die Hard',                       poster:'/26i0i7jzTBDnoX2d8ZfSp4mMaKm.jpg' },
  { id:438631, title:'Dune',                           poster:'/9FmO8i8HDbGwNJPcxwxjiAe4U4n.jpg' },
  { id:9799,   title:'Fast & Furious',                 poster:'/gqY0ITBgT7A82poL9jv851qdnIb.jpg' },
  { id:550,    title:'Fight Club',                     poster:'/kO39IEJ5SSmmBlYscXS9x2c8aXL.jpg' },
  { id:12,     title:'Finding Nemo',                   poster:'/5lc6nQc0VhWFYFbNv016xze8Jvy.jpg' },
  { id:13,     title:'Forrest Gump',                   poster:'/Cw4hIUIAmSYfK9QfaUW5igp9La.jpg' },
  { id:109445, title:'Frozen',                         poster:'/itAKcobTYGpYT8Phwjd8c9hleTo.jpg' },
  { id:316029, title:'The Greatest Showman',           poster:'/b9CeobiihCx1uG1tpw8hXmpi7nm.jpg' },
  { id:497,    title:'The Green Mile',                 poster:'/8VG8fDNiy50H4FedGwdSVUPoaJe.jpg' },
  { id:8871,   title:'The Grinch',                     poster:'/1WZbbPApEivA421gCOluuzMMKCk.jpg' },
  { id:28178,  title:'Hachi: A Dog\'s Tale',           poster:'/lsy3aEsEfYIHdLRk4dontZ4s85h.jpg' },
  { id:324786, title:'Hacksaw Ridge',                  poster:'/fTuxNlgEm04PPFkr1xfK94Jn8BW.jpg' },
  { id:671,    title:'Harry Potter',                   poster:'/8dkJn5VQjrlFesrZas6rvmdzo1C.jpg' },
  { id:10947,  title:'High School Musical',            poster:'/1DGmWZjUJPeKGFRHGCA6VPFUBML.jpg' },
  { id:49051,  title:'The Hobbit',                     poster:'/yHA9Fc37VmpUA5UncTxxo3rTGVA.jpg' },
  { id:27205,  title:'Inception',                      poster:'/xlaY2zyzMfkhk0HSC5VUwzoZPU1.jpg' },
  { id:150540, title:'Inside Out',                     poster:'/4chZQ7EofvIn5TTSijvGU3xVkJf.jpg' },
  { id:157336, title:'Interstellar',                   poster:'/yQvGrMoipbRoddT0ZR8tPoR7NfX.jpg' },
  { id:1726,   title:'Iron Man',                       poster:'/78lPtwv72eTNqFW9COBYI0dWDJa.jpg' },
  { id:578,    title:'Jaws',                           poster:'/o505Zk2OWhfOKkBXJyZOIIPtUz5.jpg' },
  { id:475557, title:'Joker',                          poster:'/udDclJoHjfjb8Ekgsd4FDteOkCU.jpg' },
  { id:329,    title:'Jurassic Park',                  poster:'/fjTU1Bgh3KJu4aatZil3sofR2zC.jpg' },
  { id:9502,   title:'Kung Fu Panda',                  poster:'/wWt4JYXTg5Wr3xBW2phBrMKgp3x.jpg' },
  { id:313369, title:'La La Land',                     poster:'/1Yat6JfH2yqOhZxTd1PJDMMkao2.jpg' },
  { id:8587,   title:'The Lion King',                  poster:'/jq3z51D9uXmc5tsFOwpbFwz4F2y.jpg' },
  { id:263115, title:'Logan',                          poster:'/fnbjcRDYn6YviCcePDnGdyAkYsB.jpg' },
  { id:120,    title:'The Lord of the Rings',          poster:'/6oom5QYQ2yQTMJIbnvbkBL9cHo6.jpg' },
  { id:603,    title:'The Matrix',                     poster:'/dXNAPwY7VrqMAo51EKhhCJfaGb5.jpg' },
  { id:585,    title:'Monsters, Inc.',                 poster:'/3mTsvFLXlfplP6aIqwvvkpHV4l.jpg' },
  { id:762,    title:'Monty Python and the Holy Grail',poster:'/h3rksLHevpCbHfSoaUXm85nt2CH.jpg' },
  { id:411,    title:'Narnia',                         poster:'/l49yq3ViFcfL4qMrXodhaR9OPy3.jpg' },
  { id:11036,  title:'The Notebook',                   poster:'/rNzQyW4f8B8cQeg7Dgj3n6eT5k9.jpg' },
  { id:75656,  title:'Now You See Me',                 poster:'/tWsNYbrqy1p1w6K9zRk0mSchztT.jpg' },
  { id:22,     title:'Pirates of the Caribbean',       poster:'/poHwCZeWzJCShH7tOjg8RIoyjcw.jpg' },
  { id:807,    title:'Se7en',                          poster:'/reNURlzywo4yMSXQjcZvirfIEOR.jpg' },
  { id:278,    title:'The Shawshank Redemption',       poster:'/aAdnwqwkKX5PPcr8EdtaiA8AZVl.jpg' },
  { id:10528,  title:'Sherlock Holmes',               poster:'/momkKuWburNTqKBF6ez7rvhYVhE.jpg' },
  { id:694,    title:'The Shining',                    poster:'/NJVFvpLqIQAJ2Olgz8rqb7Cji9.jpg' },
  { id:808,    title:'Shrek',                          poster:'/iB64vpL3dIObOtMZgX3RqdVdQDc.jpg' },
  { id:745,    title:'The Sixth Sense',                poster:'/vOyfUXNFSnaTk7Vk5AjpsKTUWsu.jpg' },
  { id:557,    title:'Spider-Man',                     poster:'/kjdJntyBeEvqm9w97QGBdxPptzj.jpg' },
  { id:11,     title:'Star Wars',                       poster:'/6FfCtAuVAW8XJjZ7eWeLibRLWTw.jpg' },
  { id:218,    title:'The Terminator',                 poster:'/qvktm0BHcnmDpul4Hz01GIazWPr.jpg' },
  { id:862,    title:'Toy Story',                      poster:'/rm7IjJeE9lITBK9Pr7es4nJkDZ9.jpg' },
  { id:402431, title:'Wicked',                         poster:'/tlwzOOCxcxtE7bXGvs3QlpmM5C0.jpg' },
  { id:36657,  title:'X-Men',                          poster:'/bRDAc4GogyS9ci3ow7UnInOcriN.jpg' },
].sort((a,b)=> a.title.replace(/^the /i,'').localeCompare(b.title.replace(/^the /i,'')));

/* Het snelkeuze-rooster als HTML. Tegels dragen de TMDB-id; de aanroeper
   bindt clicks op .pmovie (data-pid / data-plabel) aan filmPick(). */
export function popularMoviesHTML(){
  const cells = POPULAR_MOVIES.map(m=>
    `<button type="button" class="pmovie" data-pid="${m.id}" data-plabel="${esc(m.title)}">
        <img src="https://image.tmdb.org/t/p/w185${m.poster}" alt="" loading="lazy">
        <span>${esc(m.title)}</span></button>`).join('');
  return `<div class="pmovies-wrap">
    <div class="pmovies-label">of kies uit bekende films:</div>
    <div class="pmovies">${cells}</div></div>`;
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
