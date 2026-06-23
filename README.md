# Quiz

Een browser-based multiplayer party-quiz (Jackbox/Kahoot-stijl). Eén **host** op een groot
scherm, **spelers** doen mee met hun telefoon via een 4-letter-code, een optioneel **jurylid**
beoordeelt open antwoorden. Geen build-stap: het zijn statische bestanden.

- `index.html` — het spel (host / speler / jury)
- `quizzes.html` — bouw en bewerk je eigen quizzen
- `questions.html` — je persoonlijke vragenbank

Zie [ARCHITECTURE.md](ARCHITECTURE.md) voor de volledige uitleg.

## Lokaal draaien om te testen

De pagina's gebruiken native ES-modules; die werken **alleen via http**, niet via
`file://`. Start daarom een lokale server:

```bash
./serve.sh            # draait op http://localhost:8000
./serve.sh 5500       # of kies een andere poort
```

Open daarna **http://localhost:8000/index.html** (host het spel) of
**http://localhost:8000/quizzes.html** (bouw een quiz).

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
