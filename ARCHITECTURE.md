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

- **One HTML file** (`index.html`) contains the entire app: host view, player view,
  controller view, all CSS and all JS (vanilla, ES modules, no build step).
- **Firebase Realtime Database (RTDB)** is the only backend. All shared game state lives
  under `games/{CODE}`. Clients subscribe with `onValue` listeners.
- **GitHub Pages** hosts the static file. Repo: `https://github.com/NikkiBouman/Quiz`,
  served at `https://nikkibouman.github.io/Quiz/`.
- **Question content** lives in `questions.json`, loaded at runtime by the host (it is *not*
  hardcoded; a built-in `SAMPLE` set is the fallback).
- **Media** (images/audio) is loaded by the host from a local folder at runtime, OR served
  from the repo via relative paths. See §9 — this is the single biggest source of confusion.

---

## 2. Tech stack & deployment

| Concern        | Choice |
|----------------|--------|
| Frontend       | Vanilla JS, ES modules, single `<script type="module">` block |
| State sync     | Firebase RTDB (`firebase-app` + `firebase-database` v12.14.0 from gstatic CDN) |
| Hosting        | GitHub Pages (static) |
| Movie search   | TMDB REST API (`/3/search/movie`), Bearer read-token, client-side |
| Song search    | Deezer API via JSONP (`/search`, `output=jsonp`) |
| Fonts          | Google Fonts (preconnected) |

No bundler, no transpiler, no npm runtime dependency. Edit `index.html`, push, done.

---

## 3. File layout (in `/mnt/user-data/outputs` working copy)

```
index.html        # the entire app
questions.json    # the loadable question set (round-structured; see §7)
ARCHITECTURE.md   # this file
```

In production these live in the GitHub repo root. Media folders (e.g. `dog-breed/`,
`actors/`, `bandle/`, `puzzle/`) live alongside `index.html` if you want repo-served media.

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
      "name": "Hondenrassen",
      "intro": "Raad het hondenras op de foto…",
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
| `answerImage` | Image shown on the **reveal** screen (e.g. a puzzle's `full.*` composite). Resolved like any media; sent to players via `publicCurrent` only at reveal. |
| `stages`      | Array of progressive hints — presence makes the question "staged" (see below). |
| `points`      | Base points (default 100). |
| `pointsByStage` | Non-betting staged questions: points per stage (decreasing reward for later reveals). |
| `year`, `views`, `par` | Bandle metadata; auto-parsed from the audio folder name if absent. |

### `optionsMode` (derived by `normalizeQuiz`)

| `options` value           | `optionsMode` | UI |
|---------------------------|---------------|----|
| array                     | `list`        | Tappable shape tiles (▲◆●■). `answer` = index. |
| array + `"search": true`  | `listsearch`  | Autocomplete text field over the list. `answer` = index. |
| `":tmdb"`                  | `tmdb`        | Live TMDB movie search. `answer` = TMDB movie id (or array). |
| `":deezer"`               | `deezer`      | Live Deezer song search. `answer` = Deezer track id (or array). |
| `":text"`                 | `text`        | Free text; **manually judged**. `answer` = string; `accept[]` for variants. |

### Stages (`stages[]`) — progressive hints

Each stage object: `{ text?, image?, audio?, label?, betMultiplier? }`. The presence of a
field decides the stage kind (`audio` > `image` > `text`). `label` is an optional caption.

- If **any** stage has `betMultiplier` → the question is a **betting** question. The host
  reveals hints one at a time; players wager on which hint they'll know the answer by, with
  higher multipliers for earlier (riskier) bets. `out.betMultipliers` is the per-stage
  multiplier array (missing → 1).
- If stages exist **without** betMultiplier but the question has `pointsByStage` → reward
  decreases with each revealed hint (no betting).
- **Audio stages are host-only**: audio paths are never sent to players (`publicCurrent`
  omits them); only the host machine plays sound. Images *are* sent to players as data-URIs.

### Bandle metadata auto-parse

For a stage with `audio`, `normalizeQuiz` reads the parent folder name and matches
`(YYYY_<views>_par-N)`, e.g. `Coldplay-Fix_You_(2005_725M_par-3)/1` → `year=2005`,
`views="725M"`, `par=3`. Shown via `metaHTML()`.

### Current `questions.json` content (16 questions, 4 rounds)

1. **Hondenrassen** (5) — `listsearch`, shared 21-breed Dutch list, dog images.
2. **Raad de film aan de acteurs** (5) — `:tmdb`, betting, actor-image stages.
3. **Bandle** (2) — `:deezer`, betting, instrument-audio stages (host-only audio).
4. **Wie of wat is dit?** (4) — `:text`, betting, progressively revealed drawing parts;
   `accept[]` for spelling variants.

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

Media is referenced in the JSON by **relative path** (e.g. `puzzle/Simba/1`,
`bandle/Coldplay-Fix_You_(2005_725M_par-3)/1`). There are two ways the host can supply it:

1. **Local folder load ("Map laden").** The host picks a folder; `loadFolder()` reads every
   file into an in-memory `mediaMap` (`path → data-URI`). This lives **only in that browser
   tab's memory** — it is *not* uploaded to Firebase.
2. **Repo-served.** If the media files are committed in the GitHub repo at the same relative
   paths, the relative `src` resolves to a URL and just works on any device with no loading.

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

### The cross-device gotcha (important)

Because `mediaMap` is per-tab memory:
- The **host renders images from `mediaMap`**, not from `state`. On a *second* device that
  resumed the game, `mediaMap` is empty → every image falls back to its raw path. If the
  media is **not** in the repo, images are broken and the question screen looks stuck.
- Fix in the app: the host **in-game side panel has a "Map laden / herladen" button**
  (§15) so you can re-attach the folder after resuming, without losing progress. Reloading
  also re-`pushState()`s so players receive the now-resolved image data-URIs.
- **Best practice for multi-device:** commit the media into the repo so paths resolve as
  URLs everywhere and "Map laden" becomes unnecessary.

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
media bar), `playerRowsHTML(mode)`, `metaHTML`, `hintLabelsHTML`, `allGuessesHTML`,
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
- **Media is NOT restored** (it was never in Firebase). On the new device the in-game side
  panel shows **"Geen media op dit apparaat geladen"** + a **Map laden** button. Loading the
  folder re-attaches `mediaMap` and re-`pushState()`s so players get the images. See §9 for
  the repo-served alternative that avoids this entirely.
- **Do not run two host tabs at once.** Both would write `state` on every action
  (last-write-wins) and conflict. Hand off; don't parallelize. Players stay connected through
  the handoff (their listeners are on the same nodes).

---

## 16. External APIs

- **TMDB** (`tmdbSearch` / `personSearch`): proxied via the Worker (token stays server-side).
  - Movie answer search: `GET {TMDB_PROXY}/search?query=…` → `/3/search/movie`. `answer` for
    `:tmdb` questions is the TMDB movie id (or an array of ids for "any of").
  - Person lookup (prepared actors round, §22): `GET {TMDB_PROXY}/search?type=person&query=Name` →
    `/3/search/person`. The client (`actorImage`) takes `results[0].profile_path` and builds an
    `https://image.tmdb.org/t/p/w500{path}` URL.
  - Movie cast (film builder, §22): `GET {TMDB_PROXY}/search?type=credits&id=862` →
    `/3/movie/{id}/credits`. The builder shows the top-billed cast (with photos) to tick + reorder.
  - In both cases **the photo itself never passes through the Worker** — it loads straight from
    TMDB's public image CDN. **The Worker must be redeployed** after adding `type=person` /
    `type=credits` support (`tmdb-proxy/worker.js`); until then movie search still works but actor
    photos / cast lookups return empty (graceful: names shown as text, builder finds no cast).
- **Deezer** (`deezerSearch`): JSONP (`GET /search?q=…&output=jsonp&callback=…`) to avoid
  CORS. `answer` for `:deezer` questions is the Deezer track id.
- `searchOptions(mode, q)` dispatches to the right provider; the answer UI debounces input
  (`_sTimer`) and renders results via `searchOutHTML` / `wireSearchResults`.

---

## 17. Credentials & config (public by design)

These ship in `index.html` and are meant to be public for this app:

- **Firebase** project `quiz-db61a`, RTDB
  `https://quiz-db61a-default-rtdb.europe-west1.firebasedatabase.app`,
  apiKey `AIzaSyB5E7zxQ9sAMQeNUz2PmI_PcWAoiz_iMf4`. RTDB rules are **open (test mode)** — no
  auth. Anyone with a code can read/write that game; acceptable for a party game, not for
  anything sensitive.
- **TMDB** read-access Bearer token (read-only).
- Firebase JS SDK **v12.14.0** from the gstatic CDN (ES modules).

If the RTDB ever needs locking down, that is a rules + minor client change, not an
architecture change.

---

## 18. Dev workflow & validation

The app is one file with an inline module, so you can't `node` it directly (it imports
Firebase from a CDN). Use these checks after edits.

**Syntax-check the JS** (strip the module, stub the CDN imports):
```bash
cd /mnt/user-data/outputs && \
sed -n '/<script type="module">/,/<\/script>/p' index.html | sed '1d;$d' | \
sed 's#https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js#a#; \
     s#https://www.gstatic.com/firebasejs/12.14.0/firebase-database.js#b#' > /tmp/quiz.mjs && \
node --check /tmp/quiz.mjs && echo "JS OK"
```

**Validate the question JSON:**
```bash
python3 -c "import json; json.load(open('questions.json')); print('JSON OK')"
```

**Unit-test pure helpers** without a browser: a harness reads `index.html`, `grab()`s a
function by brace-matching its `function name(` signature, `eval`s the needed cluster, and
runs it. Useful targets: `flattenQuiz`, `validateQuiz`, `validateQuestions`, `normalizeQuiz`
(needs `normStage`), `isCorrectAns` (needs `normTxt`), `resolveMediaKey`, `labelFromFile`.
Example shape:
```js
import fs from 'fs';
const html = fs.readFileSync('index.html','utf8');
function grab(name){ /* find 'function name(' then brace-match to the close */ }
eval(['flattenQuiz','validateQuiz','validateQuestions','normalizeQuiz','normStage']
  .map(grab).join('\n') + '\nglobalThis._t={flattenQuiz,validateQuiz,normalizeQuiz};');
```

**End-to-end** still requires a real browser + Firebase (listeners, media, search). After
changes: push `index.html` to the repo; on the host, load the folder via **Map laden**.

---

## 19. Function reference (grouped)

- **Bootstrap/routing:** `boot`, `renderHome`, `renderJoin`, `renderHostResume`,
  `resetToHome`, `cleanup`.
- **Host lifecycle:** `hostCreate`, `hostResume`, `startHost`, `hostStart`, `hostBeginRound`,
  `hostNext`, `hostSkip`, `hostEnd`, `initQuestion`, `hostKick`.
- **Host question flow:** `hostQuestion`, `hostStagesHTML`, `hostCheck`, `hostNextHint`,
  `hostStartPlay`, `hostRevealBets`, `hostReveal`, `hostRevealView`, `hostToggleCorrect`,
  `hostSetAnswer`, `hostHead`, `hostAside`, `hostRoundIntro`, `hostLobby`, `hostFinal`.
- **Player:** `playerJoin`, `startPlayer`, `playerLobby`, `playerRoundIntro`, `playerReady`,
  `playerQuestion`, `playerStagesHTML`, `playerSubmit`, `playerBet`, `playerPass`,
  `playerPassed`, `playerWaiting`, `playerHold`, `playerReveal`, `playerFinal`,
  `playerLeaderboardHTML`, `renderPlayerKicked`.
- **Controller:** `controllerJoin`, `renderController`, `ctrlSetBet`, `ctrlToggle`,
  `ctrlLinkFor`.
- **Quiz/data:** `flattenQuiz`, `validateQuiz`, `validateQuestions`, `normalizeQuiz`,
  `normStage`, `setQuiz`, `handleQuizFile`, `roundCtx`, `isRoundStart`, `pRoundLbl`.
- **Media:** `loadFolder`, `loadMediaFiles`, `fileToDataURL`, `resolveMedia`,
  `resolveMediaKey`, `labelFromFile`, `applyAudioLabels`, `quizMediaReport`.
- **Scoring/state:** `pushState`, `publicCurrent`, `buildResults`, `computeGain`,
  `isCorrectAns`, `effectiveCorrect`, `setJudge`, `normTxt`.
- **Search:** `tmdbSearch`, `deezerSearch`, `searchOptions`, `refreshSearchOut`,
  `searchOutHTML`, `wireSearchResults`, `answerAreaHTML`, `wireAnswerArea`.
- **Wiring/UI bits:** `wirePlayerControls`, `wirePass`, `metaHTML`, `hintLabelsHTML`,
  `clueListHTML`, `betOverviewHTML`, `allGuessesHTML`, `stageRowHTML`, `leaderboardHTML`,
  `podiumHTML`, `passModalHTML`, `playerRowsHTML`, `pointsInfo`, `winNote`.

(Names can drift — regenerate with `grep -oE "function [a-zA-Z0-9_]+" index.html`.)

---

## 20. Known constraints & gotchas

- **"round" = question index.** `app.round` and `state.round` are the flat question index,
  not the round number. Round info is in `app.rounds` / `roundCtx`. Historical naming; don't
  "fix" it without updating every reader.
- **Media is per-device** unless committed to the repo (§9). The #1 support issue.
- **Open RTDB rules** — fine for a party game, not for sensitive data.
- **Single host writer** — never run two host tabs simultaneously (§15).
- **Audio never reaches players** by design (host-only playback).
- **Deezer via JSONP** — depends on the public Deezer endpoint; no key, can rate-limit.
- **No build step** — keep everything in the one file; CSS uses `:root` variables (light
  blue/white theme) so re-theming is centralized.

---

## 21. How to extend

- **Add a question:** append to the right round's `questions[]` in `questions.json`. Choose
  the mode via `options` (array / `":tmdb"` / `":deezer"` / `":text"`, optionally
  `search:true`). For staged/betting, add `stages[]` with `betMultiplier` (and matching
  media files). Validate (§18), reload the folder on the host.
- **Add a round:** add another `{name, intro, questions:[…]}` object. Boundaries are derived
  automatically by `flattenQuiz`; the round intro screen and labels follow.
- **Add a new answer mode:** extend the `optionsMode` derivation in `normalizeQuiz`, the
  answer UI in `answerAreaHTML`/`wireAnswerArea`, correctness in `isCorrectAns`, and the
  reveal/label paths. Keep `publicCurrent` in sync for what players receive.
- **Add a new media type:** extend `loadFolder`'s detection + `SKIP_RE`, `resolveMediaKey`
  matching, and `publicCurrent` (decide host-only vs sent-to-players).
- **Lock down the DB:** add Firebase Auth + RTDB rules; gate writes to `players/{pid}` by
  uid and `state`/`quiz`/`rounds` to the host. Client changes are localized to the ref
  helpers and join flows.

---

## 22. Quiz samenstellen uit de bibliotheek (catalog)

Instead of hand-writing `questions.json`, the host can **tick existing questions** from a
self-describing media library and the app builds the quiz. This is the primary authoring path
in the lobby; the old "Map laden / JSON laden" flow is still there (collapsed under a
`<details>`).

### Library layout

- **`library.json`** (repo root) — tiny index: `{ "rounds": ["bandle","actors","puzzle","dog-breeds"] }`.
  There is no directory listing on GitHub Pages, so the app reads this short, known list rather
  than discovering folders. Adding a round = new folder + `round.json` + add the name here.
- **`<folder>/round.json`** — one manifest per round, holding the **answers + metadata** that
  the committed media lacks. Each carries a `_doc` string explaining how that round works and
  which API it needs. Schema by mode:

  | Round | `mode` | Per-item fields | Stages built from |
  |-------|--------|-----------------|-------------------|
  | bandle | `:deezer` | `deezerId`, `label`, `tracks[]` | audio tracks (host-only), folder name → year/views/par |
  | puzzle | `:text` | `answer`, `accept[]`, `parts[]`, `full` | part images; `full` → `answerImage` (reveal) |
  | actors | `:tmdb` | `tmdbId`, `label`, `actors[]` (obscure→famous) | **TMDB person photos**, no images committed (see below) |
  | dog-breeds | `listsearch` | `breed` (+ shared `breeds[]` options list) | single image, no stages |

  Betting rounds set `betting:true`; `betMultipliers` are derived by stage count
  (`defaultBetMults`). The per-question prompt comes from the round's `heading`.

### The editor (client)

`openCompose` → `loadCatalog` fetches `library.json` + each `round.json` → opens a **modal
editor** (`composePanelHTML`, view-routed via `app.composeView`: `main`/`mc`/`open`/`film`):

- **Kant-en-klare rondes** — the library checklist (tick items, per-round select-all). Default
  selection is *none*; the host picks.
- **Eigen vragen** — custom questions the host authors, kept in `app.composeCustom`:
  - **Meerkeuze** (`addMcQuestion`) — type the question (+ optional media link), the correct
    answer, and ≥1 distractor. Stored as `{options:[correct,…], answer:0, shuffle:true}`.
  - **Open vraag** (`addOpenQuestion`) — `:text`, manually judged, optional `accept[]`.
  - **Film (acteurs)** (`filmSearch`→`filmPickMovie`→`addFilmQuestion`) — search a movie (TMDB),
    load its top-10 cast (`type=credits`), tick + reorder (▲▼ buttons) the actors, build a
    betting `:tmdb` question whose stages are the chosen actors' TMDB photos in that order.
- **Form drafts** survive re-renders via `app.mcDraft`/`app.openDraft` (read DOM → state before a
  structural re-render; forms use fixed inputs, no dynamic add/remove, to avoid focus loss).

`buildComposedQuiz` assembles a standard `{name, rounds:[{name,intro,questions}]}` object
(library rounds + a "Films (eigen)" round + an "Eigen vragen" round) and hands it to the
**existing** `setQuiz` pipeline. No new question schema — the editor sits *in front of* the
normal pipeline. Library `:tmdb` actor photos and the bandle/puzzle media resolve repo-served;
custom content is link-based. The old `loadFolder` ("Map laden") path was **removed** — all
media is now URL/link-based (committed library media counts as repo-relative links).

### Shuffle, save, export

- **Shuffle** (`applyShuffles`, run inside `setQuiz`) — questions with `shuffle:true` (custom MC)
  have their `options` randomized and `answer` re-pointed each hosting session. Resume-safe:
  `hostResume` reads the already-shuffled set back from Firebase, it never re-shuffles.
- **localStorage** (`SAVED_KEY`, `loadSavedQuizzes`/`saveQuizToDevice`/`deleteSavedQuiz`) — saved
  quizzes are full questions.json objects keyed by name; listed in the editor and on host start
  (`useSavedQuiz`). **Export** (`exportQuizJSON`) downloads the same JSON to move to another
  device; import is the normal "JSON laden" path.

### Video & audio

`video` is a first-class media field on questions and stages (`videoHTML`, `qMediaHTML`, handled
in `publicCurrent`/`stageRowHTML`/`normStage`/`validateQuestions`). Like images, video is sent to
players; **audio stays host-only** everywhere (host plays on the big screen).

### Functions

`loadCatalog`, `openCompose`/`closeCompose`, `composePanelHTML` + `composeMainHTML`/`mcFormHTML`/
`openFormHTML`/`filmFormHTML`/`composeLibraryHTML`/`mediaRowHTML`, `wireCompose`,
`toggleComposeItem`/`toggleComposeRound`/`removeCustom`, `addMcQuestion`/`addOpenQuestion`/
`addFilmQuestion`, `filmSearch`/`filmPickMovie`/`filmToggleActor`/`filmMoveActor`,
`buildComposedQuiz`/`buildQuestion`/`actorImage`/`defaultBetMults`/`itemLabel`,
`applyComposed`/`saveComposed`/`exportComposed`/`useSavedQuiz`, `applyShuffles`,
`loadSavedQuizzes`/`saveQuizToDevice`/`deleteSavedQuiz`/`exportQuizJSON`. State: `app.compose*`,
`app.mcDraft`/`app.openDraft`, `app.film*`. The loose actor JPEGs in `img/` are now unused (dogs
moved to `dog-breeds/`) and can be deleted.

---

*Keep this file current. When you change a phase, a schema field, the media flow, or the
RTDB shape, update the matching section here in the same commit.*
