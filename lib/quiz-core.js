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
  if(s.clipStart!=null)o.clipStart=s.clipStart; if(s.clipEnd!=null)o.clipEnd=s.clipEnd;  // audio-fragment afspelen van … tot …
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
      done({ artist:(t.artist&&t.artist.name)||'', album:(t.album&&t.album.title)||'', year:/^\d{4}$/.test(yr)?yr:'' });
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

/* info-subkop (tekst-pillen + optioneel een fotootje) — ook ingebakken in index.html (game) */
export function factsHTML(facts){
  if(!Array.isArray(facts)||!facts.length) return '';
  const cells=facts.map(f=> f.image
    ? `<span class="factimg"><img src="${esc(f.image)}" alt="">${f.label?`<span>${esc(f.label)}</span>`:''}</span>`
    : `<span class="pill">${f.label?esc(f.label)+': ':''}${esc(f.value)}</span>`).join('');
  return `<div class="factsrow">${cells}</div>`;
}

/* ---------- pick-objecten (verse film/liedje, of teruggelezen uit een opgeslagen vraag) ---------- */
/* persoon-clue (acteur/regisseur/componist): naam + optionele foto, los aan/uit te vinken.
   key = id; voor regisseur/componist is dat 'director'/'composer' (zo kunnen die ook het antwoord zijn). */
function personClue(id, role, name, img){ return { id, kind:'person', key:id, role, name:name||'', img:img||'', showName:true, showPhoto:!!img, showRole:false, zone:'off' }; }
function factClue(f){ return { id:'f:'+f.key, kind:'fact', key:f.key, label:f.label, value:f.value, zone:'off' }; }

export function newFilmPick(d){
  const clues=[];
  movieFacts(d).forEach(f=> clues.push(factClue(f)));                                                  // 1. jaar, genre, rating, speelduur
  if(d.director) clues.push(personClue('director','Regisseur', d.director.name, d.director.img));       // 2. unieke rollen
  if(d.composer) clues.push(personClue('composer','Componist', d.composer.name, d.composer.img));
  (d.cast||[]).forEach(a=> clues.push(personClue('a:'+a.id, 'Acteur', a.name, a.img)));  // 3. acteurs in credits-volgorde (hoofdrol bovenaan)
  // alles start in de pool (zone 'off'); de maker sleept naar Info/Hints
  return { kind:'film', tmdbId:d.id, deezerId:null, label:d.title, poster:d.poster||null,
           clues, prompt:'Welke film?', answerKey:'title', mode:':tmdb', customAnswer:'', accept:'' };
}
export function newSongPick(t, facts){
  return { kind:'song', deezerId:t.id, tmdbId:null, label:t.label, preview:t.preview||'', cover:t.thumb||'',
           clues:(facts||[]).map(factClue), prompt:'Welk nummer is dit?', answerKey:'title', mode:':deezer',
           customAnswer:'', accept:'', start:0, end:15 };
}

/* het juiste antwoord uit een opgeslagen vraag terugleiden (titel / een feit / eigen tekst) */
function answerFromQuestion(q, p){
  const out={ answerKey:'title', mode:p.kind==='film'?':tmdb':':deezer', customAnswer:'', accept:(q.accept||[]).join(', ') };
  if(q.options===':tmdb'||q.options===':deezer'){ out.answerKey='title'; out.mode=q.options; }
  else if(q.options===':text'){
    // antwoord = een feit (op waarde) of regisseur/componist (op naam)?
    const matchC=(p.clues||[]).find(c=> (c.kind==='fact'&&c.value===q.answer) || ((c.key==='director'||c.key==='composer')&&c.name===q.answer));
    if(q.answer===p.label && p.label){ out.answerKey='title'; out.mode=':text'; }
    else if(matchC){ out.answerKey=matchC.key; }
    else { out.answerKey='custom'; out.customAnswer=q.answer||''; }
  }
  return out;
}
function songClip(q){
  if(Array.isArray(q.stages)){ const a=q.stages.find(s=>s.audio); if(a) return { start:a.clipStart??0, end:a.clipEnd??'' }; }
  return { start:q.clipStart??0, end:q.clipEnd??'' };
}
/* een opgeslagen film/lied-vraag terug in een bewerkbare pick (lossless via q.source.clues) */
export function pickFromQuestion(q){
  const src=q.source||{};
  const isFilm = src.kind==='tmdb' || (src.kind==null && (q.options===':tmdb'));
  const p = isFilm
    ? { kind:'film', tmdbId:src.id??(q.options===':tmdb'?q.answer:null), deezerId:null, label:src.label||q.answerLabel||'', poster:q.answerImage||src.poster||null }
    : { kind:'song', deezerId:src.id??(q.options===':deezer'?q.answer:null), tmdbId:null, label:src.label||q.answerLabel||(q.options===':text'?q.answer:'')||'', preview:(Array.isArray(q.stages)?(q.stages.find(s=>s.audio)||{}).audio:q.audio)||src.preview||'' };
  if(Array.isArray(src.clues) && src.clues.length){
    p.clues = src.clues.map(c=>({...c}));
  } else {
    // legacy: geen opgeslagen clue-pool → acteur-fotohints reconstrueren, geen feiten
    const imgStages=(q.stages||[]).filter(s=>s.image);
    p.clues = imgStages.map((s,i)=>({ id:'a:'+i, kind:'person', key:'a:'+i, role:'Acteur', name:s.label||'', img:s.image, showName:!!s.label, showPhoto:true, showRole:false, zone:'hint' }));
  }
  p.prompt = q.question || (isFilm?'Welke film?':'Welk nummer is dit?');
  Object.assign(p, answerFromQuestion(q, p));
  if(!isFilm){ const c=songClip(q); p.start=c.start; p.end=c.end; p.cover=src.cover||''; }
  return p;
}

/* ---------- pick → vraag-object ---------- */
function parseAccept(s){ return String(s||'').split(',').map(x=>x.trim()).filter(Boolean); }
function cluesIn(clues, zone, answerKey){ return (clues||[]).filter(c=> c.zone===zone && c.key!==answerKey); }
/* tekst-deel van een persoon: naam en/of rol, naar keuze (foto wordt apart afgehandeld) */
function personParts(c){
  const p=[];
  if(c.showName && c.name) p.push(c.name);
  if(c.showRole && c.role) p.push(c.role);
  return p;
}
function clueToFact(c){     // info-subkop
  if(c.kind==='fact') return { label:c.label, value:c.value };
  const cap = personParts(c).join(' · ');
  if(c.showPhoto && c.img) return { label:cap, image:c.img };   // foto met onderschrift (naam/rol, of leeg)
  // geen foto → tekst-pil: "Rol: Naam" als beide, anders alleen wat aanstaat
  if(c.showName && c.showRole && c.name) return { label:c.role, value:c.name };
  return { value: (c.showName && c.name) ? c.name : c.role };
}
function clueToStage(c){    // hint (één voor één)
  if(c.kind==='fact') return { text:`${c.label}: ${c.value}` };
  const cap = personParts(c).join(' · ');
  if(c.showPhoto && c.img) return { image:c.img, label:cap };   // foto + onderschrift bij onthulling
  return { text: cap || c.name || c.role };                     // geen foto → tekst
}
function applyAnswer(q, p){
  if(p.answerKey==='title'){
    if(p.mode===':text'){ q.options=':text'; q.answer=p.label; }
    else { const id=p.tmdbId??p.deezerId; q.options=(p.kind==='film'?':tmdb':':deezer'); q.answer=Number(id)||id; q.answerLabel=p.label; }
  } else if(p.answerKey==='custom'){
    const a=(p.customAnswer||'').trim(); if(!a) return 'Vul het eigen antwoord in.';
    q.options=':text'; q.answer=a; const acc=parseAccept(p.accept); if(acc.length) q.accept=acc;
  } else {
    const c=(p.clues||[]).find(x=> x.key===p.answerKey && (x.kind==='fact' || x.key==='director' || x.key==='composer')); if(!c) return 'Onbekend antwoord-veld.';
    q.options=':text'; q.answer = c.kind==='fact' ? c.value : c.name; const acc=parseAccept(p.accept); if(acc.length) q.accept=acc;
  }
  return null;
}
export function buildMediaQuestion(p){
  if(!p) return { error:'Niets gekozen.' };
  const isFilm = p.kind==='film';
  const prompt=(p.prompt||'').trim() || (isFilm?'Welke film?':'Welk nummer is dit?');
  const q={ question:prompt, points:100 };
  const info=cluesIn(p.clues,'info',p.answerKey);
  const hints=cluesIn(p.clues,'hint',p.answerKey);
  if(info.length) q.facts=info.map(clueToFact);

  if(isFilm){
    if(hints.length){ const m=defaultBetMults(hints.length); q.stages=hints.map((c,i)=>Object.assign(clueToStage(c),{betMultiplier:m[i]})); }
    if(p.poster) q.answerImage=p.poster;
  } else {
    const start=Math.max(0, parseFloat(p.start)||0);
    let end=(p.end===''||p.end==null)?null:parseFloat(p.end);
    if(end!=null && isNaN(end)) end=null;
    if(end!=null && end<=start) return { error:'“tot” moet ná “van” liggen.' };
    if(hints.length){
      const frag=Object.assign({ audio:p.preview, clipStart:start, label:'Fragment' }, end!=null?{clipEnd:end}:{});
      const stages=[frag].concat(hints.map(clueToStage));
      const m=defaultBetMults(stages.length);
      q.stages=stages.map((s,i)=>Object.assign(s,{betMultiplier:m[i]}));
    } else {
      q.audio=p.preview; q.clipStart=start; if(end!=null) q.clipEnd=end;
    }
  }

  const err=applyAnswer(q, p); if(err) return { error:err };
  if(isFilm && !q.stages && !(q.facts&&q.facts.length))
    return { error:'Sleep minstens één stukje naar Info of Hints — anders ziet de speler niets om op te raden.' };
  q.source={ kind:isFilm?'tmdb':'deezer', id:p.tmdbId??p.deezerId, label:p.label, clues:(p.clues||[]).map(c=>({...c})) };
  if(!isFilm){ if(p.preview) q.source.preview=p.preview; if(p.cover) q.source.cover=p.cover; }
  return { q, label:p.label };
}

/* ---------- bouwer-UI (gedeeld door quizzes.html en questions.html) ----------
   Twee helften: LINKS de vraag (prompt + Info/Hints-dropzones + antwoord), RECHTS de bron
   (poster/cover + titel + de versleepbare pool). Slepen kan tussen alle drie de zones
   (info/hint links, de pool = zone 'off' rechts). Op mobiel komen de helften onder elkaar. */
function clueChipHTML(c, num, withToggles){
  const n = num!=null ? `<span class="cnum">${num}</span>` : '';
  let body;
  if(c.kind==='fact'){
    body = `<span class="cchip-t"><b>${esc(c.label)}</b>: ${esc(c.value)}</span>`;
  } else if(withToggles){                    // LINKS (Info/Hints): voorbeeld zoals spelers het zien + de vinkjes
    const thumb = (c.showPhoto && c.img) ? `<img src="${esc(c.img)}" alt="" class="cchip-img">` : '';
    const bits=[];
    if(c.showName && c.name) bits.push(esc(c.name));
    if(c.showRole && c.role) bits.push(`<span class="cchip-role">${esc(c.role)}</span>`);
    const txt = bits.length ? bits.join(' ') : `<span class="muted">— niets zichtbaar —</span>`;
    const toggles = `<span class="cchip-ck"><label><input type="checkbox" class="mb-name" data-id="${esc(c.id)}" ${c.showName?'checked':''}>naam</label>${c.img?`<label><input type="checkbox" class="mb-photo" data-id="${esc(c.id)}" ${c.showPhoto?'checked':''}>foto</label>`:''}<label><input type="checkbox" class="mb-role" data-id="${esc(c.id)}" ${c.showRole?'checked':''}>rol</label></span>`;
    body = `${thumb}<span class="cchip-t">${txt}</span>${toggles}`;
  } else {                                    // POOL (rechts): volledige identiteit, zodat je weet wat je sleept
    const thumb = c.img ? `<img src="${esc(c.img)}" alt="" class="cchip-img">` : '';
    const roleBadge = c.role ? ` <span class="cchip-role">${esc(c.role)}</span>` : '';
    body = `${thumb}<span class="cchip-t">${esc(c.name||'')}${roleBadge}</span>`;
  }
  return `<div class="cchip" data-id="${esc(c.id)}"><span class="grip" title="Sleep">${ICON_GRIP}</span>${n}${body}</div>`;
}
/* een drop-zone links (Info of Hints) */
function dropZoneHTML(zone, title, sub, p){
  const items=cluesIn(p.clues, zone, p.answerKey);
  const fragRow = (p.kind==='song' && zone==='hint')
    ? `<div class="cchip fixed"><span class="cnum">1</span><span class="cchip-t">🎵 <b>Fragment</b> (altijd eerst)</span></div>` : '';
  const base = (p.kind==='song' && zone==='hint') ? 1 : 0;
  const rows=items.map((c,i)=>clueChipHTML(c, zone==='hint'?base+i+1:null, true)).join('');
  const empty = (!rows && !fragRow) ? `<div class="cluempty muted">— sleep hierheen —</div>` : '';
  return `<div class="czone"><div class="czone-h">${esc(title)}${sub?` <span class="czone-sub">${esc(sub)}</span>`:''}</div>
    <div class="czone-drop" data-zone="${zone}">${fragRow}${rows}${empty}</div></div>`;
}
export function mediaBuilderHTML(p, opts){
  opts=opts||{};
  const isFilm = p.kind==='film';
  // antwoord-opties: titel + feiten (jaar/genre/…) + regisseur/componist (op naam) + eigen tekst
  const answerable=(p.clues||[]).filter(c=> c.kind==='fact' || c.key==='director' || c.key==='composer');
  const ansOpts=[`<option value="title" ${p.answerKey==='title'?'selected':''}>${isFilm?'De film zelf':'Het nummer zelf'}</option>`]
    .concat(answerable.map(c=>`<option value="${esc(c.key)}" ${p.answerKey===c.key?'selected':''}>${esc(c.kind==='fact'?c.label:c.role)}</option>`))
    .concat([`<option value="custom" ${p.answerKey==='custom'?'selected':''}>Eigen tekst…</option>`]).join('');
  let ansExtra='';
  if(p.answerKey==='title'){
    ansExtra = isFilm
      ? `<select id="mb-mode" class="sinput"><option value=":tmdb" ${p.mode!==':text'?'selected':''}>Spelers zoeken de film (TMDB)</option><option value=":text" ${p.mode===':text'?'selected':''}>Open antwoord (jij beoordeelt)</option></select>`
      : `<select id="mb-mode" class="sinput"><option value=":deezer" ${p.mode!==':text'?'selected':''}>Spelers zoeken het nummer (Deezer)</option><option value=":text" ${p.mode===':text'?'selected':''}>Open antwoord (jij beoordeelt)</option></select>`;
  } else if(p.answerKey==='custom'){
    ansExtra=`<input id="mb-custom" class="sinput" placeholder="Het juiste antwoord" value="${esc(p.customAnswer||'')}"><input id="mb-accept" class="sinput" placeholder="Ook goed (komma-gescheiden, optioneel)" value="${esc(p.accept||'')}">`;
  } else {
    ansExtra=`<input id="mb-accept" class="sinput" placeholder="Ook goed (komma-gescheiden, optioneel)" value="${esc(p.accept||'')}"><p class="muted" style="font-size:12px;margin:0">Open antwoord — jij beoordeelt het als host.</p>`;
  }
  const songBlock = !isFilm ? `
    <label class="lbl">Welk stukje van het fragment?</label>
    <div class="row" style="gap:8px;align-items:center">
      <span class="muted">van</span><input type="number" id="mb-start" class="sinput" min="0" max="30" step="1" value="${p.start??0}" style="width:74px;margin:0">
      <span class="muted">tot</span><input type="number" id="mb-end" class="sinput" min="0" max="30" step="1" value="${p.end??''}" style="width:74px;margin:0">
      <span class="muted">sec (leeg = einde)</span>
    </div>` : '';
  // rechterkolom: bron-info + de versleepbare pool (zone 'off')
  const art = isFilm ? p.poster : p.cover;
  const pool = cluesIn(p.clues,'off',p.answerKey);
  const poolRows = pool.map(c=>clueChipHTML(c, null, false)).join('');
  const poolBody = poolRows || ((p.clues&&p.clues.length)
    ? `<div class="cluempty muted">Alles is al ingedeeld bij Info of Hints.</div>`
    : `<div class="cluempty muted">Geen ${isFilm?'film':'nummer'}-info geladen.${isFilm?'<br>Is de TMDB-Worker al opnieuw gedeployd?':''}</div>`);
  const songPlayer = !isFilm && p.preview ? `<audio controls preload="none" src="${esc(p.preview)}" style="width:100%"></audio><p class="muted" style="font-size:12px;margin:0">Speelt <b>alleen op het hostscherm</b>.</p>` : '';
  return `
    <div class="mb-grid">
      <div class="mb-col stack" style="gap:10px">
        <label class="lbl">De vraag</label>
        <input id="mb-prompt" class="sinput" value="${esc(p.prompt||'')}" placeholder="${isFilm?'Welke film?':'Welk nummer is dit?'}" style="margin:0">
        ${songBlock}
        ${dropZoneHTML('info','Info','altijd zichtbaar', p)}
        ${dropZoneHTML('hint','Hints','één voor één (volgorde telt)', p)}
        <label class="lbl">Wat is het antwoord?</label>
        <select id="mb-answer" class="sinput" style="margin:0">${ansOpts}</select>
        ${ansExtra}
        ${opts.roundPickerHTML||''}
      </div>
      <div class="mb-col mb-right stack" style="gap:8px">
        <div class="mb-arthead">${art?`<img src="${esc(art)}" class="mb-art" alt="">`:''}<div class="mb-arttitle">${esc(p.label||'')}</div></div>
        ${songPlayer}
        <p class="muted" style="font-size:12px;margin:0">Sleep een stukje naar <b>Info</b> of <b>Hints</b> ◀</p>
        <div class="czone-drop mb-pool" data-zone="off">${poolBody}</div>
      </div>
    </div>
    <div class="row"><button class="btn grow" id="b-mb-add">${esc(opts.addLabel||'Toevoegen')}</button><button class="btn ghost" id="b-mb-reset">${esc(opts.resetLabel||'Ander item')}</button></div>`;
}
/* wiring: leest de velden + zone-volgorde terug in p; geeft syncFromDOM() terug zodat de
   aanroeper die ook na een sleep (enableDragGroup onDrop) en vóór opslaan kan draaien. */
export function wireMediaBuilder(scope, p, render){
  const $=s=>scope.querySelector(s);
  const read=()=>{
    if($('#mb-prompt')) p.prompt=$('#mb-prompt').value;
    if($('#mb-custom')) p.customAnswer=$('#mb-custom').value;
    if($('#mb-accept')) p.accept=$('#mb-accept').value;
    if($('#mb-start'))  p.start=$('#mb-start').value;
    if($('#mb-end'))    p.end=$('#mb-end').value;
    if($('#mb-answer')) p.answerKey=$('#mb-answer').value;
    if($('#mb-mode'))   p.mode=$('#mb-mode').value;
    scope.querySelectorAll('.mb-name').forEach(cb=>{ const c=p.clues.find(x=>x.id===cb.dataset.id); if(c)c.showName=cb.checked; });
    scope.querySelectorAll('.mb-photo').forEach(cb=>{ const c=p.clues.find(x=>x.id===cb.dataset.id); if(c)c.showPhoto=cb.checked; });
    scope.querySelectorAll('.mb-role').forEach(cb=>{ const c=p.clues.find(x=>x.id===cb.dataset.id); if(c)c.showRole=cb.checked; });
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
    p.clues.forEach(c=>{ if(!seen.has(c)) order.push(c); });   // de antwoord-clue (uit de pool) behoudt zijn plek
    p.clues=order;
  };
  const an=$('#mb-answer'); if(an) an.onchange=()=>{ read(); p.answerKey=an.value; p.clues.forEach(c=>{ if(c.key===p.answerKey) c.zone='off'; }); render(); };  // gekozen antwoord-stukje terug naar de pool
  const md=$('#mb-mode'); if(md) md.onchange=()=>{ read(); p.mode=md.value; render(); };
  scope.querySelectorAll('.mb-name,.mb-photo,.mb-role').forEach(cb=>cb.onchange=()=>{ read(); render(); });   // her-render zodat het voorbeeld de keuze toont
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
