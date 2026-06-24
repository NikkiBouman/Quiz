# Quizshow — Architecture & Onboarding

A single-file, browser-based multiplayer party quiz (Jackbox/Kahoot-style).
One **host** drives a big screen; **players** join from their phones with a 4-letter room
code; an optional **controller/jury** can mark answers right/wrong. There are no timers —
the host paces everything manually.

This document is the source of truth for how the app works. It is written so that any
developer or AI picking up the project mid-stream can be productive immediately. Keep it in
sync with `index.html` when behaviour changes.

> **Language note:** all user-facing strings are in **Dutch**. Code, identifiers and this
> document are in English. The maintainer (Nikki) writes Dutch but discusses technical
> topics in English.

---

## 1. What it is, at a glance

- **The game** is one HTML file (`index.html`): host view, player view, controller view, all
  gameplay JS (vanilla, ES modules, no build step). It imports one thing — `takeActiveQuiz` —
  from the shared module.
- **Two manager pages** sit under `account/`: `account/quizzes/` (build/edit/use a quiz) and
  `account/questions/` (a personal question bank). They share `lib/quiz-core.js` (the quiz
  pipeline + catalog + TMDB + localStorage), `lib/editor-ui.js` (their shared UI) and
  `lib/style.css`. The old `quizzes.html`/`questions.html` are redirect stubs. See §22.
- **Firebase Realtime Database (RTDB)** is the only backend, and only the *game* uses it. All
  shared game state lives under `games/{CODE}`; clients subscribe with `onValue`. The manager
  pages are backend-free — quizzes/questions live in **localStorage (per device)**.
- **GitHub Pages** hosts the static files. Repo: `https://github.com/NikkiBouman/Quiz`,
  served at `https://nikkibouman.github.io/Quiz/`.
- **Question content**: a host either picks a saved quiz (built on `account/quizzes/` from the
  self-describing media library, §22), loads a JSON file, or falls back to the built-in
  `SAMPLE`. `questions.json` is a legacy loadable set.
- **Media** is **link-based** (URLs / repo-relative paths). The committed library media
  (`bandle/`, `puzzle/`) resolves repo-served; actor photos come live from TMDB.
  The old "load a local folder" path is gone. See §9.

---

## 2. Tech stack & deployment

| Concern        | Choice |
|----------------|--------|
| Frontend       | Vanilla JS, native ES modules (each page has one `<script type="module">`; shared code in `lib/quiz-core.js`) |
| State sync     | Firebase RTDB (`firebase-app` + `firebase-database` v12.14.0 from gstatic CDN) — game only |
| Hosting        | GitHub Pages (static) |
| Movie search / cast | TMDB via the Worker proxy (`/search`, `?type=credits`); see §16 |
| Song search    | Deezer API via JSONP (`/search`, `output=jsonp`) |
| Fonts          | Google Fonts (preconnected) |

No bundler, no transpiler, no npm runtime dependency. Edit a file, push, done. Because the
pages use native ES module imports, they must be served over http (GitHub Pages, or a local
`python3 -m http.server`) — opening via `file://` breaks the imports.

---

## 3. File layout

```
index.html                      # the GAME: host/player/controller, Firebase sync, gameplay (repo root)
account/index.html              # account landing — links to the two managers
account/quizzes/index.html      # quiz LIST (saved quizzes; use/edit/export/delete) — see §22
account/quizzes/new/index.html  # quiz EDITOR (new, or ?edit=<name>); top-bar opslaan/terug
account/questions/index.html    # question bank LIST (edit/delete) — see §22
account/questions/new/index.html# question CREATOR/EDITOR (?type=custom|film|song, or ?edit=<i>)
quizzes.html, questions.html    # thin redirect stubs → account/quizzes/ , account/questions/ (old URLs)
lib/quiz-core.js  # shared ES module: quiz pipeline + catalog + TMDB + localStorage + navMenuHTML
lib/editor-ui.js  # shared ES module: the manager-page UI (forms, media search, wiring) — see §22
lib/drag.js       # drag helpers: enableDragSort (single list) + enableDragGroup (cross-zone)
lib/style.css     # shared stylesheet (linked by every HTML page)
library.json      # catalog index of round folders (see §22)
questions.json    # a legacy loadable question set (round-structured; see §7)
ARCHITECTURE.md   # this file
```

All HTML pages are plain static files (GitHub Pages, no build step). `index.html` stays at the
repo root (it's the host/share URL, and stored media paths like `bandle/…/x.m4a` resolve relative
to it); it imports only `takeActiveQuiz` from `lib/quiz-core.js`. The two manager pages live under
`account/` and import the full core plus `lib/editor-ui.js`; they reference shared code with
`../../lib/…`. **Path resolution:** `loadCatalog()` fetches `library.json` + each `<folder>/round.json`
relative to the repo root via `new URL('…', import.meta.url)` (exported as `ROOT`), so the catalog
loads correctly from `account/quizzes/` *and* the root, and stays base-path-safe on GitHub Pages
(`/Quiz/…`). Media folders (`bandle/`, `puzzle/`) live at the repo root.

**Note:** the quiz pipeline (`flattenQuiz`/`normalizeQuiz`/`applyShuffles`/…) still exists both
inline in `index.html` (the game's own copy) and in `lib/quiz-core.js` (for the pages); the two
are kept logic-identical. De-duplicating `index.html` to import them is a possible future cleanup.

---

## 4. Roles & device model

Three roles, all rendered from the same file, chosen at runtime:

- **host** — created via `hostCreate()`. Owns the game: writes the authoritative `state`,
  paces questions, reveals answers, can mark answers, can skip. Renders on a big screen.
  Has the loaded media in memory.
- **player** — joins via `playerJoin()` with the 4-letter code. Submits answers/bets from
  a phone. Reads `state`, writes only its own `players/{pid}` node.
- **controller / jury** — joins only via a secret **host link** (`?judge=CODE&t=TOKEN`).
  Sees all answers and can override right/wrong, and can view/edit bets before a question.
  Cannot be reached with the plain code.

Key mechanical truth: **the host is the only writer of `state`.** Players and the controller
write only into their own / scoped sub-nodes. The host reconciles everything.

---

## 5. Firebase RTDB structure

All under `games/{CODE}` (CODE = 4 uppercase letters). Test-mode rules (open read/write).

```
games/{CODE}/
  state/                     # authoritative public snapshot, written by host via pushState()
    phase                    # 'lobby' | 'roundintro' | 'question' | 'reveal' | 'final'
    round                    # flat question index (0-based) — NB: "round" here = question idx
    totalRounds              # app.quiz.length (flat question count) — legacy name
    rc                       # round context for current question (see roundCtx) or null
    stage                    # current hint stage index (staged questions)
    betStep                  # 'bet' | 'reveal' | 'play' | null  (betting sub-step)
    checked                  # host has run the correctness check this stage
    current                  # publicCurrent(): question payload for players (or null)
    scores, names            # maps pid -> number / pid -> string
    results                  # per-player result map, only during 'reveal'
    judged                   # map pid -> bool (controller/host overrides, flattened)
    bets                     # map pid -> bet index (for display)
    answeredCount, totalPlayers, ts
  players/{pid}/
    id, name
    ans/{round}              # the player's answer (index | api-id | string)
    anslabel/{round}         # human-readable label of that answer
    astage/{round}           # the stage at which they locked in (for bet/points-by-stage)
    bet/{round}              # bet = stage index they wagered on
    pass/{round}             # true if they passed
    ready/{roundIdx}         # true if they tapped "Ik snap het" on a round intro
  quiz                       # the FLATTENED, normalized question array (for resume)
  rounds                     # round metadata: [{name,intro,start,end}, ...]
  judge/{round}/{pid}        # manual verdicts store (true/false)
  judgeToken                 # secret string gating the controller link
```

Notes:
- `quiz` is stored **flat** (already normalized). `rounds` holds the round boundaries.
  On resume both are read back. See §7/§8.
- `judge` (verdict store) and `judged` (flattened booleans in `state`) are different things:
  `judge` is the raw per-round/per-player override; `judged` is the computed result pushed
  for display.

---

## 6. The `app` state object

A single module-scoped object holds all local state. Fields (current):

```js
role, code,
phase, round, scores, names, players, answeredCount, results,
quiz, rounds, quizName, quizErr, stage, betStep, checked, mediaCount, mediaWarn,
pid, name, ans, bet, passed, confirmPass, submittedRound, sel, game,
searchText, searchResults, searchPick, searchBusy, searchRound, _sTimer, searchOpen, textAns,
wrongGuesses, lastSubmitLabel, readyRounds,
myStage, reguess, forFun,
unsubPlayers, unsubState, unsubMe, unsubJudges, kicked,
judges, preRoundScores,
openPicker, confirmKick, confirmSkip,
```

Highlights:
- `app.quiz` — flat, normalized array of questions (the working set).
- `app.rounds` — `[{name, intro, start, end}]`; `start`/`end` are flat indices (half-open).
- `app.round` — index into `app.quiz` of the **current question** (misleadingly named).
- `app.stage` — current hint stage (staged questions).
- `app.betStep` — betting sub-step machine: `'bet' → 'reveal' → 'play'`.
- `app.checked` — whether the host has run correctness checking for the current stage.
- `app.game` — on **player/controller** side, the latest `state` snapshot from Firebase.
- `app.readyRounds` — local record of which round intros this player acknowledged.
- `app.preRoundScores` — score snapshot before the current question, for recomputation.
- `unsub*` — Firebase listener unsubscribe handles.

---

## 7. Question set format (authoring)

The loaded JSON may be **flat** (a plain array of questions) or **round-structured**.
Both are accepted; `flattenQuiz()` collapses them.

### Round-structured (preferred)

```json
{
  "rounds": [
    {
      "name": "Wie of wat is dit?",
      "intro": "Raad de figuur uit de stukjes…",
      "questions": [ /* question objects */ ]
    },
    { "name": "Bandle", "intro": "Raad het liedje…", "questions": [ … ] }
  ]
}
```

`flattenQuiz` concatenates all `questions` into one flat list and records each round's
`{name, intro, start, end}` (flat index range). A flat array is treated as a single
nameless round spanning everything.

### A question object

Fields (most are optional; `normalizeQuiz` fills in the rest):

| Field         | Meaning |
|---------------|---------|
| `question`    | Prompt text shown to everyone. |
| `options`     | Controls the answer mode (see below). Array, or a string sentinel. |
| `search`      | `true` + array `options` → autocomplete field instead of tiles. |
| `answer`      | Correct answer: index (list/listsearch), API id (tmdb/deezer), string (text), or an **array** of acceptable ids/indices ("any of these"). |
| `answerLabel` | Human-readable correct answer (auto-derived for list/listsearch/text). |
| `accept`      | For `:text`: array of additional acceptable strings (spelling variants). |
| `image`       | Single-shot image path (non-staged questions). |
| `audio`       | Host-only audio for a non-staged question (e.g. a Deezer `preview` URL). **Never sent to players** (`publicCurrent` omits it); only the host machine plays it. |
| `clipStart` / `clipEnd` | Optional seconds — play only this window of the `audio`. Works on a top-level `audio` *or* a stage's `audio`. Enforced host-side by `wireClips()` (seek to start, pause at end). Used by song questions (Deezer previews are a fixed ~30s, so this clips *within* that snippet). |
| `answerImage` | Image shown on the **reveal** screen (e.g. a puzzle's `full.*` composite). Resolved like any media; sent to players via `publicCurrent` only at reveal. Film questions set this to the poster. |
| `facts`       | **Info-subkop** (always-visible context): array of `{label, value}` (text pill), `{label, image}` (small photo), `{label, video}` (inline clip, sent to players), or `{label, audio}` (**host-only** — `publicCurrent` strips the src, players see a "🔊" pill). Rendered by `factsHTML(r, isHost)` on host + player; forwarded by `publicCurrent` in **all** phases (it's context, never the answer — the builder excludes the answer). Produced by the **Info** zone of the media builder *and* the custom builder (§22). |
| `source`      | Host-only builder metadata for film/song questions: `{kind:'tmdb'\|'deezer', id, label, clues:[…], preview?}`. Lets the question bank re-open the builder **losslessly** (zones + per-actor naam/foto toggles). Ignored by the game and **not** sent to players (`publicCurrent` omits it). Also makes `qTypeLabel` report film/lied even when the answer is a fact. |
| `stages`      | Array of progressive hints — presence makes the question "staged" (see below). |
| `bet`         | Optional explicit betting toggle (boolean). When set it wins over the `betMultiplier` heuristic; when absent, betting is derived from whether any stage has a `betMultiplier`. Only meaningful for staged questions. |
| `points`      | Base points (default 100). Editable per question in the quiz editor (number field); for betting questions this is the base that the multiplier scales. |
| `pointsByStage` | Non-betting staged questions: points per stage (decreasing reward for later reveals). |
| `year`, `views`, `par` | Bandle metadata; auto-parsed from the audio folder name if absent. |

### `optionsMode` (derived by `normalizeQuiz`)

| `options` value           | `optionsMode` | UI |
|---------------------------|---------------|----|
| array                     | `list`        | Tappable shape tiles (▲◆●■). `answer` = index. |
| array + `"search": true`  | `listsearch`  | Autocomplete text field over the list. `answer` = index. |
| `":tmdb"`                  | `tmdb`        | Live TMDB movie search. `answer` = TMDB movie id (or array). |
| `":deezer"`               | `deezer`      | Live Deezer **track** search ("Artist – Title"). `answer` = Deezer track id. (Title **+** artist answer = exact song.) |
| `":deezer-title"`         | `deezertitle` | Deezer track search showing **only titles** (deduped). **Text-matched** (`answer` = title string, like `:text`). (Title-only answer.) |
| `":deezer-album"`         | `deezeralbum` | Live Deezer **album** search. `answer` = Deezer album id. (Album-as-answer.) |
| `":deezer-artist"`        | `deezerartist`| Live Deezer **artist** search. `answer` = Deezer artist id. (Artist-as-answer.) |
| `":text"`                 | `text`        | Free text; **manually judged**. `answer` = string; `accept[]` for variants. |

### Stages (`stages[]`) — progressive hints

Each stage object: `{ text?, image?, audio?, label?, betMultiplier?, clipStart?, clipEnd? }`. The
presence of a field decides the stage kind (`audio` > `image` > `text`). `label` is an optional
caption. `clipStart`/`clipEnd` (seconds) clip an `audio` stage host-side (see `wireClips`).

- **Betting is optional.** A staged question is a **betting** question when `bet` is explicitly
  `true`, or — if `bet` is unset — when any stage has a `betMultiplier`. Setting `bet:false`
  turns betting off even if multipliers are present. On a betting question the host reveals hints
  one at a time and players wager on which hint they'll know the answer by, with higher
  multipliers for earlier (riskier) bets. `out.betMultipliers` is the per-stage multiplier array
  (any missing entry is filled from `defaultBetMults`). The quiz editor exposes this as a per-round
  and per-question **"inzet"** checkbox (the round box toggles all its staged questions).
- If a staged question is **not** betting but has `pointsByStage` → reward decreases with each
  revealed hint; otherwise it scores flat `points`.
- **Audio stages are host-only**: audio paths are never sent to players (`publicCurrent`
  omits them); only the host machine plays sound. Images *are* sent to players as data-URIs.

### Bandle metadata auto-parse

For a stage with `audio`, `normalizeQuiz` reads the parent folder name and matches
`(YYYY_<views>_par-N)`, e.g. `Coldplay-Fix_You_(2005_725M_par-3)/1` → `year=2005`,
`views="725M"`, `par=3`. Shown via `metaHTML()`.

### Current `questions.json` content (legacy demo set)

A small flat trivia/hint set used only as a loadable example: two plain MC questions, a
`pointsByStage` hint question, a betting hint question, and one `:deezer` bandle question.
There are **no `:tmdb` film questions** here anymore — film/actor questions are created only via
the film builder (§22), which pulls cast live from TMDB. (The built-in `SAMPLE` in `index.html`
is likewise film-`:tmdb`-free.)

---

## 8. Normalization & validation pipeline

```
raw JSON ──flattenQuiz──▶ { questions[], rounds[] }
                              │
            validateQuiz(raw) │  (validates round shape, then validateQuestions on flat list)
                              ▼
        normalizeQuiz(questions) ──▶ app.quiz   (optionsMode/betting/labels/points filled in)
                                     app.rounds  (round metadata)
```

- **`flattenQuiz(data)`** → `{questions, rounds}`. Handles both shapes.
- **`validateQuiz(raw)`** → error string or `null`. If `{rounds}`, checks each round has
  questions, then runs `validateQuestions` on the flattened list.
- **`normalizeQuiz(arr)`** → derives `optionsMode`, `betting`, `betMultipliers`, parses
  bandle metadata, derives `answerLabel`, defaults `points=100`, normalizes stages via
  `normStage`. **Idempotent enough for resume** (recognizes already-normalized `optionsMode`).
- **`normStage(s)`** → canonical stage object; also accepts a legacy `{type, display}` form.

`setQuiz(data, name)` applies a freshly loaded set: flatten → normalize → store
`app.quiz`/`app.rounds` → `applyAudioLabels()` → push `quiz` + `rounds` to Firebase. It does
**not** touch round/phase/score, so it is safe to call mid-game (used by media reload, §15).

---

## 9. Media system (read this carefully)

> **Update:** media is now **link-based**. The "load a local folder" UI was removed; media is
> referenced by URL or repo-relative path and resolves as a plain URL. `loadFolder`/`mediaMap`/
> the fuzzy `resolveMediaKey` matching below still exist in `index.html` but are **dead code**
> (no UI triggers them) — kept for now, safe to delete. The committed library (`bandle/`,
> `puzzle/`) is repo-served; custom content uses absolute URLs; actor photos come
> from TMDB's image CDN.

Media is referenced in the JSON by **relative path** (e.g. `puzzle/Simba/1`,
`bandle/Coldplay-Fix_You_(2005_725M_par-3)/1`) or an absolute URL. Historically there were two
ways the host could supply it:

1. ~~**Local folder load ("Map laden").**~~ *(removed)* The host picked a folder; `loadFolder()`
   read every file into an in-memory `mediaMap` (`path → data-URI`), per-tab only.
2. **Repo-served / link.** Media committed in the repo at the same relative path (or any absolute
   URL) resolves directly — works on any device with no loading. **This is now the only path.**

### Resolution

- `resolveMedia(p)` → `resolveMediaKey(p)` looks up `mediaMap`; if found returns the data-URI,
  otherwise returns the original path `p` (so repo-served media still resolves as a URL).
- `resolveMediaKey` is fuzzy on purpose: exact key → path-suffix → basename → loose match
  (same parent folder via `folderKey`, which strips `(parenthetical metadata)` and
  non-alphanumerics, plus a matching leading token like `1`/`full`) → single-candidate fuzzy
  fallback (tolerates band-name typos). This lets the JSON say `.../1` and match `1-drums.m4a`.
- `labelFromFile()` derives instrument labels ("Drums", "Electric Guitar") from audio
  filenames; `applyAudioLabels()` bakes them into **audio** stage labels only (never image
  stages, so movie actors aren't spoiled).
- `loadFolder` skips obvious non-media (`SKIP_RE`: dotfiles, `.json/.txt/.md/.html/...`),
  and applies a per-type size cap (audio 40 MB host-only, else 12 MB).

### The cross-device gotcha (now mostly moot)

This used to bite hard: `mediaMap` was per-tab memory, so a resumed game on a second device had
broken images. With **link-based media** that's gone — every `src` is a URL (repo-relative or
absolute) that resolves on any device. Just make sure custom content uses URLs that are reachable
everywhere (don't paste a `localhost`/private link), and keep committed library media in the repo.

---

## 10. Game lifecycle & phases

```
lobby ──hostStart──▶ roundintro ──hostBeginRound──▶ question ──hostReveal──▶ reveal
                          ▲                              │                      │
                          │                              │ hostSkip (no points) │ hostNext
                          └───── (new round start) ──────┴──────────────────────┘
                                                                                 │
                                                          (after last question) ▼
                                                                              final
```

- **`roundintro`** — shown before the first question of each round. Host sees the round name,
  intro text, "X/Y klaar" and a **Begin ronde** button. Players see the intro and tap
  **Ik snap het 👍** (`playerReady` → writes `players/{pid}/ready/{roundIdx}`). The
  controller sees the intro read-only. Acknowledgement is **non-blocking** (host starts when
  ready). `hostNext` routes into `roundintro` whenever the next flat index is a round start
  (`isRoundStart`).
- **`question`** — the active question. For **staged** questions the host reveals hints one
  at a time (`hostNextHint`: `stage++`, `checked=false`). For **betting** questions there is a
  sub-step machine in `app.betStep`:
  - `'bet'` — players place wagers; **bets are hidden** in the host status table until the
    host taps **"Toon de inzetten"**.
  - `'reveal'` — bets revealed (`hostRevealBets`).
  - `'play'` — hints play out; the host runs `hostCheck` per stage; `hostNextHint` advances.
- **`reveal`** — `hostReveal` calls `buildResults()` and shows the answer + per-player
  outcome. For non-multiple-choice questions, players also see an **"Alle gokken"** recap of
  everyone's guess (`allGuessesHTML`). Host can still toggle verdicts here.
- **`final`** — `hostFinal()` shows the podium/leaderboard.

### Navigation functions

- `hostStart` → first round intro. `hostBeginRound` → start the round's questions.
- `hostNext` → next flat question, or a round intro at a boundary, or `final` at the end.
- `hostSkip` → **same jump as `hostNext` but with no scoring** (nobody gets points).
  Has an inline confirm (`app.confirmSkip`). Available on all three host question screens.
- `hostCheck` / `hostNextHint` / `hostStartPlay` / `hostRevealBets` drive the staged/betting
  sub-flow.

---

## 11. Scoring

- **`isCorrectAns(r, a)`** — automatic correctness (handles array answers = "any of these",
  text via `normTxt`/`accept`, list index match, api-id match).
- **`effectiveCorrect(round, pid, auto)`** — applies controller/host manual overrides from
  `app.judges` on top of `auto`.
- **`computeGain(r, correct, bet, lock)`**:
  - betting: win only if `bet != null && lock <= bet` (you knew it by the hint you wagered);
    gain = `round(points * betMultipliers[bet])`.
  - `pointsByStage`: gain = `pointsByStage[lock]`.
  - otherwise flat `points` (default 100).
- **`buildResults()`** — for each player computes `{answer,label,autoCorrect,correct,gained,
  won,bet,lock,passed}` and recomputes `scores[pid] = preRoundScores[pid] + gained`. Always
  rebuilt from `preRoundScores`, so re-judging is idempotent.

`lock` is the player's `astage[round]` (the stage they locked their answer at). `preRoundScores`
is snapshotted in `initQuestion`, enabling clean recomputation when verdicts change.

---

## 12. Views & rendering

Dispatchers route on `app.phase` (host) / `app.game.phase` (player) / state (controller):

- **`renderHost`** → `hostLobby | hostRoundIntro | hostQuestion | hostRevealView | hostFinal`.
  Adds `.wide` layout only for `question`.
- **`renderPlayer`** → `playerLobby | playerRoundIntro | playerQuestion | playerReveal | …`
  plus pass/wait/hold states.
- **`renderController`** → roundintro (read-only), bet view (see/edit bets during
  `betStep ∈ {bet, reveal}`), or judging view (toggle right/wrong).

Shared building blocks: `hostHead(right, skip)` (top bar: round name + "vraag X/Y" left,
status pill + optional **Vraag overslaan** right), `hostAside()` (player status table +
media bar), `playerRowsHTML(mode)`, `metaHTML`, `stageHintLabels`/`hintLabelsHTML`, `allGuessesHTML`,
`leaderboardHTML`/`podiumHTML`, `pRoundLbl()` (player round label).

### Player status table (`playerRowsHTML`)

Columns: **Speler · Status · [Inzet] · Punten**.
- The **Inzet** column is shown **only for betting questions** (grid switches to 3 cols via
  `.ptable.noinzet`).
- During `betStep === 'bet'` bets render as **"✓ ingezet"** (hidden) and only reveal the
  actual "uiterlijk hint X" after **"Toon de inzetten"** — so nobody can react to a wager.
- The kick (✕) control is **lobby-only**; it is removed from the in-game status table. The
  controller still sees the fout-✗ verdict button.

---

## 13. State synchronization

- **`pushState()`** (host only) serializes the public snapshot to `state` (see §5). Includes
  `rc: roundCtx(app.round)` for the current question and `current: publicCurrent()`.
- **`publicCurrent()`** builds the player-facing question payload: resolves image media to
  data-URIs, **omits audio paths**, only includes stages up to `app.stage` (or all on
  reveal), and adds `answer`/`answerLabel` only during `reveal`.
- **Listeners** (`startHost` / `startPlayer`):
  - Host subscribes to `players` (recompute `answeredCount`, rebuild results on reveal,
    re-push, re-render) and `judge` (re-judge on overrides).
  - Player subscribes to `state` (their whole world) and to their own `players/{pid}` node.
- **`roundCtx(i)`** maps a flat index to `{ri, name, intro, qIn, qCount, roundCount, start,
  end}`. `isRoundStart(i)` is true at a round's first flat index.

---

## 14. Controller / jury role

- The host generates `judgeToken` (`genToken`) at game creation and stores it at
  `games/{CODE}/judgeToken`. The lobby shows a **"Jurylid-link"** card with a copy button.
- `ctrlLinkFor(code, token)` builds `…/?judge=CODE&t=TOKEN`.
- `boot()` parses the URL; `controllerJoin(code, token)` validates the token against RTDB and
  returns `'ok' | 'nogame' | 'badtoken'`. The plain room code **cannot** become a controller.
- The controller reads `quiz` + `rounds` on join, then renders from live `state`:
  - **bet phase**: lists each player's bet and lets the controller set/correct it
    (`ctrlSetBet` → `players/{pid}/bet/{round}`) before the question is played.
  - **judging**: toggles right/wrong (`ctrlToggle` → `setJudge`), reflected immediately in
    scores via the host's `judge` listener.

---

## 15. Cross-device host resume

Because all shared state is in Firebase, a host can move to another device.

- **From the device that created the game:** Home shows a **"Hervat quiz ABCD"** shortcut
  (the code is remembered in that browser's `localStorage` via `remember`/`recall`).
- **From any other device:** Home → **"Hervatten als host met een code"** → enter the same
  code → `hostResume(code)`.
- **`hostResume`** reads back `state` (phase/round/stage/betStep/checked/scores/names/results),
  `judge`, `judgeToken`, `quiz`, `rounds`, reconstructs `preRoundScores`, re-attaches host
  listeners, and renders. Progress is fully restored.
- **Media just works on resume** now that it's link-based (§9): images/video are URLs in `state`,
  so a resumed game on any device shows them with nothing to re-attach. (Audio stays host-only and
  also resolves by URL.)
- **Do not run two host tabs at once.** Both would write `state` on every action
  (last-write-wins) and conflict. Hand off; don't parallelize. Players stay connected through
  the handoff (their listeners are on the same nodes).

### Refresh survival (per-tab session)

A page **refresh** must not kick you out of a running game — for **host or player** alike (the
controller was always refresh-safe because it reconnects from its `?judge=CODE&t=TOKEN` URL).

- On join/create the app writes a tiny reconnect record to **`sessionStorage`** (`quizSession`):
  `{role:'host', code}` or `{role:'player', code, pid, name}` (`saveSession`). sessionStorage is
  **per-tab**: it survives a refresh but is dropped when the tab closes — so you never get yanked
  back into a stale/old game on a later visit (unlike a code in the URL or `localStorage`).
- **`boot()`** checks it before falling to home: host → `hostResume(code)`; player →
  `playerResume(code, pid, name)`. On success it renders straight back into the game. If the game
  is gone or resume throws, it clears the record and shows home.
- **`playerResume`** reconnects to the **same `pid`** (so the same score + answers — no duplicate
  player), and rehydrates local state from `players/{pid}` (`ans`/`bet`/`pass`/`ready`, plus the
  current round's `submittedRound`/`myStage`/`lastSubmitLabel`) so the UI shows your progress. It
  pre-sets `app.searchRound` to the current round so `playerQuestion`'s per-round reset doesn't wipe
  the rehydrated `myStage`. If the player node is gone (kicked while away) it shows the kicked screen.
- The record is cleared on explicit leave (`resetToHome`), game end (`hostEnd`), and when a player
  is kicked (the `unsubMe` listener).
- **Exception in `boot()`:** if a freshly picked quiz is waiting (`localStorage[ACTIVE_KEY]`, the
  handoff from `account/quizzes/` in the *same tab*), auto-resume is skipped so you can host the new
  quiz instead of being pulled back into the old game.
- The host **also** keeps the existing `localStorage` `quizHost` code + manual **"Hervat quiz"**
  button — that's the cross-tab / cross-device path; the sessionStorage record is only the
  seamless same-tab refresh layer.

---

## 16. External APIs

- **TMDB** (`tmdbSearch` / `movieCast`): proxied via the Worker (token stays server-side).
  - Movie answer search: `GET {TMDB_PROXY}/search?query=…` → `/3/search/movie`. `answer` for
    `:tmdb` questions is the TMDB movie id (or an array of ids for "any of").
  - Movie cast (legacy): `GET {TMDB_PROXY}/search?type=credits&id=862` → `/3/movie/{id}/credits`.
    Cast-only; kept for backward compat. `movieCast` in core is now unused by the pages.
  - Movie details (media builder, §22): `GET {TMDB_PROXY}/search?type=details&id=862` →
    `/3/movie/{id}?language=nl-NL&append_to_response=credits`. **One call** returns genres (nl-NL),
    runtime, vote_average, release_date, poster and cast+crew — the source for the info-facts
    (year/genre/director/composer/rating/runtime) and the actor hints (`movieDetails`/`movieFacts`).
    Film questions are created **only** via the builder — no prepared film rounds, **no actor photos
    committed**; photos come live from TMDB. **The Worker must be redeployed** for `type=details`;
    until then the builder falls back to `type=credits` (actors load, but the info-facts stay empty).
  - **The photo itself never passes through the Worker** — it loads straight from TMDB's public
    image CDN (`https://image.tmdb.org/t/p/w500{path}`). **The Worker must support `type=credits`**
    (`tmdb-proxy/worker.js`); until redeployed, movie search still works but the cast lookup returns
    empty (graceful: the builder finds no cast). The old `type=person` lookup is no longer used.
- **Deezer** (`deezerSearch`): JSONP (`GET /search?q=…&output=jsonp&callback=…`) to avoid
  CORS. `answer` for `:deezer` questions is the Deezer track id. Each result also carries
  **`preview`** — a ~30s MP3 on Deezer's CDN, free and key-less. **Song questions** use it as
  host-only `audio` (optionally clipped via `clipStart`/`clipEnd`); the player answer side
  (`:deezer` search, or `:text`) is unchanged. `deezerSearch` lives in both `index.html` (game
  answer search) and `lib/quiz-core.js` (editor song builder). `deezerTrack(id)` (JSONP
  `/track/{id}`) additionally fetches title/artist(+id)/album(+id)/year for the song builder. The game
  also has `deezerSearchTitles(q)` (track search → deduped titles, for `:deezer-title`) and
  `deezerSearchKind('album'|'artist', q)` (`/search/album`, `/search/artist`) for the
  `:deezer-album` / `:deezer-artist` answer modes (when the album/artist is the answer). Note:
  you only get Deezer's one fixed 30s snippet, not an arbitrary range of the full track.
- `searchOptions(mode, q)` dispatches to the right provider; the answer UI debounces input
  (`_sTimer`) and renders results via `searchOutHTML` / `wireSearchResults`.

---

## 17. Credentials & config (public by design)

These ship in the client and are meant to be public for this app:

- **Firebase** project `quiz-db61a`, RTDB
  `https://quiz-db61a-default-rtdb.europe-west1.firebasedatabase.app`,
  apiKey `AIzaSyB5E7zxQ9sAMQeNUz2PmI_PcWAoiz_iMf4` (in `index.html`). RTDB rules are **open (test
  mode)** — no auth. Anyone with a code can read/write that game; acceptable for a party game,
  not for anything sensitive.
- **TMDB** — the read token is **not** in the client: it's a Worker secret (`tmdb-proxy/`, §16).
  Clients only know the public proxy URL (`TMDB_PROXY`).
- **`TMDB_PROXY`** URL lives in both `index.html` and `lib/quiz-core.js`.
- Firebase JS SDK **v12.14.0** from the gstatic CDN (ES modules).

If the RTDB ever needs locking down, that is a rules + minor client change, not an
architecture change.

---

## 18. Dev workflow & validation

The HTML pages have an inline module that imports from a CDN and from `lib/quiz-core.js`, so you
can't `node` a page directly. Use these checks after edits.

**Syntax-check the shared module directly** (it's a real `.js` ES module):
```bash
node --check lib/quiz-core.js && echo "core OK"
node --check tmdb-proxy/worker.js && echo "worker OK"
```

**Syntax-check a page's inline module** (extract it, stub the imports, `node --check`):
```bash
python3 - <<'PY'
import re
html=open('index.html').read()              # or account/quizzes/index.html / account/questions/index.html
js=re.search(r'<script type="module">(.*?)</script>', html, re.S).group(1)
for u in ('firebase-app.js','firebase-database.js','./lib/quiz-core.js'): js=js.replace(u,'x')
open('/tmp/page.mjs','w').write(js)
PY
node --check /tmp/page.mjs && echo "page JS OK"
```

**Validate JSON** (manifests + any saved set):
```bash
for f in library.json bandle/round.json puzzle/round.json; do
  python3 -c "import json;json.load(open('$f'));print('OK $f')"; done
```

**Unit-test the pipeline** without a browser: `lib/quiz-core.js` is importable. Copy it to a
`.mjs` and import (its `fetch`/`localStorage`/`document` deps only run inside functions you don't
call for the pure pipeline):
```bash
cp lib/quiz-core.js /tmp/core.mjs
node --input-type=module -e "
import * as c from '/tmp/core.mjs';
const f=c.flattenQuiz({rounds:[{name:'R',questions:[{question:'q',options:['A','B'],answer:0,shuffle:true}]}]});
console.log(c.validateQuiz({rounds:[{name:'R',questions:f.questions}]})===null?'OK':'ERR');
console.log(c.applyShuffles(c.normalizeQuiz(f.questions))[0].answerLabel==='A');
"
```
`index.html` keeps its own inline copy of the pipeline (kept logic-identical to core, see §3); to
diff them, brace-match `function <name>(` out of each file and compare comment-stripped bodies.

**End-to-end** still requires a real browser + Firebase (listeners, media, search), **served over
http** (GitHub Pages, or `python3 -m http.server` locally — `file://` breaks the module imports).
After changes: push (or serve locally), open the page. Test the cross-page flow too: build on
`account/quizzes/` → **Gebruik** → host on `index.html`.

---

## 19. Function reference (grouped)

- **Bootstrap/routing:** `boot` (controller URL → per-tab session auto-resume → home),
  `renderHome`, `renderJoin`, `renderHostResume`, `resetToHome`, `cleanup`.
- **Session reconnect:** `saveSession`/`loadSession`/`clearSession` (per-tab `sessionStorage`,
  §15) — written on host create/resume + player join, read by `boot`.
- **Host lifecycle:** `hostCreate`, `hostResume`, `startHost`, `hostStart`, `hostBeginRound`,
  `hostNext`, `hostSkip`, `hostEnd`, `initQuestion`, `hostKick`.
- **Host question flow:** `hostQuestion`, `hostStagesHTML`, `hostCheck`, `hostNextHint`,
  `hostStartPlay`, `hostRevealBets`, `hostReveal`, `hostRevealView`, `hostToggleCorrect`,
  `hostSetAnswer`, `hostHead`, `hostAside`, `hostRoundIntro`, `hostLobby`, `hostFinal`.
- **Player:** `playerJoin`, `playerResume` (refresh reconnect, §15), `startPlayer`, `playerLobby`, `playerRoundIntro`, `playerReady`,
  `playerQuestion`, `playerStagesHTML`, `playerSubmit`, `playerBet`, `playerPass`,
  `playerPassed`, `playerWaiting`, `playerHold`, `playerReveal`, `playerFinal`,
  `playerLeaderboardHTML`, `renderPlayerKicked`.
- **Controller:** `controllerJoin`, `renderController`, `ctrlSetBet`, `ctrlToggle`,
  `ctrlLinkFor`.
- **Quiz/data:** `flattenQuiz`, `validateQuiz`, `validateQuestions`, `normalizeQuiz`,
  `normStage`, `setQuiz`, `handleQuizFile`, `roundCtx`, `isRoundStart`, `pRoundLbl`.
- **Media:** `resolveMedia`, `resolveMediaKey`, `applyAudioLabels`, `qMediaHTML`, `videoHTML`.
  (`loadFolder`/`loadMediaFiles`/`fileToDataURL`/`quizMediaReport` still exist but are dead — no
  UI triggers them. `labelFromFile` now lives in `lib/quiz-core.js`, mirrored inline.)
- **Shared module (`lib/quiz-core.js`):** see §22 for the full export list.
- **Scoring/state:** `pushState`, `publicCurrent`, `buildResults`, `computeGain`,
  `isCorrectAns`, `effectiveCorrect`, `setJudge`, `normTxt`.
- **Search:** `tmdbSearch`, `deezerSearch`, `searchOptions`, `refreshSearchOut`,
  `searchOutHTML`, `wireSearchResults`, `answerAreaHTML`, `wireAnswerArea`.
- **Wiring/UI bits:** `wirePlayerControls`, `wirePass`, `metaHTML`, `stageHintLabels`/`hintLabelsHTML`,
  `clueListHTML`, `betOverviewHTML`, `allGuessesHTML`, `stageRowHTML`, `leaderboardHTML`,
  `podiumHTML`, `passModalHTML`, `playerRowsHTML`, `pointsInfo`, `winNote`.

(Names can drift — regenerate with `grep -oE "function [a-zA-Z0-9_]+" index.html`.)

---

## 20. Known constraints & gotchas

- **"round" = question index.** `app.round` and `state.round` are the flat question index,
  not the round number. Round info is in `app.rounds` / `roundCtx`. Historical naming; don't
  "fix" it without updating every reader.
- **Media is link-based** (§9) — repo-served or absolute URLs; no per-device folder loading.
  Saved quizzes/questions, however, live in **localStorage per device** (export to move them).
- **Open RTDB rules** — fine for a party game, not for sensitive data.
- **Single host writer** — never run two host tabs simultaneously (§15).
- **Audio never reaches players** by design (host-only playback). Clipped song audio
  (`clipStart`/`clipEnd`, see `wireClips`) is enforced only on the host screen. Because the host
  re-renders on every player update, playback restarts if someone answers mid-clip — fine for a
  short clip, but don't expect uninterrupted long playback (same limitation as Bandle stems).
- **Deezer via JSONP** — depends on the public Deezer endpoint; no key, can rate-limit. The
  `preview` is a fixed ~30s snippet Deezer chooses; you cannot request an arbitrary range of the
  full track (clip windows apply *within* that 30s).
- **No build step** — plain static files with native ES module imports. Shared logic goes in
  `lib/quiz-core.js`; shared CSS in `lib/style.css` (`:root` variables, light blue/white theme).
  Must be served over http (not `file://`).
- **Pipeline is duplicated** — `index.html` keeps its own inline copy of the quiz pipeline; keep
  it logic-identical to `lib/quiz-core.js` when editing (or de-dup by importing — see §3).

---

## 21. How to extend

- **Add a question:** either build it on `account/quizzes/`, or hand-write it in a quiz JSON. Choose
  the mode via `options` (array / `":tmdb"` / `":deezer"` / `":text"`, optionally `search:true`).
  For staged/betting, add `stages[]` with `betMultiplier`. Media is a URL/repo path. Validate (§18).
- **Add a library item/round:** drop a folder + `round.json` and list it in `library.json` (§22);
  it shows up in the `account/quizzes/` picker.
- **Add a round:** add another `{name, intro, questions:[…]}` object. Boundaries are derived
  automatically by `flattenQuiz`; the round intro screen and labels follow.
- **Add a new answer mode:** extend the `optionsMode` derivation in `normalizeQuiz`, the
  answer UI in `answerAreaHTML`/`wireAnswerArea`, correctness in `isCorrectAns`, and the
  reveal/label paths. Keep `publicCurrent` in sync for what players receive.
- **Add a new media type:** extend the render helpers (`qMediaHTML`/`stageRowHTML`/`normStage`),
  `validateQuestions`, and `publicCurrent` (decide host-only vs sent-to-players) — mirror render
  changes in both `index.html` and, if relevant, the manager pages.
- **Lock down the DB:** add Firebase Auth + RTDB rules; gate writes to `players/{pid}` by
  uid and `state`/`quiz`/`rounds` to the host. Client changes are localized to the ref
  helpers and join flows.

---

## 22. Quiz samenstellen uit de bibliotheek (catalog)

Instead of hand-writing `questions.json`, a host builds a quiz on **`account/quizzes/`** by ticking
existing questions from a self-describing media library (and/or adding their own). The library is
a set of repo folders, each with a `round.json` manifest holding the answers the media lacks.

### Library layout

- **`library.json`** (repo root) — tiny index: `{ "rounds": ["bandle","puzzle"] }`.
  There is no directory listing on GitHub Pages, so the app reads this short, known list rather
  than discovering folders. Adding a round = new folder + `round.json` + add the name here.
- **`<folder>/round.json`** — one manifest per round, holding the **answers + metadata** that
  the committed media lacks. Each carries a `_doc` string explaining how that round works and
  which API it needs. Schema by mode:

  | Round | `mode` | Per-item fields | Stages built from |
  |-------|--------|-----------------|-------------------|
  | bandle | `:deezer` | `deezerId`, `label`, `tracks[]` | audio tracks (host-only); folder name → year/views/par; track filename → instrument label |
  | puzzle | `:text` | `answer`, `accept[]`, `parts[]`, `full` | part images; `full` → `answerImage` (reveal) |

  (The `listsearch` mode — single image + a shared `breeds[]`-style options list — has no built-in
  round anymore; the old `dog-breeds` round was removed. The mode still lives on for **custom**
  questions with >6 options, which become searchable; see §below.)

  `library.json` lists these folders (currently `bandle`, `puzzle`). There is **no
  prepared `:tmdb` actors round** — `actors/round.json` and the committed `img/` actor photos were
  removed. Movie-by-actors is built per-quiz with the **film builder** (§below), which pulls cast
  live from TMDB. Betting rounds set `betting:true`; `betMultipliers` derive from stage count
  (`defaultBetMults`). The per-question prompt comes from the round's `heading`.

### The editor lives on its own pages (`account/quizzes/` / `account/questions/`)

The quiz builder is **not** in `index.html` anymore — it's under `account/`, and each manager is
**split into a LIST page and a `new/` CREATOR/EDITOR page** so every screen is a real, bookmarkable,
refresh-safe URL on GitHub Pages (no SPA-fallback hack needed):

There are **three question types**: **custom** (zelf samengesteld), **film**, and **liedje** (song).
The old separate *meerkeuze*/*open* forms are gone — both are now just answer-modes of the custom
builder, which losslessly re-opens any old `:text`/`options[]` bank question (§custom builder below).

- `account/questions/` (list) → `account/questions/new/?type=custom|film|song` (create) or
  `…/new/?edit=<index>` (edit). Each question is independent → the form is its own page; **Opslaan**
  saves to the bank and navigates back to the list. (Old `?type=mc|open` links route to `custom`.)
- `account/quizzes/` (list) → `account/quizzes/new/` (new) or `…/new/?edit=<name>` (edit). The quiz
  draft spans many sub-steps (edit→add→custom/film…) and must persist, so those sub-views stay **in-page**
  (`S.view`, draft in memory); only list↔editor is a real navigation.

**Top bar (`editorTopbarHTML`)**: on a creator/editor page the top-left shows **← Terug zonder opslaan**
(discard → list) and **Opslaan** (save → list) — replacing the old "← Spel". On the list pages and the
home screen the top-right shows the shared **hamburger** (`navMenuHTML(active, base)` in `quiz-core.js`):
Home · Mijn quizzen · Mijn vragen, with the current page marked `aria-current` + `.active`.

The **shared editor UI lives in `lib/editor-ui.js`** — both managers differ only in where a built
question goes (the bank vs. a round in a quiz), so the common parts are factored out: `rowText`,
the **custom** form (`customFormHTML`/`readCustomPick`/`wireCustomForm`, wrapping the custom builder),
the **film/liedje** search + forms (`makeMediaActions`/`filmFormHTML`/`songFormHTML`/`readMediaPick`),
and the wiring (`wireMediaForms`/`wireScroll`/`editorTopbarHTML`). The form builders take
`opts.hideAdd` (hide the bottom Toevoegen/Terug row when save is in the top bar); `wireMediaForms`/
`wireCustomForm` return the builder `sync` so a top-bar Opslaan can sync first.
Styling is class-based in `lib/style.css` (utilities like `.ellip`/`.hint`/`.f14`/`.btn.sm`).

- **`account/quizzes/`** — "Jouw quizzen". A view-routed full-screen UI (`S.view`:
  `list`/`edit`/`add`/`lib`/`custom`/`film`/`song`):
  - **list** — saved quizzes with **Gebruik** (→ host), **Wijzig**, **Export**, 🗑, plus **+ Nieuwe quiz**.
  - **edit** — quiz name + rounds; each round has an **editable name and intro** (the intro is the
    "Ik snap het 👍" explanation players see at the round start; synced via `syncEdit`),
    **drag to reorder rounds and questions** (grip handle, see `lib/drag.js`), 🗑 per question,
    **+ Vraag toevoegen**. Only **Opslaan / Annuleer**.
  - **add** — two button groups, mirroring each other: **Kant-en-klare vragen** (one button per
    library round, e.g. **Bandle** / **Puzzel**, built from `library.json` via `libButtonsHTML`)
    and **Nieuw maken** (**Custom / Film / Liedje**). Plus **Mijn opgeslagen vragen** (the bank).
    A library button opens the **lib** view (its own picker); Custom/Film/Liedje open their builders.
    Bank picks + every custom form carry a **doelronde-kiezer** (`roundPickerHTML`/`targetRoundFor`):
    pick an existing round in the draft (e.g. add a custom question to **Bandle**) or create a new
    one — so your own questions can be split across rounds. Library rounds still merge by name.
  - **lib** — the per-round picker for one **kant-en-klare** round (`libHTML`, set via `S.libFolder`):
    tick the questions you want (an **Alles** select-all on top), then **Toevoegen**. Items build via
    `buildQuestion` and merge into a round named after the round's `round.json` `name`.
  - **Custom builder ("+ Custom")** — a single-column builder (`customBuilderHTML`/`wireCustomBuilder`/
    `buildCustomQuestion` in `lib/quiz-core.js`) for self-made questions, **no API source**. A prompt
    plus two drag-zones — **Info** (`q.facts`, always visible) and **Hints** (`q.stages`, revealed one
    by one with bet-multipliers) — each fed by a **"+ toevoegen"** button. A clue is a `custom` clue:
    plain text *or* a **directe medialink** with a render type (afbeelding/video/audio; only direct
    files, no YouTube/Spotify embeds). Drag clues between Info and Hints (`enableDragGroup`). The
    **Antwoord** block is typed text (not dragged): an **open/meerkeuze** toggle. *Open* → `:text`
    (host-judged; every juist antwoord accepted via `answer`+`accept[]`). *Meerkeuze* → `options[]`
    with the juiste antwoord(en) first + separate foute opties; **>6 options → searchable** (`search:true`,
    list-search style), else tiles (`shuffle:true`). Multiple correct → `answer` is an index array
    (shuffle is array-aware). `q.source={kind:'custom', clues, answerMode, correct, distractors}` makes
    it re-open losslessly; `customPickFromQuestion` also reconstructs **old meerkeuze/open** bank
    questions (no `source`) into the builder.
  - **Media builder (Film "+ Film" / Liedje "+ Liedje")** — one shared builder for both
    (`mediaBuilderHTML` + `wireMediaBuilder` + `buildMediaQuestion` in `lib/quiz-core.js`).
    Pick a source (TMDB film via `movieDetails`, or Deezer track via `deezerSearch`+`deezerTrack`)
    → it yields a **clue pool**: the actors (film) plus the info-facts (year/genre/director/
    composer/rating/runtime for film; artist/album/year for song). Then four choices:
    - **Two columns** (`mb-grid`, stacks on mobile): **left** = the question (prompt + the **Info**,
      **Hints** and **Antwoord** drop-zones); **right** = the draggable **pool** + a **"+ eigen
      stukje"** button. The pool is drag-zone `'off'`. (There is no separate poster/title header — the
      poster/cover and title are themselves clues in the pool.)
    - **De vraag** — free prompt (`mb-prompt`), default "Welke film?" / "Welk nummer is dit?".
    - **Drag** (`enableDragGroup`, cross-container over `info`/`hint`/`answer`/`off`): drag a clue to
      **Info** (always-visible subkop, `q.facts`), **Hints** (revealed one at a time, `q.stages`,
      order = reveal order), or **Antwoord** (what they must guess); drag back to unuse. The **title** is
      a draggable clue too (defaults to the Antwoord zone). Clue kinds: `title` (searchable, film/track
      id), `fact` (year/genre/rating/runtime; for songs `artist`/`album` are *searchable* facts with a
      Deezer id, `year` plain), `person` (cast + director + composer, TMDB photo when available),
      `image` (the **poster**/album **cover** — droppable in Info/Hints, **never** the answer:
      `applyAnswerZone` rejects an image in Antwoord), `audio` (the song fragment), `custom` (typed via
      "+ eigen stukje"). The `zoekbaar` badge carries a `title` tooltip ("compatibel met de zoeken-API").
      A person chip has
      **naam / foto / rol** checkboxes — pick what players see (`showName`/`showPhoto`/`showRole`);
      "rol" = the job (Acteur/Regisseur/…), *not* who they played. The editor always shows a small role
      badge. For songs the **fragment is its own draggable clue** (inline player + `van…tot…` clip,
      0–30s): drop it in Hints at any position, or in Info (plays from the start). Fragment alone →
      non-staged audio question; fragment + fact hints → staged with the fragment at its chosen spot.
    - **Antwoord** — drag what they must guess into the Antwoord zone (one or more). The **search
      mode follows the combination** (`answerSearchMode`), so the player's results show exactly the
      answer: film **title** → `:tmdb`; song **title** alone → `:deezer-title` (only titles, deduped,
      text-matched); **artist** → `:deezer-artist`; **album** → `:deezer-album`; **title + artist** →
      `:deezer` (the exact track). A **"Spelers zoeken …"** checkbox (`p.answerSearch`) toggles search
      off → players type. Any other combination (year/genre/person/custom, or e.g. title+year) → open
      `:text`, host-judged (all dragged values count). A clue in Antwoord is automatically out of
      Info/Hints/pool, so the answer is never shown.
    Hints (`q.stages`) get `betMultiplier`s → a betting question by default (toggle per round/question
    with the **inzet** checkbox). The poster becomes `answerImage`. `q.source` stores the full clue
    pool so the question bank can re-open the builder losslessly. Default rounds: **"Films"** / **"Liedjes"**.
    Spoiler-safety: the **"Hints die je gaat krijgen"** preview is one reusable component shared by host
    and player. `stageHintLabels(stages)` is the single source of truth → it shows each stage's
    `previewLabel` (the spoiler-safe **category**: Acteur/Regisseur/Jaar/Genre…, set at build time by
    `clueToStage`), falling back to the media type (Foto/Video/Fragment/Hint N) — never the value/name.
    Questions built before `previewLabel` existed get it **backfilled at load** (`backfillPreviewLabels`
    in `normalizeQuiz`, mirrored in `index.html`): each stage is matched by media content to a clue in
    `q.source.clues` and inherits that clue's category. Raw-JSON questions with no `source` keep the
    media-type fallback.
    The host computes the list from the full question and ships the exact same array in
    `publicCurrent().hintLabels`, so host and player render identical previews. `publicCurrent` still
    withholds non-audio stage `label`s (captions, which can be the answer) until a stage is revealed.
- **`account/questions/`** — "Mijn vragen": the personal **question bank** (`BANK_KEY`). Create,
  **edit** (in place) and delete reusable Custom/Film/Liedje questions; they show up under "Vraag
  toevoegen" in the quiz manager. (Edit routing is by stored `bucket`: `films`→film, `liedjes`→song,
  everything else → custom builder, so a `:text` song still loads the song form, and old
  meerkeuze/open bank items re-open in the custom builder.)

Edit/bank list rows show the **answer first** (`answerText`) so each question is identifiable, not
the generic prompt. The home screen (`index.html`) has a hamburger menu linking to both pages.

A custom meerkeuze is stored `{options:[correct,…], answer:0, shuffle:true}` (or `search:true`
when >6 options). The target round comes from the doelronde-kiezer; its defaults are **"Films"** for
films, **"Liedjes"** for songs and **"Eigen vragen"** for custom, but you can route them into any
existing round. A saved/edited quiz is a plain questions.json object (`{name, rounds:[…]}`); editing
reconstructs rounds via `flattenQuiz`.

### Handoff to the game

**Gebruik** on `account/quizzes/` calls `setActiveQuiz(name, quiz)` (writes `localStorage['quiz:active']`)
and navigates to `../../index.html`. localStorage is origin-scoped (not path-scoped), so the quiz
saved under `account/quizzes/` is readable by the game at the root. On the next **hostCreate**, the game `takeActiveQuiz()`s it
(consuming the key) and runs it through `flattenQuiz → normalizeQuiz → applyShuffles` instead of
the built-in `SAMPLE`. The lobby links out to both pages; the old in-game "Map laden" folder
upload is gone (all media is URL/link-based — committed library media counts as repo-relative
links).

### Shuffle, save, export, video

- **Shuffle** (`applyShuffles`, inside `setQuiz`/`hostCreate`) — `shuffle:true` MC options are
  randomized and `answer` re-pointed each hosting session. Resume-safe: `hostResume` reads the
  already-shuffled set back from Firebase.
- **Store** (`lib/quiz-core.js`): `SAVED_KEY` (quizzes), `BANK_KEY` (questions), `ACTIVE_KEY`
  (handoff). `exportQuizJSON` downloads a quiz; import is the game's "JSON laden" path.
- **Video** is a first-class media field on questions and stages (`videoHTML`, `qMediaHTML`,
  handled in `publicCurrent`/`stageRowHTML`/`normStage`/`validateQuestions`). Like images, video
  is sent to players; **audio stays host-only**.

### `lib/quiz-core.js` exports

Pipeline: `flattenQuiz`, `validateQuiz`, `validateQuestions`, `normalizeQuiz`, `normStage`,
`applyShuffles`, `labelFromFile`. Helpers: `esc`, `qLabel`, `qTypeLabel`, `answerText`,
`defaultBetMults`, `itemLabel`, `ICON_TRASH`, `ICON_GRIP`, `factsHTML`, `navMenuHTML` (shared
hamburger with active state). Catalog/TMDB/Deezer:
`TMDB_PROXY`, `loadCatalog`, `buildQuestion`, `tmdbSearch`, `movieCast`, `movieDetails`,
`deezerSearch`, `deezerTrack`, `popularMoviesHTML`. Media builder: `movieFacts`, `songFacts`,
`newFilmPick`, `newSongPick`, `newCustomClue`, `pickFromQuestion`, `buildMediaQuestion`,
`mediaBuilderHTML`, `wireMediaBuilder`. Custom builder: `newCustomPick`, `customPickFromQuestion`,
`buildCustomQuestion`, `customBuilderHTML`, `wireCustomBuilder`. Store: `SAVED_KEY`/`BANK_KEY`/`ACTIVE_KEY`,
`loadSavedQuizzes`/`saveQuizToDevice`/`deleteSavedQuiz`, `loadBank`/`saveBank`/
`addToBank`/`deleteBankItem`, `setActiveQuiz`/`takeActiveQuiz`, `exportQuizJSON`, `copyText`.
Catalog base: `ROOT` (`new URL('../', import.meta.url)`) — the repo root used by `loadCatalog`.
(The old `actorImage` helper and committed actor JPEGs in `img/` were removed — film/song questions
come from the media builder via `movieDetails`/`deezerTrack`; `movieCast` is the cast-only fallback
when `type=details` isn't deployed. Drag lives in `lib/drag.js`: `enableDragSort` (single list) +
`enableDragGroup` (cross-zone).)

### `lib/editor-ui.js` exports

Shared manager-page UI (imports from `quiz-core.js` + `drag.js`). List helpers: `rowText`.
Custom: `customFormHTML`/`readCustomPick`/`wireCustomForm` (wrap the custom builder; `wireCustomForm`
returns the builder `sync`). Film/liedje: `makeMediaActions` (returns
`filmSearch`/`filmPick`/`songSearch`/`songPickTrack` bound to the page's `S`+`render`),
`filmFormHTML`, `songFormHTML`, `readMediaPick`. Wiring/chrome: `wireMediaForms` (returns the
builder `sync`), `wireScroll`, `editorTopbarHTML` (the ← Terug zonder opslaan / Opslaan bar). The
forms take an `opts` object (`addLabel`/`backId`/`roundPickerHTML`/`editing`/`hideAdd`) so the
list/creator pages can vary labels, hide the bottom action row when save is in the top bar, and
toggle the round-picker. (The old standalone `mcFormHTML`/`openFormHTML`/`mediaRowHTML` helpers were
removed — meerkeuze/open are now answer-modes of the custom builder.)

---

## 23. Vraag-preview (host- + spelerscherm naast elkaar)

A question can be previewed straight from the managers — the **quiz editor** rows
(`account/quizzes/new/`), the **question bank** rows (`account/questions/`) — via an 👁 button.
`openQuestionPreview(question, root)` (`lib/editor-ui.js`) opens a modal (`.pv-overlay`/`.pv-modal`
in `lib/style.css`) holding **two iframes of the game itself**: `index.html?preview=host` and
`index.html?preview=player`. `root` is the relative path to the repo root from the calling page
(`../../../` for the editor, `../../` for the bank).

This **reuses the real game rendering** — there is no second copy of the host/player views, so any
change to how the host or player renders a question shows up in the preview automatically. It works
by spinning up a **throwaway real game** on Firebase:

- The question is handed to the iframes via `localStorage['quiz:preview']` (localStorage is
  origin-scoped, so both iframes read it).
- **`previewHost()`** (in `index.html`, reached from `boot()` on `?preview=host`) builds a one-round,
  one-question game, jumps straight to `phase='question'` (betting questions start at the bet step),
  attaches the normal host listeners (`startHost`), `pushState`s, and publishes the room code to
  `localStorage['quiz:preview-code']`. It deliberately skips `remember()`/`saveSession()` so the
  preview never hijacks the user's real "Hervat quiz" shortcut.
- **`previewPlayer()`** (`?preview=player`) waits for that code (storage event + a short poll),
  auto-joins as **"Speler"** via the normal `playerJoin`, and renders the player view. Host and
  player therefore sync over real Firebase: the previewer plays both panes (answer on the right,
  reveal/next-hint on the left) and the host even sees the player's answer.
- On close the modal posts `{t:'qz-preview-close'}` to the host iframe → **`previewEnd()`** removes
  the temporary `games/{CODE}` node and unsubscribes, **without** touching the real `quizHost`
  localStorage or the per-tab session. `body.preview` hides the brand chrome inside the iframes.

Related lobby changes: **"Host deze quiz"** on `account/quizzes/` navigates to `index.html?host=1`,
which `boot()` turns into an immediate `hostCreate()` of the picked quiz (instead of landing on
home). The host lobby (`hostLobby`) was trimmed to **code · jury link · players · Quiz starten ·
Annuleren**, plus a line naming the loaded quiz that links back to it in the editor when it came
from the saved list (`app.quizFromLibrary`).

---

*Keep this file current. When you change a phase, a schema field, the media flow, or the
RTDB shape, update the matching section here in the same commit.*
