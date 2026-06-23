/* editor-ui.js — gedeelde editor-UI voor de beheerpagina's.
 *
 * Gebruikt door:
 *   - account/quizzes/index.html   (de quiz-editor/-beheerder)
 *   - account/questions/index.html (de persoonlijke vragenbank)
 *
 * Beide pagina's bouwen dezelfde vraagvormen (meerkeuze, open, film, liedje) en delen het
 * film/liedje-zoeken. Wat verschilt is alleen de PLAATSING van een gemaakte vraag
 * (vragenbank vs. een ronde in een quiz) — dat blijft in de pagina zelf. Alles hier is puur:
 * het neemt de paginastate (S) + render() als argument en houdt geen eigen state vast.
 *
 * Belangrijk: dezelfde element-id's en CSS-klassen als voorheen, zodat lib/style.css en
 * lib/drag.js (enableDragGroup) ongewijzigd blijven werken.
 */
import { esc, qLabel, qTypeLabel, answerText,
         tmdbSearch, deezerSearch, movieDetails, movieCast, deezerTrack,
         newFilmPick, newSongPick, mediaBuilderHTML, wireMediaBuilder, buildMediaQuestion,
         popularMoviesHTML } from './quiz-core.js';
import { enableDragGroup } from './drag.js';

/* lijst-regel: het ANTWOORD eerst (zo zie je wélke vraag het is), dan type + vraagtekst */
export function rowText(q){
  const ans=answerText(q), title=ans||qLabel(q), extra=(ans&&q.question)?' · '+q.question:'';
  return `${esc(title)} <span class="muted rowtype">· ${esc(qTypeLabel(q))}${esc(extra)}</span>`;
}

/* optioneel medialink-veld + type-keuze (afbeelding/video/audio) */
export function mediaRowHTML(pfx, d){ d=d||{};
  return `<input id="${pfx}-media" class="sinput" placeholder="Medialink (optioneel): https://…" value="${esc(d.media||'')}">
  <select id="${pfx}-mtype" class="sinput">${['image','video','audio'].map(t=>`<option value="${t}" ${d.mediaType===t?'selected':''}>${t==='image'?'afbeelding':t==='video'?'video':'audio'}</option>`).join('')}</select>`;
}
export function applyMediaToQ(q, url, type){ url=(url||'').trim(); if(!url) return; if(type==='video') q.video=url; else if(type==='audio') q.audio=url; else q.image=url; }

/* ---------- meerkeuze ---------- */
export function readMc(d, $){ const g=id=>{const e=$('#'+id);return e?e.value:undefined;};
  if($('#mc-q')!=null){ d.question=g('mc-q'); d.media=g('mc-media'); d.mediaType=g('mc-mtype'); d.correct=g('mc-correct'); d.distractors=[0,1,2,3,4].map(i=>g('mc-d'+i)).map(x=>x==null?'':x); }
  return d;
}
/* draft → vraag-object (validatie gedeeld; de aanroeper plaatst 'm) → {q,label} of {error} */
export function mcDraftToQuestion(d){
  const correct=(d.correct||'').trim(), dist=(d.distractors||[]).map(x=>(x||'').trim()).filter(Boolean);
  if(!correct) return { error:'Vul het juiste antwoord in.' };
  if(!dist.length) return { error:'Vul minstens één foute optie in (of gebruik "Open vraag").' };
  const q={ question:(d.question||'').trim(), options:[correct,...dist], answer:0, shuffle:true };
  applyMediaToQ(q, d.media, d.mediaType);
  if(!q.question && !q.image && !q.video && !q.audio) return { error:'Geef een vraag of een medialink op.' };
  return { q, label:(q.question||correct) };
}
export function mcFormHTML(d, opts){ d=d||{}; opts=opts||{};
  return `<div class="statusbar"><h1 class="h-sm">${esc(opts.title||'Meerkeuzevraag')}</h1></div>
  <div class="stack edscroll" id="ed-scroll" style="gap:8px">
    <input id="mc-q" class="sinput" placeholder="De vraag (mag leeg bij alleen een medialink)" value="${esc(d.question||'')}">
    ${mediaRowHTML('mc',d)}
    <label class="lbl">Juiste antwoord</label><input id="mc-correct" class="sinput" placeholder="Het juiste antwoord" value="${esc(d.correct||'')}">
    <label class="lbl">Foute opties (minstens 1)</label>
    ${[0,1,2,3,4].map(i=>`<input id="mc-d${i}" class="sinput" placeholder="Foute optie ${i+1}" value="${esc((d.distractors&&d.distractors[i])||'')}">`).join('')}
    <p class="muted hint">De volgorde wordt willekeurig in de quiz.</p>
    ${opts.roundPickerHTML||''}
  </div>
  ${opts.showActions===false ? '' : `<div class="row"><button class="btn grow" id="b-mc-add">${esc(opts.addLabel||'Opslaan')}</button><button class="btn ghost" id="${opts.backId||'b-back'}">Terug</button></div>`}`;
}

/* ---------- open vraag ---------- */
export function readOpen(d, $){ const g=id=>{const e=$('#'+id);return e?e.value:undefined;};
  if($('#op-q')!=null){ d.question=g('op-q'); d.media=g('op-media'); d.mediaType=g('op-mtype'); d.answer=g('op-ans'); d.accept=g('op-accept'); }
  return d;
}
export function openDraftToQuestion(d){
  const ans=(d.answer||'').trim();
  if(!ans) return { error:'Vul het juiste antwoord in.' };
  const accept=(d.accept||'').split(',').map(x=>x.trim()).filter(Boolean);
  const q={ question:(d.question||'').trim(), options:':text', answer:ans, accept };
  applyMediaToQ(q, d.media, d.mediaType);
  if(!q.question && !q.image && !q.video && !q.audio) return { error:'Geef een vraag of een medialink op.' };
  return { q, label:(q.question||ans) };
}
export function openFormHTML(d, opts){ d=d||{}; opts=opts||{};
  return `<div class="statusbar"><h1 class="h-sm">${esc(opts.title||'Open vraag')}</h1></div>
  <div class="stack edscroll" id="ed-scroll" style="gap:8px">
    <input id="op-q" class="sinput" placeholder="De vraag (mag leeg bij alleen een medialink)" value="${esc(d.question||'')}">
    ${mediaRowHTML('op',d)}
    <label class="lbl">Juiste antwoord</label><input id="op-ans" class="sinput" placeholder="Het juiste antwoord" value="${esc(d.answer||'')}">
    <label class="lbl">Ook goed (komma-gescheiden, optioneel)</label><input id="op-accept" class="sinput" placeholder="bv. variant 1, variant 2" value="${esc(d.accept||'')}">
    <p class="muted hint">Open antwoorden beoordeel je als host handmatig.</p>
    ${opts.roundPickerHTML||''}
  </div>
  ${opts.showActions===false ? '' : `<div class="row"><button class="btn grow" id="b-op-add">${esc(opts.addLabel||'Opslaan')}</button><button class="btn ghost" id="${opts.backId||'b-back'}">Terug</button></div>`}`;
}

/* ---------- film / liedje (delen één bouwer, zie quiz-core.js) ---------- */
/* zoek-acties die op de paginastate werken; veldnamen zijn in beide pagina's gelijk */
export function makeMediaActions(S, render){
  async function filmSearch(){ const e=document.querySelector('#film-q'); const q=e?e.value.trim():''; S.filmQuery=q; if(!q){ S.filmResults=[]; render(); return; } S.filmBusy=true; render(); try{ S.filmResults=await tmdbSearch(q); }catch(err){ S.filmResults=[]; S.err='Zoeken mislukt: '+err.message; } S.filmBusy=false; render(); }
  async function filmPick(id,label){ S.filmBusy=true; S.filmResults=[]; S.filmQuery=''; render(); let d=await movieDetails(id); if(!d){ const cast=await movieCast(id,10); d={ id, title:label, cast, genres:[] }; }  /* val terug op alleen-cast als type=details nog niet gedeployd is */ S.filmPick=newFilmPick(d); S.filmBusy=false; render(); }
  async function songSearch(){ const e=document.querySelector('#song-q'); const q=e?e.value.trim():''; S.songQuery=q; if(!q){ S.songResults=[]; render(); return; } S.songBusy=true; render(); try{ S.songResults=await deezerSearch(q); }catch(err){ S.songResults=[]; S.err='Zoeken mislukt: '+err.message; } S.songBusy=false; render(); }
  async function songPickTrack(i){ const t=S.songResults[i]; if(!t)return; if(!t.preview){ S.err='Geen fragment beschikbaar voor dit nummer.'; render(); return; } S.songBusy=true; render(); const det=await deezerTrack(t.id); S.songPick=newSongPick(t, det); S.songResults=[]; S.songQuery=''; S.songBusy=false; S.err=''; render(); }
  return { filmSearch, filmPick, songSearch, songPickTrack };
}
export function filmFormHTML(S, opts){ opts=opts||{};
  if(S.filmPick){
    const title=(opts.editing?'Film wijzigen':'Film')+': '+esc(S.filmPick.label);
    return `<div class="statusbar"><h1 class="h-sm">${title}</h1></div>`
      + mediaBuilderHTML(S.filmPick, { addLabel:opts.addLabel||'Opslaan', resetLabel:'Andere film', roundPickerHTML:opts.roundPickerHTML, hideAdd:opts.hideAdd });
  }
  const res=S.filmResults||[];
  return `<div class="statusbar"><h1 class="h-sm">Film</h1></div>
    <div class="row" style="gap:6px"><input id="film-q" class="sinput grow" placeholder="Zoek een film…" value="${esc(S.filmQuery||'')}"><button class="btn" id="b-film-search">Zoek</button></div>
    ${S.filmBusy?'<p class="muted center" style="margin:0">Bezig…</p>':''}
    <div class="stack edscroll" id="ed-scroll" style="gap:4px">${res.map(m=>`<button class="btn ghost searchbtn" data-film="${esc(m.id)}|${esc(m.label)}">${m.thumb?`<img src="${esc(m.thumb)}" class="searchthumb film">`:''}${esc(m.label)}</button>`).join('')}</div>
    ${popularMoviesHTML()}
    <div class="row"><button class="btn ghost" id="${opts.backId||'b-back'}">Terug</button></div>`;
}
export function songFormHTML(S, opts){ opts=opts||{};
  if(S.songPick){
    const title=(opts.editing?'Liedje wijzigen':'Liedje')+': '+esc(S.songPick.label);
    return `<div class="statusbar"><h1 class="h-sm">${title}</h1></div>`
      + mediaBuilderHTML(S.songPick, { addLabel:opts.addLabel||'Opslaan', resetLabel:'Ander nummer', roundPickerHTML:opts.roundPickerHTML, hideAdd:opts.hideAdd });
  }
  const res=S.songResults||[];
  return `<div class="statusbar"><h1 class="h-sm">Liedje (fragment afspelen)</h1></div>
    <div class="row" style="gap:6px"><input id="song-q" class="sinput grow" placeholder="Zoek een nummer…" value="${esc(S.songQuery||'')}"><button class="btn" id="b-song-search">Zoek</button></div>
    ${S.songBusy?'<p class="muted center" style="margin:0">Bezig…</p>':''}
    <div class="stack edscroll" id="ed-scroll" style="gap:4px">${res.map((t,i)=>`<button class="btn ghost searchbtn" data-song="${i}">${t.thumb?`<img src="${esc(t.thumb)}" class="searchthumb song">`:''}${esc(t.label)}${t.preview?'':' — <span class="muted">geen fragment</span>'}</button>`).join('')}</div>
    <div class="row"><button class="btn ghost" id="${opts.backId||'b-back'}">Terug</button></div>`;
}
/* de huidige film/song-pick → vraag-object (validatie gedeeld; de aanroeper plaatst 'm) */
export function readMediaPick(S){
  const p = S.view==='film' ? S.filmPick : S.songPick;
  if(!p) return { error:'Kies eerst een film of nummer.' };
  const { q, error } = buildMediaQuestion(p);
  if(error) return { error };
  return { p, q, isFilm:p.kind==='film', label:(q.source&&q.source.label)||p.label };
}
/* events binden voor de film/song-views (zowel zoek- als bouwer-fase). opts:
   { onAdd, onBack, backId, afterBuilderWire } — afterBuilderWire is voor de ronde-kiezer (quizzes).
   Geeft de builder-sync terug (of null) zodat een top-bar-opslaan ook eerst kan syncen. */
export function wireMediaForms(el, S, render, actions, opts){
  opts=opts||{};
  const v=S.view, pick = v==='film' ? S.filmPick : S.songPick;
  let sync=null;
  if(pick){
    sync = wireMediaBuilder(el, pick, render);
    enableDragGroup(Array.from(el.querySelectorAll('[data-zone]')), { handle:'.grip', onDrop:()=>{ sync(); render(); } });
    if(opts.afterBuilderWire) opts.afterBuilderWire();
    const add=el.querySelector('#b-mb-add'); if(add)add.onclick=()=>{ sync(); opts.onAdd&&opts.onAdd(); };
    const rs=el.querySelector('#b-mb-reset'); if(rs)rs.onclick=()=>{ if(v==='film') S.filmPick=null; else S.songPick=null; S.err=''; render(); };
  } else if(v==='film'){
    const s=el.querySelector('#b-film-search'); if(s)s.onclick=actions.filmSearch;
    const fq=el.querySelector('#film-q'); if(fq)fq.onkeydown=e=>{ if(e.key==='Enter'){ e.preventDefault(); actions.filmSearch(); } };
    el.querySelectorAll('[data-film]').forEach(b=>b.onclick=()=>{ const val=b.dataset.film, i=val.indexOf('|'); actions.filmPick(val.slice(0,i), val.slice(i+1)); });
    el.querySelectorAll('.pmovie').forEach(b=>b.onclick=()=>actions.filmPick(b.dataset.pid, b.dataset.plabel));
  } else {
    const s=el.querySelector('#b-song-search'); if(s)s.onclick=actions.songSearch;
    const sq=el.querySelector('#song-q'); if(sq)sq.onkeydown=e=>{ if(e.key==='Enter'){ e.preventDefault(); actions.songSearch(); } };
    el.querySelectorAll('[data-song]').forEach(b=>b.onclick=()=>actions.songPickTrack(+b.dataset.song));
  }
  const back=el.querySelector('#'+(opts.backId||'b-back')); if(back && opts.onBack) back.onclick=opts.onBack;
  return sync;
}

/* gedeelde top-bar voor de maak-/bewerk-pagina's: links 'terug zonder opslaan' + 'Opslaan'.
   Knoppen worden via hun id (backId/saveId) door de pagina bedraad. showSave=false verbergt opslaan. */
export function editorTopbarHTML(opts){
  opts=opts||{};
  const save = opts.showSave===false ? ''
    : `<button type="button" class="btn sm" id="${opts.saveId||'b-save'}">${esc(opts.saveLabel||'Opslaan')}</button>`;
  return `<div class="topbar"><span class="tb-actions">
      <button type="button" class="tb-round nolink" id="${opts.backId||'b-topback'}">${esc(opts.backLabel||'← Terug zonder opslaan')}</button>
      ${save}
    </span></div>`;
}

/* gedeelde scroll-restore voor de #ed-scroll-lijst (overflow/hoogte zit in .edscroll) */
export function wireScroll($, S){ const sc=$('#ed-scroll'); if(sc){ sc.scrollTop=S.scroll||0; sc.onscroll=()=>{ S.scroll=sc.scrollTop; }; } }
