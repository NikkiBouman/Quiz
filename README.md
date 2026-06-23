# Quiz

Een browser-based multiplayer party-quiz (Jackbox/Kahoot-stijl). Eén **host** op een groot
scherm, **spelers** doen mee met hun telefoon via een 4-letter-code, een optioneel **jurylid**
beoordeelt open antwoorden. Geen build-stap: het zijn statische bestanden.

- `index.html` — het spel (host / speler / jury)
- `account/` — beheer (landingspagina met links naar de twee onderstaande)
  - `account/quizzes/` — je quizzen (lijst) · `account/quizzes/new/` — quiz maken/bewerken
  - `account/questions/` — je vragenbank (lijst) · `account/questions/new/?type=film` — vraag maken
- `lib/` — gedeelde code: `quiz-core.js` (data/opslag/API), `editor-ui.js` (gedeelde
  beheer-UI), `drag.js` (slepen), `style.css`

> Lijst en maak-scherm zijn aparte, bezoekbare paden (bookmarkbaar, browser-terug werkt). In een
> maak-/bewerk-scherm staan linksboven **Terug zonder opslaan** en **Opslaan**; op de lijst- en
> homepagina staat rechtsboven het hamburgermenu (Home · Quizzen · Vragen, huidige pagina actief).

> De oude `quizzes.html` / `questions.html` bestaan nog als doorverwijzing naar de
> nieuwe `account/`-paden, zodat bestaande links blijven werken.

Zie [ARCHITECTURE.md](ARCHITECTURE.md) voor de volledige uitleg.

## Lokaal draaien om te testen

De pagina's gebruiken native ES-modules; die werken **alleen via http**, niet via
`file://`. Start daarom een lokale server:

```bash
./serve.sh            # draait op http://localhost:8000
./serve.sh 5500       # of kies een andere poort
```

Open daarna **http://localhost:8000/index.html** (host het spel) of
**http://localhost:8000/account/quizzes/** (bouw een quiz).

`serve.sh` niet gebruiken kan ook — elke statische server volstaat, **mits op poort 8000**:

```bash
python3 -m http.server 8000
# of
npx serve -l 8000 .
```

> Let op de poort: de TMDB-zoekproxy (Cloudflare Worker) heeft een CORS-allowlist die
> alleen `http://localhost:8000` en `http://127.0.0.1:8000` toestaat. `npx serve .` zónder
> `-l 8000` draait op een andere poort, waardoor de browser de proxy-response blokkeert en
> film-zoeken faalt ("Zoeken mislukt"). Quizzen bouwen werkt dan wel; alleen `:tmdb`-zoeken niet.

> Het spel zelf praat met Firebase (live), dus voor een echte test met spelers heb je
> internet nodig. Quizzen bouwen en bewerken werkt volledig lokaal (localStorage).
