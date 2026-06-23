/* quiz-core.js — gedeelde, DOM-loze kern voor de quizshow.
 *
 * Gebruikt door:
 *   - index.html             (het spel: laadt/normaliseert vragensets, speler-zoekopdrachten)
 *   - account/quizzes/       (de quiz-editor/-beheerder)
 *   - account/questions/     (de persoonlijke vragenbank)
 *   - lib/editor-ui.js       (de gedeelde beheer-UI van die twee pagina's)
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
    const apiOpts = typeof q.options==='string' && [':tmdb',':deezer',':deezer-album',':deezer-artist'].includes(q.options);
    const textOpts = q.options===':text' || q.options===':deezer-title';   // titel-zoek matcht op tekst
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
    } else if(!q.question && !q.image && !q.video && !q.audio && !(Array.isArray(q.facts)&&q.facts.length)){
      return `Vraag ${n}: 'question', info of media (image/video/audio) nodig.`;
    }
  }
  return null;
}

export function normStage(s){
  const o={};
  if(s.type && s.display!=null){ if(s.type==='image')o.image=s.display; else if(s.type==='audio')o.audio=s.display; else if(s.type==='video')o.video=s.display; else o.text=s.display; }
  if(s.text!=null)o.text=s.text; if(s.image!=null)o.image=s.image; if(s.audio!=null)o.audio=s.audio; if(s.video!=null)o.video=s.video;
  if(s.label!=null)o.label=s.label;
  if(s.previewLabel!=null)o.previewLabel=s.previewLabel;   // categorie voor de 'Hints die je gaat krijgen'-lijst (geen spoiler)
  if(s.betMultiplier!=null)o.betMultiplier=s.betMultiplier;
  if(s.clipStart!=null)o.clipStart=s.clipStart; if(s.clipEnd!=null)o.clipEnd=s.clipEnd;  // audio-fragment afspelen van … tot …
  return o;
}

export function normalizeQuiz(arr){
  return arr.map(q=>{
    const out = Object.assign({}, q);
    if(Array.isArray(q.stages)){
      out.stages = q.stages.map(normStage);
      backfillPreviewLabels(out.stages, q.source);   // oudere vragen (vóór previewLabel): categorie uit de clue-pool halen
    }
    if(typeof q.options==='string')        out.optionsMode = q.options===':tmdb'?'tmdb':q.options===':deezer'?'deezer':q.options===':deezer-title'?'deezertitle':q.options===':deezer-album'?'deezeralbum':q.options===':deezer-artist'?'deezerartist':q.options===':text'?'text':'list';
    else if(Array.isArray(q.options))      out.optionsMode = q.search ? 'listsearch' : 'list';
    else if(['tmdb','deezer','deezertitle','deezeralbum','deezerartist','text','listsearch'].includes(q.optionsMode)) out.optionsMode = q.optionsMode;
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
      const arr = Array.isArray(q.answer);                                  // meerdere juiste opties
      const correctVals = arr ? q.answer.map(i=>q.options[i]) : [q.options[q.answer!=null?q.answer:0]];
      for(let i=q.options.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [q.options[i],q.options[j]]=[q.options[j],q.options[i]]; }
      if(arr){ q.answer = correctVals.map(v=>q.options.indexOf(v)).sort((a,b)=>a-b); }
      else { q.answer = q.options.indexOf(correctVals[0]); q.answerLabel = correctVals[0]; }
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
  if(q.source && q.source.kind==='tmdb') return 'film';    // bron-bewust: ook als het antwoord een feit (jaar/genre) is
  if(q.source && q.source.kind==='deezer') return 'lied';
  if(q.audio && (q.clipStart!=null||q.clipEnd!=null)) return 'lied';   // geclipt audiofragment = liedjesvraag (ook bij open antwoord)
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

/* gedeeld hamburgermenu (homepagina + beheer-lijstpagina's). `active` = 'home'|'quizzes'|'questions'
   markeert de huidige pagina; `base` is het pad-voorvoegsel naar de repo-root ('' op index.html,
   '../../' op de account-lijstpagina's). Het <details>-element opent/sluit native, geen JS nodig. */
export function navMenuHTML(active, base){
  base = base || '';
  const items = [
    { key:'home',      href:`${base}index.html`,        label:'🏠 Home' },
    { key:'quizzes',   href:`${base}account/quizzes/`,   label:'📚 Mijn quizzen' },
    { key:'questions', href:`${base}account/questions/`, label:'✏️ Mijn vragen' },
  ];
  const links = items.map(it=> it.key===active
    ? `<a class="active" aria-current="page">${it.label}</a>`
    : `<a href="${esc(it.href)}">${it.label}</a>`).join('');
  return `<details class="hmenu">
      <summary aria-label="Menu"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/></svg></summary>
      <div class="hmenu-list">${links}</div>
    </details>`;
}

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

/* repo-root t.o.v. deze module (…/lib/quiz-core.js → …/). Zo lossen de catalogus-fetches
   op t.o.v. de root i.p.v. de pagina, en werken ze óók vanuit submappen (/account/quizzes/).
   Base-path-veilig op GitHub Pages: import.meta.url bevat al de /Quiz/-prefix. */
export const ROOT = new URL('../', import.meta.url);

/* library.json + alle round.json ophalen (paden t.o.v. de repo-root, zie ROOT) */
export async function loadCatalog(){
  const lib = await (await fetch(new URL('library.json', ROOT), {cache:'no-cache'})).json();
  const folders = Array.isArray(lib.rounds) ? lib.rounds : [];
  const cat = [];
  for(const folder of folders){
    try{
      const rd = await (await fetch(new URL(`${folder}/round.json`, ROOT), {cache:'no-cache'})).json();
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

/* volledige filmdetails (genre/jaar/rating/speelduur + regisseur/componist + cast) in één
   call via de proxy (type=details → /movie/{id}?append_to_response=credits). Bron voor de
   info-feiten én de acteur-hints van de film-bouwer. */
export async function movieDetails(id){
  try{
    const res = await fetch(`${TMDB_PROXY}/search?type=details&id=${encodeURIComponent(id)}`, {headers:{accept:'application/json'}});
    const d = await res.json();
    if(!d || d.error || !d.id) return null;
    const crew = (d.credits && d.credits.crew) || [];
    // crew-rol → één persoon {name, img}: namen samengevoegd, eerste beschikbare foto
    const person = wanted => {
      const out=[], seen=new Set();
      for(const cm of crew){ if(wanted.includes(cm.job) && cm.name && !seen.has(cm.name)){ seen.add(cm.name); out.push({ name:cm.name, img:cm.profile_path?`https://image.tmdb.org/t/p/w500${cm.profile_path}`:'' }); } }
      return out.length ? { name: out.map(p=>p.name).join(', '), img: (out.find(p=>p.img)||{}).img||'' } : null;
    };
    const cast = ((d.credits && d.credits.cast) || []).filter(c=>c.profile_path).slice(0,10)
      .map(c=>({ id:c.id, name:c.name, img:`https://image.tmdb.org/t/p/w500${c.profile_path}` }));
    return {
      id: d.id,
      title: d.title || d.original_title || '',
      year: (d.release_date||'').slice(0,4),
      genres: (d.genres||[]).map(g=>g.name),
      director: person(['Director']),
      composer: person(['Original Music Composer','Music','Composer']),
      rating: d.vote_average ? String(Math.round(d.vote_average*10)/10) : '',
      runtime: d.runtime ? `${d.runtime} min` : '',
      poster: d.poster_path ? `https://image.tmdb.org/t/p/w500${d.poster_path}` : null,
      cast,
    };
  }catch(e){ return null; }
}

/* één track volledig ophalen (artiest/album/jaar) via Deezer JSONP — bron voor liedjes-feiten */
export function deezerTrack(id){
  return new Promise(resolve=>{
    const cb='dz_'+Math.random().toString(36).slice(2,9);
    const s=document.createElement('script');
    const done=v=>{ try{ delete window[cb]; }catch(e){} s.remove(); resolve(v); };
    window[cb]=t=>{
      if(!t || t.error){ done(null); return; }
      const yr=(t.release_date||(t.album&&t.album.release_date)||'').slice(0,4);
      done({ title:t.title||'',
             artist:(t.artist&&t.artist.name)||'', artistId:(t.artist&&t.artist.id)||null,
             album:(t.album&&t.album.title)||'', albumId:(t.album&&t.album.id)||null,
             year:/^\d{4}$/.test(yr)?yr:'' });
    };
    s.onerror=()=>done(null);
    s.src=`https://api.deezer.com/track/${encodeURIComponent(id)}?output=jsonp&callback=${cb}`;
    document.body.appendChild(s);
  });
}

/* Deezer-zoeken via JSONP (geen CORS, geen key). Elke track levert een
   'preview': een ~30s MP3-fragment op Deezer's CDN dat je vrij mag afspelen.
   Die preview is de bron voor liedjesvragen (host-only afgespeeld, evt. geclipt). */
export function deezerSearch(q){
  return new Promise(resolve=>{
    const cb='dz_'+Math.random().toString(36).slice(2,9);
    const s=document.createElement('script');
    const done=items=>{ try{ delete window[cb]; }catch(e){} s.remove(); resolve(items); };
    window[cb]=data=>done((data&&data.data?data.data:[]).slice(0,8).map(t=>({
      id:t.id, label:`${t.artist?t.artist.name+' – ':''}${t.title}`,
      thumb:t.album&&t.album.cover_small?t.album.cover_small:null,
      preview:t.preview||'',
    })));
    s.onerror=()=>done([]);
    s.src=`https://api.deezer.com/search?q=${encodeURIComponent(q)}&output=jsonp&callback=${cb}&limit=8`;
    document.body.appendChild(s);
  });
}

/* Snelkeuze-rooster met bekende films voor de quizmaker (alleen in de editor).
   De id's komen overeen met TMDB, zodat een keuze hier identiek aan een
   zoekresultaat verwerkt wordt. Alfabetisch getoond ("The" genegeerd). */
export const POPULAR_MOVIES = [
  { id:530915, title:'1917',                           poster:'/iZf0KyrE25z1sage4SYFLCCrMi9.jpg' },
  { id:447332, title:'A Quiet Place',                  poster:'/nAU74GmpUk7t5iklEp3bufwDq4n.jpg' },
  { id:812,    title:'Aladdin',                        poster:'/eLFfl7vS8dkeG1hKp5mwbm37V83.jpg' },
  { id:12155,  title:'Alice in Wonderland',            poster:'/o0kre9wRCZz3jjSjaru7QU0UtFz.jpg' },
  { id:15739,  title:'Annie',                          poster:'/xopqD99S1GqQOG8UAeSElsX9MeP.jpg' },
  { id:19995,  title:'Avatar',                         poster:'/wvn700u83dxVb3mryWKnNyBf7yb.jpg' },
  { id:24428,  title:'The Avengers',                   poster:'/RYMX2wcKCBAr24UyPD7xwmjaTn.jpg' },
  { id:299534, title:'Avengers: Endgame',              poster:'/stguLTUPp0d0dCsP7Q4qhV7uONV.jpg' },
  { id:105,    title:'Back to the Future',             poster:'/j10G3Wlz8VshXf9aky0OVdhXyvQ.jpg' },
  { id:346698, title:'Barbie',                         poster:'/tnS9DqsJvFjmg4FK4R2LghvOhs5.jpg' },
  { id:424694, title:'Bohemian Rhapsody',              poster:'/lHu1wtNaczFPGFDTrjCSzeLPTKN.jpg' },
  { id:10009,  title:'Brother Bear',                   poster:'/3X4AdIFWlbs3MdP1jjCGuBld0vQ.jpg' },
  { id:920,    title:'Cars',                           poster:'/oloVyeBbkVGbFFaUjR8I7Boo7wA.jpg' },
  { id:11362,  title:'The Count of Monte Cristo',      poster:'/ifMgDAUXVQLY4DeOu3VTTi55jSP.jpg' },
  { id:155,    title:'The Dark Knight',                poster:'/xGSOgu01djJmKGAiWgeqIfpYvs4.jpg' },
  { id:293660, title:'Deadpool',                       poster:'/jnaahY4s4ThMpCzBE6u0ZXAN8Xy.jpg' },
  { id:20352,  title:'Despicable Me',                  poster:'/tYOWiBdVQRXfni99p2rEyepGZdk.jpg' },
  { id:562,    title:'Die Hard',                       poster:'/26i0i7jzTBDnoX2d8ZfSp4mMaKm.jpg' },
  { id:88,     title:'Dirty Dancing',                  poster:'/9Jw6jys7q9gjzVX5zm1z0gC8gY9.jpg' },
  { id:68718,  title:'Django Unchained',               poster:'/7oWY8VDWW7thTzWh3OKYRkWUlD5.jpg' },
  { id:284052, title:'Doctor Strange',                 poster:'/xf8PbyQcR5ucXErmZNzdKR0s8ya.jpg' },
  { id:438631, title:'Dune',                           poster:'/9FmO8i8HDbGwNJPcxwxjiAe4U4n.jpg' },
  { id:601,    title:'E.T. the Extra-Terrestrial',     poster:'/an0nD6uq6byfxXCfk6lQBzdL2J1.jpg' },
  { id:162,    title:'Edward Scissorhands',            poster:'/e0FqKFvGPdQNWG8tF9cZBtev9Em.jpg' },
  { id:9799,   title:'Fast & Furious',                 poster:'/gqY0ITBgT7A82poL9jv851qdnIb.jpg' },
  { id:550,    title:'Fight Club',                     poster:'/kO39IEJ5SSmmBlYscXS9x2c8aXL.jpg' },
  { id:12,     title:'Finding Nemo',                   poster:'/5lc6nQc0VhWFYFbNv016xze8Jvy.jpg' },
  { id:359724, title:'Ford v Ferrari',                 poster:'/dR1Ju50iudrOh3YgfwkAU1g2HZe.jpg' },
  { id:13,     title:'Forrest Gump',                   poster:'/Cw4hIUIAmSYfK9QfaUW5igp9La.jpg' },
  { id:109445, title:'Frozen',                         poster:'/itAKcobTYGpYT8Phwjd8c9hleTo.jpg' },
  { id:620,    title:'Ghostbusters',                   poster:'/7E8nLijS9AwwUEPu2oFYOVKhdFA.jpg' },
  { id:9340,   title:'The Goonies',                    poster:'/eBU7gCjTCj9n2LTxvCSIXXOvHkD.jpg' },
  { id:621,    title:'Grease',                         poster:'/2rM7fQKpb7cs1Iq7IBqub9LFDzJ.jpg' },
  { id:316029, title:'The Greatest Showman',           poster:'/b9CeobiihCx1uG1tpw8hXmpi7nm.jpg' },
  { id:497,    title:'The Green Mile',                 poster:'/8VG8fDNiy50H4FedGwdSVUPoaJe.jpg' },
  { id:8871,   title:'The Grinch',                     poster:'/1WZbbPApEivA421gCOluuzMMKCk.jpg' },
  { id:118340, title:'Guardians of the Galaxy',        poster:'/r7vmZjiyZw9rpJMQJdXpjgiCOk9.jpg' },
  { id:28178,  title:'Hachi: A Dog\'s Tale',           poster:'/lsy3aEsEfYIHdLRk4dontZ4s85h.jpg' },
  { id:324786, title:'Hacksaw Ridge',                  poster:'/fTuxNlgEm04PPFkr1xfK94Jn8BW.jpg' },
  { id:2976,   title:'Hairspray',                      poster:'/fgMka3HtFvI5OgW1eYdR9XpySxH.jpg' },
  { id:18126,  title:'Hannah Montana: The Movie',      poster:'/nZUKhfpUCFfTy24LGBHdDlK5RLx.jpg' },
  { id:671,    title:'Harry Potter',                   poster:'/8dkJn5VQjrlFesrZas6rvmdzo1C.jpg' },
  { id:10947,  title:'High School Musical',            poster:'/1DGmWZjUJPeKGFRHGCA6VPFUBML.jpg' },
  { id:49051,  title:'The Hobbit',                     poster:'/yHA9Fc37VmpUA5UncTxxo3rTGVA.jpg' },
  { id:771,    title:'Home Alone',                     poster:'/onTSipZ8R3bliBdKfPtsDuHTdlL.jpg' },
  { id:10191,  title:'How to Train Your Dragon',       poster:'/7Sv9PazBT8i7OQLJq4JXGCOhnQs.jpg' },
  { id:70160,  title:'The Hunger Games',               poster:'/yXCbOiVDCxO71zI7cuwBRXdftq8.jpg' },
  { id:6479,   title:'I Am Legend',                    poster:'/iPDkaSdKk2jRLTM65UOEoKtsIZ8.jpg' },
  { id:425,    title:'Ice Age',                        poster:'/gLhHHZUzeseRXShoDyC4VqLgsNv.jpg' },
  { id:27205,  title:'Inception',                      poster:'/xlaY2zyzMfkhk0HSC5VUwzoZPU1.jpg' },
  { id:9806,   title:'The Incredibles',                poster:'/2LqaLgk4Z226KkgPJuiOQ58wvrm.jpg' },
  { id:85,     title:'Indiana Jones',                  poster:'/ceG9VzoRAVGwivFU403Wc3AHRys.jpg' },
  { id:150540, title:'Inside Out',                     poster:'/4chZQ7EofvIn5TTSijvGU3xVkJf.jpg' },
  { id:157336, title:'Interstellar',                   poster:'/yQvGrMoipbRoddT0ZR8tPoR7NfX.jpg' },
  { id:1726,   title:'Iron Man',                       poster:'/78lPtwv72eTNqFW9COBYI0dWDJa.jpg' },
  { id:578,    title:'Jaws',                           poster:'/o505Zk2OWhfOKkBXJyZOIIPtUz5.jpg' },
  { id:475557, title:'Joker',                          poster:'/udDclJoHjfjb8Ekgsd4FDteOkCU.jpg' },
  { id:8844,   title:'Jumanji',                        poster:'/iWV47r6kFneCiApgrMII5HSkfHw.jpg' },
  { id:353486, title:'Jumanji: Welcome to the Jungle', poster:'/pSgXKPU5h6U89ipF7HBYajvYt7j.jpg' },
  { id:9325,   title:'The Jungle Book',                poster:'/z4PpWVJmLtwuRo9f2qeB8aIfts4.jpg' },
  { id:329,    title:'Jurassic Park',                  poster:'/fjTU1Bgh3KJu4aatZil3sofR2zC.jpg' },
  { id:207703, title:'Kingsman: The Secret Service',   poster:'/r6q9wZK5a2K51KFj4LWVID6Ja1r.jpg' },
  { id:9502,   title:'Kung Fu Panda',                  poster:'/wWt4JYXTg5Wr3xBW2phBrMKgp3x.jpg' },
  { id:313369, title:'La La Land',                     poster:'/1Yat6JfH2yqOhZxTd1PJDMMkao2.jpg' },
  { id:8587,   title:'The Lion King',                  poster:'/jq3z51D9uXmc5tsFOwpbFwz4F2y.jpg' },
  { id:10144,  title:'The Little Mermaid',             poster:'/h4gPmS5xNqY50nSflesfpYsV0O8.jpg' },
  { id:263115, title:'Logan',                          poster:'/fnbjcRDYn6YviCcePDnGdyAkYsB.jpg' },
  { id:120,    title:'The Lord of the Rings',          poster:'/6oom5QYQ2yQTMJIbnvbkBL9cHo6.jpg' },
  { id:508,    title:'Love Actually',                  poster:'/8aKiIdxGmdxv6QLzYam1HQtubpD.jpg' },
  { id:953,    title:'Madagascar',                     poster:'/zMpJY5CJKUufG9OTw0In4eAFqPX.jpg' },
  { id:11631,  title:'Mamma Mia!',                     poster:'/zdUA4FNHbXPadzVOJiU0Rgn6cHR.jpg' },
  { id:14306,  title:'Marley & Me',                    poster:'/pnB6hjTKylb0Ve2nUWt16gzkErr.jpg' },
  { id:603,    title:'The Matrix',                     poster:'/dXNAPwY7VrqMAo51EKhhCJfaGb5.jpg' },
  { id:198663, title:'The Maze Runner',                poster:'/ode14q7WtDugFDp78fo9lCsmay9.jpg' },
  { id:607,    title:'Men in Black',                   poster:'/uLOmOF5IzWoyrgIF5MfUnh5pa1X.jpg' },
  { id:954,    title:'Mission: Impossible',            poster:'/l5uxY5m5OInWpcExIpKG6AR3rgL.jpg' },
  { id:277834, title:'Moana',                          poster:'/xqGSb55hO3mbGsbgVlcEMiR8xOw.jpg' },
  { id:585,    title:'Monsters, Inc.',                 poster:'/3mTsvFLXlfplP6aIqwvvkpHV4l.jpg' },
  { id:762,    title:'Monty Python and the Holy Grail',poster:'/h3rksLHevpCbHfSoaUXm85nt2CH.jpg' },
  { id:411,    title:'Narnia',                         poster:'/l49yq3ViFcfL4qMrXodhaR9OPy3.jpg' },
  { id:11036,  title:'The Notebook',                   poster:'/rNzQyW4f8B8cQeg7Dgj3n6eT5k9.jpg' },
  { id:75656,  title:'Now You See Me',                 poster:'/tWsNYbrqy1p1w6K9zRk0mSchztT.jpg' },
  { id:872585, title:'Oppenheimer',                    poster:'/jtTHxuJhuZpFAnCI4vGjg1LGmpY.jpg' },
  { id:22,     title:'Pirates of the Caribbean',       poster:'/poHwCZeWzJCShH7tOjg8RIoyjcw.jpg' },
  { id:114150, title:'Pitch Perfect',                  poster:'/gsFoJk9g8W3zgaipRrrURk7LbiF.jpg' },
  { id:1366,   title:'Rocky',                          poster:'/aYtBYWqCdUqcnoodWJdcTG3pFev.jpg' },
  { id:424,    title:'Schindler\'s List',              poster:'/sF1U4EUQS8YHUYjNl3pMGNIQyr0.jpg' },
  { id:807,    title:'Se7en',                          poster:'/reNURlzywo4yMSXQjcZvirfIEOR.jpg' },
  { id:278,    title:'The Shawshank Redemption',       poster:'/aAdnwqwkKX5PPcr8EdtaiA8AZVl.jpg' },
  { id:10528,  title:'Sherlock Holmes',                poster:'/momkKuWburNTqKBF6ez7rvhYVhE.jpg' },
  { id:694,    title:'The Shining',                    poster:'/NJVFvpLqIQAJ2Olgz8rqb7Cji9.jpg' },
  { id:808,    title:'Shrek',                          poster:'/iB64vpL3dIObOtMZgX3RqdVdQDc.jpg' },
  { id:745,    title:'The Sixth Sense',                poster:'/vOyfUXNFSnaTk7Vk5AjpsKTUWsu.jpg' },
  { id:37799,  title:'The Social Network',             poster:'/n0ybibhJtQ5icDqTp8eRytcIHJx.jpg' },
  { id:557,    title:'Spider-Man',                     poster:'/kjdJntyBeEvqm9w97QGBdxPptzj.jpg' },
  { id:11,     title:'Star Wars',                      poster:'/6FfCtAuVAW8XJjZ7eWeLibRLWTw.jpg' },
  { id:38757,  title:'Tangled',                        poster:'/fLebEs6fL787uhLuMwKZ1aw1VEV.jpg' },
  { id:37135,  title:'Tarzan',                         poster:'/bTvHlcqiOjGa3lFtbrTLTM3zasY.jpg' },
  { id:218,    title:'The Terminator',                 poster:'/qvktm0BHcnmDpul4Hz01GIazWPr.jpg' },
  { id:10195,  title:'Thor',                           poster:'/prSfAi1xGrhLQNxVSUFh61xQ4Qy.jpg' },
  { id:597,    title:'Titanic',                        poster:'/9xjZS2rlVxm8SFx8kPC3aIGCOYQ.jpg' },
  { id:862,    title:'Toy Story',                      poster:'/rm7IjJeE9lITBK9Pr7es4nJkDZ9.jpg' },
  { id:8966,   title:'Twilight',                       poster:'/3Gkb6jm6962ADUPaCBqzz9CTbn9.jpg' },
  { id:402431, title:'Wicked',                         poster:'/tlwzOOCxcxtE7bXGvs3QlpmM5C0.jpg' },
  { id:36657,  title:'X-Men',                          poster:'/bRDAc4GogyS9ci3ow7UnInOcriN.jpg' },
  { id:19908,  title:'Zombieland',                     poster:'/dUkAmAyPVqubSBNRjRqCgHggZcK.jpg' },
  { id:269149, title:'Zootopia',                       poster:'/kYi7ZzUDhHQeGsvIjKQw1OhIxWC.jpg' },
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
   MEDIA-VRAAG BOUWER  (film/liedje: bron → vraag → info → hints → antwoord)
   ------------------------------------------------------------
   Eén patroon voor film én liedje. Een "pick" (S.filmPick/S.songPick) draagt een
   pool van CLUES (acteurs + feiten). Elke clue zit in één zone:
     - 'info'  → altijd zichtbaar als subkop (q.facts)
     - 'hint'  → één voor één onthuld (q.stages, op volgorde)
     - 'off'   → niet gebruikt
   Het antwoord-veld valt automatisch uit de pool. Acteurs tonen standaard naam + foto;
   beide los uit te vinken. Bij liedjes is het fragment altijd de eerste hint.
   ============================================================ */

/* feiten-pool uit volledige filmdetails / track */
/* platte tekst-feiten (regisseur/componist zijn personen, zie newFilmPick) */
export function movieFacts(d){
  const f=[];
  if(d.year)               f.push({key:'year',    label:'Jaar',       value:String(d.year)});
  if(d.genres&&d.genres.length) f.push({key:'genre', label:'Genre',   value:d.genres.join(', ')});
  if(d.rating)             f.push({key:'rating',  label:'TMDB-score', value:d.rating});
  if(d.runtime)            f.push({key:'runtime', label:'Speelduur',  value:d.runtime});
  return f;
}
export function songFacts(t){
  const f=[];
  if(t.artist) f.push({key:'artist', label:'Artiest', value:t.artist});
  if(t.album)  f.push({key:'album',  label:'Album',   value:t.album});
  if(t.year)   f.push({key:'year',   label:'Jaar',    value:String(t.year)});
  return f;
}

/* info-subkop (tekst-pillen, foto/video, of host-only audio) — ook ingebakken in index.html (game).
   isHost=false verbergt de audio-bron (audio speelt alleen op het hostscherm). */
export function factsHTML(facts, isHost){
  if(!Array.isArray(facts)||!facts.length) return '';
  const cap=f=> f.label?`<span>${esc(f.label)}</span>`:'';
  const cells=facts.map(f=>{
    // afbeelding/video zónder label = hoofdbeeld → groot; mét label = klein context-fotootje
    if(f.image) return f.label
      ? `<span class="factimg"><img src="${esc(f.image)}" alt="">${cap(f)}</span>`
      : `<div class="factmain"><img class="qimg" src="${esc(f.image)}" alt=""></div>`;
    if(f.video) return f.label
      ? `<span class="factimg"><video class="qimg" controls preload="metadata" playsinline src="${esc(f.video)}"></video>${cap(f)}</span>`
      : `<div class="factmain"><video class="qimg" controls preload="metadata" playsinline src="${esc(f.video)}"></video></div>`;
    if(f.audio) return isHost
      ? `<span class="factimg"><audio class="qaudio" controls preload="none" src="${esc(f.audio)}"></audio>${cap(f)}</span>`
      : `<span class="pill">🔊 ${f.label?esc(f.label):'audio'}</span>`;
    return `<span class="pill">${f.label?esc(f.label)+': ':''}${esc(f.value)}</span>`;
  }).join('');
  return `<div class="factsrow">${cells}</div>`;
}

/* ---------- pick-objecten (verse film/liedje, of teruggelezen uit een opgeslagen vraag) ---------- */
/* persoon-clue (acteur/regisseur/componist): naam + optionele foto, los aan/uit te vinken.
   key = id; voor regisseur/componist is dat 'director'/'composer' (zo kunnen die ook het antwoord zijn). */
function personClue(id, role, name, img){ return { id, kind:'person', key:id, role, name:name||'', img:img||'', showName:true, showPhoto:!!img, showRole:false, zone:'off' }; }
function factClue(f){ return { id:'f:'+f.key, kind:'fact', key:f.key, label:f.label, value:f.value, zone:'off' }; }
/* afbeelding-clue (poster/hoes): sleepbaar naar Info of Hints — nooit het antwoord */
function imageClue(id, role, img){ return { id, kind:'image', key:id, role, img:img||'', zone:'off' }; }

/* titel-clue: doorzoekbaar (apiId = film-/track-id, searchMode = :tmdb / :deezer). Start in de pool,
   net als de rest — sleep 'm naar Antwoord (of Info/Hints). */
function titleClue(value, apiId, searchMode){ return { id:'title', kind:'title', key:'title', role:'Titel', value:value||'', apiId:apiId??null, searchMode, zone:'off' }; }
/* feit dat óók via de API doorzoekbaar is (album/artiest bij liedjes) */
function searchFactClue(key, label, value, apiId, searchMode){ return { id:'f:'+key, kind:'fact', key, label, value, apiId:apiId||null, searchMode:apiId?searchMode:null, zone:'off' }; }
/* zelf-getypt stukje (via de "+"-knop) — sleepbaar naar Info/Hints/Antwoord. Eén veld:
   bij type 'text' is value de tekst, anders is value de directe medialink (afbeelding/video/audio). */
export function newCustomClue(zone){ return { id:'custom:'+Math.random().toString(36).slice(2,7), kind:'custom', role:'Eigen', value:'', mediaType:'text', zone:zone||'off' }; }

export function newFilmPick(d){
  const clues=[ titleClue(d.title, d.id, ':tmdb') ];                                       // titel (in de pool, sleep naar Antwoord)
  if(d.poster) clues.push(imageClue('poster','Poster', d.poster));                         // poster: sleep naar Info/Hints
  movieFacts(d).forEach(f=> clues.push(factClue(f)));                                      // jaar, genre, rating, speelduur
  if(d.director) clues.push(personClue('director','Regisseur', d.director.name, d.director.img));
  if(d.composer) clues.push(personClue('composer','Componist', d.composer.name, d.composer.img));
  (d.cast||[]).forEach(a=> clues.push(personClue('a:'+a.id, 'Acteur', a.name, a.img)));    // acteurs in credits-volgorde
  return { kind:'film', tmdbId:d.id, deezerId:null, label:d.title, poster:d.poster||null,
           clues, prompt:'Welke film?', answerSearch:true };
}
function fragmentClue(preview){ return { id:'fragment', kind:'audio', key:'fragment', role:'Fragment', preview:preview||'', start:0, end:30, zone:'off' }; }
export function newSongPick(t, det){
  det=det||{};
  const clues=[ titleClue(det.title||t.label, t.id, ':deezer'), fragmentClue(t.preview) ];
  if(t.thumb) clues.push(imageClue('cover','Hoes', t.thumb));                              // albumhoes: sleep naar Info/Hints
  if(det.artist) clues.push(searchFactClue('artist','Artiest', det.artist, det.artistId, ':deezer-artist'));
  if(det.album)  clues.push(searchFactClue('album','Album',   det.album,  det.albumId,  ':deezer-album'));
  if(det.year)   clues.push(factClue({key:'year',label:'Jaar',value:String(det.year)}));
  return { kind:'song', deezerId:t.id, tmdbId:null, label:t.label, preview:t.preview||'', cover:t.thumb||'',
           clues, prompt:'Welk nummer is dit?', answerSearch:true };
}

function songClip(q){
  if(Array.isArray(q.stages)){ const a=q.stages.find(s=>s.audio); if(a) return { start:a.clipStart??0, end:a.clipEnd??'' }; }
  return { start:q.clipStart??0, end:q.clipEnd??'' };
}
/* oude vraag (zonder q.source.clues) → een clue-pool reconstrueren */
function legacyClues(q, isFilm){
  const clues=[];
  if(q.options===':tmdb'||q.options===':deezer'||q.options===':deezer-album'||q.options===':deezer-artist'){
    clues.push({ id:'title', kind:'title', key:'title', role:'Titel', value:q.answerLabel||'', apiId:q.answer, searchMode:q.options, zone:'answer' });
  } else if(q.options===':text'){
    clues.push({ id:'custom:ans', kind:'custom', role:'Eigen', value:String(q.answer!=null?q.answer:(q.answerLabel||'')), zone:'answer' });
  }
  if(isFilm){
    (q.stages||[]).filter(s=>s.image).forEach((s,i)=> clues.push({ id:'a:'+i, kind:'person', key:'a:'+i, role:'Acteur', name:s.label||'', img:s.image, showName:!!s.label, showPhoto:true, showRole:false, zone:'hint' }));
  } else {
    const aud=(Array.isArray(q.stages)?(q.stages.find(s=>s.audio)||{}).audio:q.audio)||'';
    if(aud){ const c=songClip(q); clues.push({ id:'fragment', kind:'audio', key:'fragment', role:'Fragment', preview:aud, start:c.start, end:c.end, zone:'hint' }); }
  }
  return clues;
}
/* een opgeslagen film/lied-vraag terug in een bewerkbare pick (lossless via q.source.clues) */
export function pickFromQuestion(q){
  const src=q.source||{};
  const isFilm = src.kind==='tmdb' || (src.kind==null && q.options===':tmdb');
  const p = isFilm
    ? { kind:'film', tmdbId:src.id??(q.options===':tmdb'?q.answer:null), deezerId:null, label:src.label||q.answerLabel||'', poster:q.answerImage||src.poster||null }
    : { kind:'song', deezerId:src.id??(q.options===':deezer'?q.answer:null), tmdbId:null, label:src.label||q.answerLabel||'', cover:src.cover||'', preview:(Array.isArray(q.stages)?(q.stages.find(s=>s.audio)||{}).audio:q.audio)||src.preview||'' };
  p.clues = (Array.isArray(src.clues) && src.clues.length) ? src.clues.map(c=>({...c})) : legacyClues(q, isFilm);
  if(!p.clues.some(c=>c.kind==='image')){                          // oudere vragen: poster/hoes alsnog sleepbaar maken
    if(isFilm && p.poster) p.clues.push(imageClue('poster','Poster', p.poster));
    else if(!isFilm && p.cover) p.clues.push(imageClue('cover','Hoes', p.cover));
  }
  p.prompt = q.question || (isFilm?'Welke film?':'Welk nummer is dit?');
  p.answerSearch = q.options!=null && q.options!==':text';   // api-modus = zoeken stond aan
  return p;
}

/* ---------- pick → vraag-object ---------- */
function cluesIn(clues, zone){ return (clues||[]).filter(c=> c.zone===zone); }
function isSearchable(c){ return c && (c.kind==='title' || ((c.key==='artist'||c.key==='album') && c.apiId!=null)); }
/* welke API-zoekmodus hoort bij de stukjes in de Antwoord-zone? (afgeleid van de combinatie)
   → { mode, desc } of null als er niet gezocht kan worden. */
function answerSearchMode(p){
  const ans=cluesIn(p.clues,'answer');
  const has=k=>ans.find(c=>c.key===k);
  if(p.kind==='film'){
    if(ans.length===1 && has('title') && has('title').apiId!=null) return { mode:':tmdb', desc:'de film (TMDB)' };
    return null;
  }
  if(ans.length===1 && has('title'))                       return { mode:':deezer-title',  desc:'op titel (Deezer)' };
  if(ans.length===1 && has('artist') && has('artist').apiId!=null) return { mode:':deezer-artist', desc:'op artiest (Deezer)' };
  if(ans.length===1 && has('album')  && has('album').apiId!=null)  return { mode:':deezer-album',  desc:'op album (Deezer)' };
  if(ans.length===2 && has('title') && has('artist'))      return { mode:':deezer',        desc:'het nummer: titel + artiest (Deezer)' };
  return null;
}
function clueAnswerText(c){ return c.kind==='person' ? (c.name||'') : (c.value||''); }
/* directe medialink van een custom-stukje, of null bij tekst/geen link. De waarde (value) ís de
   link. "alleen directe bestanden" — een .jpg/.mp4/.mp3-URL, geen YouTube/Spotify-embed. */
function customMedia(c){
  const t=c.mediaType||'text', url=(c.value||'').trim();
  if(t==='text' || !url) return null;
  return { type:t, url };       // type ∈ image|video|audio
}
/* tekst-deel van een persoon: naam en/of rol, naar keuze (foto wordt apart afgehandeld) */
function personParts(c){
  const p=[];
  if(c.showName && c.name) p.push(c.name);
  if(c.showRole && c.role) p.push(c.role);
  return p;
}
function clueToFact(c){     // info-subkop
  if(c.kind==='fact')   return { label:c.label, value:c.value };
  if(c.kind==='custom'){ const m=customMedia(c);                  // tekst-pil, of een directe media-link
    if(m){ const o={}; o[m.type]=m.url; return o; }
    return { value:c.value }; }
  if(c.kind==='title')  return { value:c.value };
  if(c.kind==='image')  return { image:c.img };          // poster/hoes als info-afbeelding
  const cap = personParts(c).join(' · ');
  if(c.showPhoto && c.img) return { label:cap, image:c.img };   // foto met onderschrift (naam/rol, of leeg)
  if(c.showName && c.showRole && c.name) return { label:c.role, value:c.name };
  return { value: (c.showName && c.name) ? c.name : c.role };
}
function clueToStage(c){    // hint (één voor één)
  // previewLabel = de categorie die vooraf in 'Hints die je gaat krijgen' staat — nooit de waarde/naam (geen spoiler)
  if(c.kind==='fact')   return { text:`${c.label}: ${c.value}`, previewLabel:c.label||'' };
  if(c.kind==='custom'){ const m=customMedia(c);                  // tekst-hint, of een directe media-hint
    if(m){ const o={}; o[m.type]=m.url; if(m.type==='audio') o.label='Fragment'; return o; }
    return { text:c.value }; }
  if(c.kind==='title')  return { text:c.value, previewLabel:c.role||'Titel' };
  if(c.kind==='image')  return { image:c.img, label:c.role||'', previewLabel:c.role||'' };   // poster/hoes als hint-afbeelding
  const cap = personParts(c).join(' · ');
  if(c.showPhoto && c.img) return { image:c.img, label:cap, previewLabel:c.role||'' };   // foto + onderschrift bij onthulling
  return { text: cap || c.name || c.role, previewLabel:c.role||'' };                     // geen foto → tekst
}
/* categorie van een clue voor de hint-preview — nooit de waarde/naam (geen spoiler).
   'Eigen' (custom) zegt niets → leeg laten zodat het mediatype (Foto/Video/…) als terugval geldt. */
function clueCategory(c){
  if(!c) return '';
  if(c.kind==='fact')   return c.label||'';
  if(c.kind==='custom') return '';
  if(c.kind==='audio')  return c.role||'Fragment';
  return c.role||'';                                       // person/image/title: rol = categorie
}
/* de media-sleutel waarmee een clue als stage verschijnt (zelfde vorm als de gebouwde stage) */
function clueMediaKey(c){
  if(!c) return '';
  if(c.kind==='audio')  return 'a:'+(c.preview||'');
  if(c.kind==='image')  return 'i:'+(c.img||'');
  if(c.kind==='person') return (c.showPhoto&&c.img) ? 'i:'+c.img : 't:'+personParts(c).join(' · ');
  if(c.kind==='custom'){ const m=customMedia(c); return m ? (m.type[0]+':'+m.url) : 't:'+(c.value||''); }
  if(c.kind==='fact')   return 't:'+`${c.label}: ${c.value}`;
  if(c.kind==='title')  return 't:'+(c.value||'');
  return '';
}
function stageMediaKey(s){
  return s.image!=null?'i:'+s.image : s.audio!=null?'a:'+s.audio : s.video!=null?'v:'+s.video : s.text!=null?'t:'+s.text : '';
}
/* oudere vragen hebben geen stage.previewLabel; haal de categorie terug uit de bewaarde clue-pool
   (q.source.clues) door per stage op media-inhoud te matchen — robuust tegen film/lied-volgorde. */
function backfillPreviewLabels(stages, source){
  if(!Array.isArray(stages) || !source || !Array.isArray(source.clues)) return;
  if(stages.every(s=>s.previewLabel!=null)) return;
  const cat={};
  source.clues.forEach(c=>{ const k=clueMediaKey(c); if(k && cat[k]==null){ const v=clueCategory(c); if(v) cat[k]=v; } });
  stages.forEach(s=>{ if(s.previewLabel==null){ const v=cat[stageMediaKey(s)]; if(v) s.previewLabel=v; } });
}
/* de Antwoord-zone → q.options/answer. Zoekmodus volgt uit de combinatie (zie answerSearchMode):
   titel→zoek op titel (tekst), artiest/album→zoek die (id), titel+artiest→zoek het nummer (track-id).
   Anders (of zoeken uit) → open tekst, jij beoordeelt. */
function applyAnswerZone(q, p){
  const ans=cluesIn(p.clues,'answer');
  if(!ans.length) return 'Sleep een antwoord naar het Antwoord-vak.';
  if(ans.some(c=>c.kind==='image')) return 'Een poster/afbeelding kan geen antwoord zijn — sleep ’m naar Info of Hints.';
  const sm = p.answerSearch ? answerSearchMode(p) : null;
  if(sm){
    const has=k=>ans.find(c=>c.key===k);
    q.options=sm.mode;
    if(sm.mode===':deezer-title'){ q.answer=has('title').value; q.answerLabel=has('title').value; }   // tekst-match op titel
    else if(sm.mode===':tmdb'){ const t=has('title'); q.answer=Number(t.apiId)||t.apiId; q.answerLabel=t.value; }
    else if(sm.mode===':deezer'){ const t=has('title'), a=has('artist'); q.answer=Number(t.apiId)||t.apiId; q.answerLabel=`${a.value} – ${t.value}`; }
    else { const c=has('artist')||has('album'); q.answer=Number(c.apiId)||c.apiId; q.answerLabel=c.value; }
    return null;
  }
  const vals=ans.map(clueAnswerText).map(s=>String(s||'').trim()).filter(Boolean);
  if(!vals.length) return 'Het antwoord-stukje heeft geen tekst om op te beoordelen.';
  q.options=':text'; q.answer=vals[0]; if(vals.length>1) q.accept=vals.slice(1); q.answerLabel=vals.join(' – ');
  return null;
}
export function buildMediaQuestion(p){
  if(!p) return { error:'Niets gekozen.' };
  const isFilm = p.kind==='film';
  const prompt=(p.prompt||'').trim() || (isFilm?'Welke film?':'Welk nummer is dit?');
  const q={ question:prompt, points:100 };
  const info=cluesIn(p.clues,'info').filter(c=>c.kind!=='audio');   // audio kan geen subkop zijn
  const hints=cluesIn(p.clues,'hint');
  if(info.length) q.facts=info.map(clueToFact);

  if(isFilm){
    if(hints.length){ const m=defaultBetMults(hints.length); q.stages=hints.map((c,i)=>Object.assign(clueToStage(c),{betMultiplier:m[i]})); }
    if(p.poster) q.answerImage=p.poster;
  } else {
    const frag=(p.clues||[]).find(c=>c.kind==='audio');
    const start=frag?Math.min(30, Math.max(0, parseFloat(frag.start)||0)):0;
    let end=frag?((frag.end===''||frag.end==null)?null:parseFloat(frag.end)):null;
    if(end!=null && isNaN(end)) end=null;
    if(end!=null) end=Math.min(30, end);
    if(frag && end!=null && end<=start) return { error:'“tot” moet ná “van” liggen (max 30 sec).' };
    const fragStage=()=>Object.assign({ audio:frag.preview, clipStart:start, label:'Fragment' }, end!=null?{clipEnd:end}:{});
    // reveal-volgorde: fragment-in-info speelt vanaf het begin (stage 0), daarna de hint-clues op volgorde
    const seq=[];
    if(frag && frag.zone==='info') seq.push(frag);
    hints.forEach(c=> seq.push(c));
    const factCount=seq.filter(c=>c.kind!=='audio').length;
    if(factCount>0){
      const m=defaultBetMults(seq.length);
      q.stages=seq.map((c,i)=>Object.assign(c.kind==='audio'?fragStage():clueToStage(c), {betMultiplier:m[i]}));
    } else if(frag && frag.zone!=='off'){
      q.audio=frag.preview; q.clipStart=start; if(end!=null) q.clipEnd=end;   // alleen het fragment → niet-staged
    }
  }

  const err=applyAnswerZone(q, p); if(err) return { error:err };
  if(!q.stages && !(q.facts&&q.facts.length) && !q.audio)
    return { error: isFilm ? 'Sleep minstens één stukje naar Info of Hints — anders ziet de speler niets om op te raden.' : 'Sleep het fragment (of wat info) naar Info of Hints.' };
  q.source={ kind:isFilm?'tmdb':'deezer', id:p.tmdbId??p.deezerId, label:p.label, clues:(p.clues||[]).map(c=>({...c})) };
  if(!isFilm){ if(p.preview) q.source.preview=p.preview; if(p.cover) q.source.cover=p.cover; }
  return { q, label:p.label };
}

/* ---------- bouwer-UI (gedeeld door account/quizzes/ en account/questions/) ----------
   Twee helften: LINKS de vraag (prompt + Info/Hints-dropzones + antwoord), RECHTS de bron
   (poster/cover + titel + de versleepbare pool). Slepen kan tussen alle drie de zones
   (info/hint links, de pool = zone 'off' rechts). Op mobiel komen de helften onder elkaar. */
function clueChipHTML(c, num, withToggles){
  const n = num!=null ? `<span class="cnum">${num}</span>` : '';
  let body;
  if(c.kind==='audio'){                       // het fragment: speler + clip-venster, overal versleepbaar
    body = `<div class="cchip-frag"><div>🎵 <b>Fragment</b> <span class="muted" style="font-size:11px">(alleen host)</span></div>
      <audio controls preload="none" src="${esc(c.preview)}" style="width:100%"></audio>
      <div class="fragclip"><span class="muted">van</span> <input type="number" class="mb-frag-start" data-id="${esc(c.id)}" min="0" max="30" step="1" value="${c.start??0}"> <span class="muted">tot</span> <input type="number" class="mb-frag-end" data-id="${esc(c.id)}" min="0" max="30" step="1" value="${c.end??''}"> <span class="muted">sec</span></div></div>`;
  } else if(c.kind==='custom'){                // zelf stukje: één veld — tekst óf een directe medialink (overal versleepbaar)
    const t=c.mediaType||'text';
    const ph = t==='text' ? 'Tekst (of een link om als tekst te tonen)…'
             : t==='image' ? 'Directe link naar de afbeelding (https://….jpg)'
             : t==='video' ? 'Directe link naar de video (https://….mp4)'
             : 'Directe link naar de audio (https://….mp3)';
    const typeSel=`<select class="mb-custom-mtype" data-id="${esc(c.id)}">${[['text','tekst'],['image','afbeelding'],['video','video'],['audio','audio']].map(([v,l])=>`<option value="${v}" ${t===v?'selected':''}>${l}</option>`).join('')}</select>`;
    const prev = (t!=='text'&&c.value) ? (t==='image'?`<img src="${esc(c.value)}" alt="" class="cchip-img">` : t==='video'?`<span class="cchip-role">▶ video</span>` : `<span class="cchip-role" title="audio speelt alleen op het hostscherm">🔊 host</span>`) : '';
    body = `<div class="cchip-cbody">
        <input class="mb-custom-val cchip-input" data-id="${esc(c.id)}" value="${esc(c.value||'')}" placeholder="${esc(ph)}">
        <div class="cchip-media">${typeSel}${prev}</div>
      </div>
      <button type="button" class="mini danger mb-custom-del" data-id="${esc(c.id)}" title="verwijderen">${ICON_TRASH}</button>`;
  } else if(c.kind==='title'){
    body = `<span class="cchip-t"><b>Titel</b>: ${esc(c.value||'')}</span>${isSearchable(c)?'<span class="cchip-role" title="Dit veld is compatibel met de zoeken-API">zoekbaar</span>':''}`;
  } else if(c.kind==='fact'){
    body = `<span class="cchip-t"><b>${esc(c.label)}</b>: ${esc(c.value)}</span>${isSearchable(c)?'<span class="cchip-role" title="Dit veld is compatibel met de zoeken-API">zoekbaar</span>':''}`;
  } else if(c.kind==='image'){               // poster/hoes: thumbnail + rol (zelfde in pool en Info/Hints)
    body = `<img src="${esc(c.img)}" alt="" class="cchip-img"><span class="cchip-t">${esc(c.role||'Afbeelding')}</span>`;
  } else if(withToggles){                    // persoon LINKS (Info/Hints): voorbeeld zoals spelers het zien + de vinkjes
    const thumb = (c.showPhoto && c.img) ? `<img src="${esc(c.img)}" alt="" class="cchip-img">` : '';
    const bits=[];
    if(c.showName && c.name) bits.push(esc(c.name));
    if(c.showRole && c.role) bits.push(`<span class="cchip-role">${esc(c.role)}</span>`);
    const txt = bits.length ? bits.join(' ') : `<span class="muted">— niets zichtbaar —</span>`;
    const toggles = `<span class="cchip-ck"><label><input type="checkbox" class="mb-name" data-id="${esc(c.id)}" ${c.showName?'checked':''}>naam</label>${c.img?`<label><input type="checkbox" class="mb-photo" data-id="${esc(c.id)}" ${c.showPhoto?'checked':''}>foto</label>`:''}<label><input type="checkbox" class="mb-role" data-id="${esc(c.id)}" ${c.showRole?'checked':''}>rol</label></span>`;
    body = `${thumb}<span class="cchip-t">${txt}</span>${toggles}`;
  } else {                                    // persoon POOL (rechts): volledige identiteit, zodat je weet wat je sleept
    const thumb = c.img ? `<img src="${esc(c.img)}" alt="" class="cchip-img">` : '';
    const roleBadge = c.role ? ` <span class="cchip-role">${esc(c.role)}</span>` : '';
    body = `${thumb}<span class="cchip-t">${esc(c.name||'')}${roleBadge}</span>`;
  }
  return `<div class="cchip" data-id="${esc(c.id)}"><span class="grip" title="Sleep">${ICON_GRIP}</span>${n}${body}</div>`;
}
/* een drop-zone (Info / Hints / Antwoord). Bij Hints genummerd; bij Info/Hints tonen persoon-chips
   het speler-voorbeeld (vinkjes), bij Antwoord de pure identiteit. */
function dropZoneHTML(zone, title, sub, p){
  const items=cluesIn(p.clues, zone);
  const rows=items.map((c,i)=>clueChipHTML(c, zone==='hint'?i+1:null, zone!=='answer')).join('');
  const empty = rows ? '' : `<div class="cluempty muted">— sleep hierheen —</div>`;
  return `<div class="czone"><div class="czone-h">${esc(title)}${sub?` <span class="czone-sub">${esc(sub)}</span>`:''}</div>
    <div class="czone-drop" data-zone="${zone}">${rows}${empty}</div></div>`;
}
export function mediaBuilderHTML(p, opts){
  opts=opts||{};
  const isFilm = p.kind==='film';
  // antwoord-vak: zoeken (API) of typen? De zoekmodus volgt uit de combinatie in Antwoord.
  const ans=cluesIn(p.clues,'answer');
  const sm = answerSearchMode(p);
  let answerCtl;
  if(!ans.length){
    answerCtl = `<p class="muted hint">Sleep hierheen wat het antwoord is (bv. de titel). Wat hier ligt, kan geen hint/info zijn.</p>`;
  } else if(sm){
    answerCtl = `<label class="answersearch"><input type="checkbox" id="mb-search" ${p.answerSearch?'checked':''}> Spelers zoeken <b>${esc(sm.desc)}</b> <span class="muted">(uit = zelf typen)</span></label>`;
  } else {
    answerCtl = `<p class="muted hint">Spelers typen het antwoord; jij beoordeelt.${ans.length>1?' Alle gesleepte stukjes gelden als goed.':''}</p>`;
  }
  // rechterkolom: de versleepbare pool (zone 'off') — poster én titel zitten als clues in de pool
  const pool = cluesIn(p.clues,'off');
  const poolRows = pool.map(c=>clueChipHTML(c, null, false)).join('');
  const poolBody = poolRows || ((p.clues&&p.clues.length)
    ? `<div class="cluempty muted">Alles is al ingedeeld.</div>`
    : `<div class="cluempty muted">Geen ${isFilm?'film':'nummer'}-info geladen.${isFilm?'<br>Is de TMDB-Worker al opnieuw gedeployd?':''}</div>`);
  // onderste actie-rij: 'Toevoegen/Opslaan' kan verborgen worden (hideAdd) als opslaan in de top-bar staat
  const actions = opts.hideAdd
    ? `<div class="row"><button class="btn ghost grow" id="b-mb-reset">${esc(opts.resetLabel||'Ander item')}</button></div>`
    : `<div class="row"><button class="btn grow" id="b-mb-add">${esc(opts.addLabel||'Toevoegen')}</button><button class="btn ghost" id="b-mb-reset">${esc(opts.resetLabel||'Ander item')}</button></div>`;
  return `
    <div class="mb-grid">
      <div class="mb-col stack" style="gap:10px">
        <label class="lbl">De vraag <span class="czone-sub">zichtbaar vanaf het begin</span></label>
        <input id="mb-prompt" class="sinput m0" value="${esc(p.prompt||'')}" placeholder="${isFilm?'Welke film?':'Welk nummer is dit?'}">
        ${dropZoneHTML('info','Info','zichtbaar vanaf het begin', p)}
        ${dropZoneHTML('hint','Hints','krijgen spelers één voor één te zien, na elke hint kunnen ze een antwoord geven (hint 1 krijgen ze als eerste te zien)', p)}
        ${dropZoneHTML('answer','Antwoord','wat is het juiste antwoord?', p)}
        ${answerCtl}
        ${opts.roundPickerHTML||''}
      </div>
      <div class="mb-col mb-right stack" style="gap:8px">
        <p class="muted hint">Sleep een stukje naar <b>Info</b>, <b>Hints</b> of <b>Antwoord</b> ◀</p>
        <div class="czone-drop mb-pool" data-zone="off">${poolBody}</div>
        <button type="button" class="btn ghost f13" id="mb-addcustom">+ eigen stukje</button>
      </div>
    </div>
    ${actions}`;
}
/* wiring: leest de velden + zone-volgorde terug in p; geeft syncFromDOM() terug zodat de
   aanroeper die ook na een sleep (enableDragGroup onDrop) en vóór opslaan kan draaien. */
export function wireMediaBuilder(scope, p, render){
  const $=s=>scope.querySelector(s);
  const read=()=>{
    if($('#mb-prompt')) p.prompt=$('#mb-prompt').value;
    if($('#mb-search')) p.answerSearch=$('#mb-search').checked;
    scope.querySelectorAll('.mb-name').forEach(cb=>{ const c=p.clues.find(x=>x.id===cb.dataset.id); if(c)c.showName=cb.checked; });
    scope.querySelectorAll('.mb-photo').forEach(cb=>{ const c=p.clues.find(x=>x.id===cb.dataset.id); if(c)c.showPhoto=cb.checked; });
    scope.querySelectorAll('.mb-role').forEach(cb=>{ const c=p.clues.find(x=>x.id===cb.dataset.id); if(c)c.showRole=cb.checked; });
    scope.querySelectorAll('.mb-frag-start').forEach(inp=>{ const c=p.clues.find(x=>x.id===inp.dataset.id); if(c)c.start=inp.value; });
    scope.querySelectorAll('.mb-frag-end').forEach(inp=>{ const c=p.clues.find(x=>x.id===inp.dataset.id); if(c)c.end=inp.value; });
    scope.querySelectorAll('.mb-custom-val').forEach(inp=>{ const c=p.clues.find(x=>x.id===inp.dataset.id); if(c)c.value=inp.value; });
    scope.querySelectorAll('.mb-custom-mtype').forEach(sel=>{ const c=p.clues.find(x=>x.id===sel.dataset.id); if(c)c.mediaType=sel.value; });
  };
  const syncFromDOM=()=>{
    read();
    const order=[], seen=new Set();
    scope.querySelectorAll('[data-zone]').forEach(zEl=>{
      const zone=zEl.dataset.zone;
      zEl.querySelectorAll(':scope > [data-id]').forEach(node=>{
        const c=p.clues.find(x=>x.id===node.dataset.id);
        if(c){ c.zone=zone; order.push(c); seen.add(c); }
      });
    });
    p.clues.forEach(c=>{ if(!seen.has(c)) order.push(c); });
    p.clues=order;
  };
  const sb=$('#mb-search'); if(sb) sb.onchange=()=>{ read(); };   // zoeken/typen — geen re-render nodig
  scope.querySelectorAll('.mb-name,.mb-photo,.mb-role').forEach(cb=>cb.onchange=()=>{ read(); render(); });   // her-render zodat het voorbeeld de keuze toont
  scope.querySelectorAll('.mb-custom-del').forEach(b=>b.onclick=()=>{ read(); p.clues=p.clues.filter(x=>x.id!==b.dataset.id); render(); });
  scope.querySelectorAll('.mb-custom-mtype').forEach(sel=>sel.onchange=()=>{ read(); render(); });   // type wisselen → placeholder/voorbeeld bijwerken
  scope.querySelectorAll('.mb-custom-val').forEach(inp=>inp.onchange=()=>{ read(); render(); });     // link ingevuld → voorbeeld tonen
  const ac=$('#mb-addcustom'); if(ac) ac.onclick=()=>{ read(); p.clues.push(newCustomClue()); render(); };
  return syncFromDOM;
}

/* ============================================================
   CUSTOM-VRAAG BOUWER  (zelf samengesteld: prompt → info → hints → antwoord)
   ------------------------------------------------------------
   Derde vraagtype naast film/liedje. Geen API-bron: de quizmaker bouwt alles met
   custom-clues (tekst óf een directe medialink: afbeelding/video/audio). Eén kolom:
     - Info  → q.facts (altijd zichtbaar)
     - Hints → q.stages (één voor één, met inzet-multipliers)
     - Antwoord → tekst; open (:text, jij keurt) of meerkeuze (opties, >6 = doorzoekbaar)
   ============================================================ */
export function newCustomPick(){ return { kind:'custom', prompt:'', clues:[], answerMode:'open', correct:[''], distractors:[''] }; }

/* opgeslagen vraag terug in een bewerkbare custom-pick (lossless via q.source.clues; oude
   meerkeuze/open-vragen zonder source worden gereconstrueerd) */
export function customPickFromQuestion(q){
  const src=q.source||{};
  if(src.kind==='custom' && Array.isArray(src.clues)){
    const clues=src.clues.map(c=>{ const n={...c};
      if(n.media && String(n.media).trim() && (n.mediaType||'text')!=='text') n.value=n.media;   // oud twee-velden-model → één veld
      delete n.media; return n; });
    return { kind:'custom', prompt:q.question||'', clues,
             answerMode:src.answerMode||'open', correct:(src.correct||[]).slice(), distractors:(src.distractors||[]).slice() };
  }
  const nid=()=>'custom:'+Math.random().toString(36).slice(2,7);
  const p={ kind:'custom', prompt:q.question||'', clues:[], answerMode:'open', correct:[], distractors:[] };
  const top = q.image?{t:'image',u:q.image}:q.video?{t:'video',u:q.video}:q.audio?{t:'audio',u:q.audio}:null;
  if(top) p.clues.push({ id:nid(), kind:'custom', role:'Eigen', value:top.u, mediaType:top.t, zone:'info' });
  (Array.isArray(q.stages)?q.stages:[]).forEach(s=>{
    const media=s.image||s.video||s.audio||'', mt=s.image?'image':s.video?'video':s.audio?'audio':'text';
    p.clues.push({ id:nid(), kind:'custom', role:'Eigen', value: media || s.text || s.label || '', mediaType:mt, zone:'hint' });
  });
  if(q.options===':text'){ p.answerMode='open'; p.correct=[q.answer, ...((q.accept)||[])].filter(x=>x!=null).map(String); }
  else if(Array.isArray(q.options)){
    p.answerMode='mc';
    const ans=q.answer, ci=Array.isArray(ans)?ans.map(Number):[Number(ans!=null?ans:0)];
    p.correct=ci.map(i=>q.options[i]).filter(x=>x!=null).map(String);
    p.distractors=q.options.filter((_,i)=>!ci.includes(i)).map(String);
  }
  if(!p.correct.length && q.answerLabel) p.correct=[String(q.answerLabel)];
  if(!p.correct.length) p.correct=[''];
  if(!p.distractors.length) p.distractors=[''];
  return p;
}

/* custom-pick → vraag-object */
export function buildCustomQuestion(p){
  if(!p) return { error:'Niets ingevuld.' };
  const prompt=(p.prompt||'').trim();
  const q={ question:prompt, points:100 };
  const isEmpty=c=> !(c.value&&String(c.value).trim());
  const info=cluesIn(p.clues,'info').filter(c=>!isEmpty(c));
  const hints=cluesIn(p.clues,'hint').filter(c=>!isEmpty(c));
  if(info.length) q.facts=info.map(clueToFact);
  if(hints.length){ const m=defaultBetMults(hints.length); q.stages=hints.map((c,i)=>Object.assign(clueToStage(c),{betMultiplier:m[i]})); }
  const correct=(p.correct||[]).map(s=>String(s||'').trim()).filter(Boolean);
  if(!correct.length) return { error:'Vul minstens één juist antwoord in.' };
  if((p.answerMode||'open')==='mc'){
    const dist=(p.distractors||[]).map(s=>String(s||'').trim()).filter(Boolean);
    const options=[...correct, ...dist];
    if(options.length<2) return { error:'Meerkeuze heeft minstens 2 opties nodig — voeg foute opties toe (of kies Open).' };
    q.options=options;
    q.answer = correct.length===1 ? 0 : correct.map((_,i)=>i);
    if(options.length>6) q.search=true; else q.shuffle=true;        // >6 → doorzoekbaar; anders tegels (husselen)
    q.answerLabel = correct.join(' / ');
  } else {
    q.options=':text'; q.answer=correct[0]; if(correct.length>1) q.accept=correct.slice(1);
    q.answerLabel = correct.join(' / ');
  }
  if(!q.stages && !(q.facts&&q.facts.length) && !prompt)
    return { error:'Geef een vraag, of voeg info/hints toe — anders ziet de speler niets om op te raden.' };
  q.source={ kind:'custom', clues:(p.clues||[]).map(c=>({...c})), answerMode:p.answerMode||'open',
             correct, distractors:(p.distractors||[]).map(s=>String(s||'').trim()).filter(Boolean) };
  return { q, label: correct[0]||prompt };
}

/* één Info/Hints-blok: chips + een "+ toevoegen"-knop. Slepen kan tussen Info en Hints. */
function customZoneHTML(zone, title, sub, addId, addLabel, p){
  const items=cluesIn(p.clues, zone);
  const rows=items.map((c,i)=>clueChipHTML(c, zone==='hint'?i+1:null, false)).join('');
  const empty = rows ? '' : `<div class="cluempty muted">— nog niets —</div>`;
  return `<div class="czone"><div class="czone-h">${esc(title)}${sub?` <span class="czone-sub">${esc(sub)}</span>`:''}</div>
    <div class="czone-drop" data-zone="${zone}">${rows}${empty}</div>
    <button type="button" class="btn ghost f13" id="${addId}">${esc(addLabel)}</button></div>`;
}
export function customBuilderHTML(p, opts){
  opts=opts||{};
  const mode=p.answerMode||'open';
  const ansRow=(cls,delCls,v,i,ph)=>`<div class="cb-row"><input class="${cls} cchip-input" data-i="${i}" value="${esc(v||'')}" placeholder="${esc(ph)}"><button type="button" class="mini danger ${delCls}" data-i="${i}" title="verwijderen">${ICON_TRASH}</button></div>`;
  const corrRows=(p.correct||[]).map((v,i)=>ansRow('cb-correct','cb-correct-del',v,i,'Juist antwoord')).join('');
  const distRows=(p.distractors||[]).map((v,i)=>ansRow('cb-dist','cb-dist-del',v,i,'Foute optie')).join('');
  const answerBox=`<div class="czone"><div class="czone-h">Antwoord</div>
    <div class="cb-modes">
      <label><input type="radio" name="cb-mode" value="open" ${mode==='open'?'checked':''}> Open <span class="muted">(typen, jij keurt)</span></label>
      <label><input type="radio" name="cb-mode" value="mc" ${mode==='mc'?'checked':''}> Meerkeuze</label>
    </div>
    <label class="lbl">Juiste antwoord(en)</label>
    ${corrRows}
    <button type="button" class="btn ghost f13" id="cb-add-correct">+ juist antwoord</button>
    ${mode==='mc'
      ? `<label class="lbl">Foute opties</label>${distRows}
         <button type="button" class="btn ghost f13" id="cb-add-dist">+ foute optie</button>
         <p class="muted hint">Meer dan 6 opties totaal? Dan wordt het automatisch doorzoekbaar (zoals de hondenrassen).</p>`
      : `<p class="muted hint">Spelers typen; jij keurt goed. Alle ingevulde antwoorden gelden als juist.</p>`}
  </div>`;
  const actions = opts.hideAdd ? '' : `<div class="row"><button class="btn grow" id="b-cb-add">${esc(opts.addLabel||'Toevoegen')}</button><button class="btn ghost" id="${opts.backId||'b-back'}">Terug</button></div>`;
  return `<div class="stack" style="gap:10px">
      <label class="lbl">De vraag <span class="czone-sub">zichtbaar vanaf het begin</span></label>
      <input id="mb-prompt" class="sinput m0" value="${esc(p.prompt||'')}" placeholder="Bv. Welke stad is dit?">
      ${customZoneHTML('info','Info','altijd zichtbaar', 'cb-add-info','+ info toevoegen', p)}
      ${customZoneHTML('hint','Hints','spelers zien ze één voor één; na elke hint mogen ze antwoorden', 'cb-add-hint','+ hint toevoegen', p)}
      ${answerBox}
      ${opts.roundPickerHTML||''}
    </div>
    ${actions}`;
}
/* wiring: leest velden + zone-volgorde terug in p; geeft syncFromDOM() terug (ook voor top-bar Opslaan). */
export function wireCustomBuilder(scope, p, render){
  const $=s=>scope.querySelector(s);
  const read=()=>{
    if($('#mb-prompt')) p.prompt=$('#mb-prompt').value;
    const m=scope.querySelector('input[name="cb-mode"]:checked'); if(m) p.answerMode=m.value;
    p.correct = Array.from(scope.querySelectorAll('.cb-correct')).map(i=>i.value);
    p.distractors = Array.from(scope.querySelectorAll('.cb-dist')).map(i=>i.value);
    scope.querySelectorAll('.mb-custom-val').forEach(inp=>{ const c=p.clues.find(x=>x.id===inp.dataset.id); if(c)c.value=inp.value; });
    scope.querySelectorAll('.mb-custom-mtype').forEach(sel=>{ const c=p.clues.find(x=>x.id===sel.dataset.id); if(c)c.mediaType=sel.value; });
  };
  const syncFromDOM=()=>{
    read();
    const order=[], seen=new Set();
    scope.querySelectorAll('[data-zone]').forEach(zEl=>{
      const zone=zEl.dataset.zone;
      zEl.querySelectorAll(':scope > [data-id]').forEach(node=>{
        const c=p.clues.find(x=>x.id===node.dataset.id);
        if(c){ c.zone=zone; order.push(c); seen.add(c); }
      });
    });
    p.clues.forEach(c=>{ if(!seen.has(c)) order.push(c); });
    p.clues=order;
  };
  scope.querySelectorAll('input[name="cb-mode"]').forEach(r=>r.onchange=()=>{ read(); render(); });
  scope.querySelectorAll('.mb-custom-mtype').forEach(sel=>sel.onchange=()=>{ read(); render(); });   // type wisselen → placeholder/voorbeeld bijwerken
  scope.querySelectorAll('.mb-custom-val').forEach(inp=>inp.onchange=()=>{ read(); render(); });     // link ingevuld → voorbeeld tonen
  scope.querySelectorAll('.mb-custom-del').forEach(b=>b.onclick=()=>{ read(); p.clues=p.clues.filter(x=>x.id!==b.dataset.id); render(); });
  scope.querySelectorAll('.cb-correct-del').forEach(b=>b.onclick=()=>{ read(); p.correct.splice(+b.dataset.i,1); render(); });
  scope.querySelectorAll('.cb-dist-del').forEach(b=>b.onclick=()=>{ read(); p.distractors.splice(+b.dataset.i,1); render(); });
  const ai=$('#cb-add-info'); if(ai)ai.onclick=()=>{ read(); p.clues.push(newCustomClue('info')); render(); };
  const ah=$('#cb-add-hint'); if(ah)ah.onclick=()=>{ read(); p.clues.push(newCustomClue('hint')); render(); };
  const acc=$('#cb-add-correct'); if(acc)acc.onclick=()=>{ read(); (p.correct=p.correct||[]).push(''); render(); };
  const adn=$('#cb-add-dist'); if(adn)adn.onclick=()=>{ read(); (p.distractors=p.distractors||[]).push(''); render(); };
  return syncFromDOM;
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
