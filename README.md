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

`serve.sh` niet gebruiken kan ook — elke statische server volstaat:

```bash
python3 -m http.server 8000
# of
npx serve .
```

> Het spel zelf praat met Firebase (live), dus voor een echte test met spelers heb je
> internet nodig. Quizzen bouwen en bewerken werkt volledig lokaal (localStorage).
