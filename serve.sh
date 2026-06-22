#!/usr/bin/env bash
# Start een lokale webserver zodat je de quiz kunt testen.
# De pagina's gebruiken native ES-modules; die werken alleen via http(s),
# niet via file://. Daarom een echte server (en niet "dubbelklik index.html").
#
# Gebruik:   ./serve.sh           (poort 8000)
#            ./serve.sh 5500       (andere poort)
set -e
PORT="${1:-8000}"
cd "$(dirname "$0")"

echo ""
echo "  Quiz draait lokaal op http://localhost:${PORT}"
echo "  ───────────────────────────────────────────"
echo "    Spel        →  http://localhost:${PORT}/index.html"
echo "    Quizzen     →  http://localhost:${PORT}/quizzes.html"
echo "    Vragenbank  →  http://localhost:${PORT}/questions.html"
echo ""
echo "  Stop met Ctrl+C."
echo ""

if command -v python3 >/dev/null 2>&1; then
  exec python3 -m http.server "$PORT"
elif command -v npx >/dev/null 2>&1; then
  exec npx --yes serve -l "$PORT" .
else
  echo "Geen python3 of npx gevonden. Installeer python3 of Node om lokaal te serveren." >&2
  exit 1
fi
