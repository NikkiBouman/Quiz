# TMDB search proxy

A tiny Cloudflare Worker that holds the TMDB read token server-side, so it never
ships to the browser. The quiz's movie search (`:tmdb`) calls this worker instead
of `api.themoviedb.org` directly.

## One-time deploy

All commands run from inside this folder (`tmdb-proxy/`).

```bash
cd tmdb-proxy

# 1. Log in to Cloudflare (opens a browser; free account is fine)
npx wrangler login

# 2. Store the TMDB token as a secret (paste the token when prompted).
#    For the safe cutover, use the CURRENT token here first — see "Cutover order".
npx wrangler secret put TMDB_TOKEN

# 3. Deploy
npx wrangler deploy
```

`wrangler deploy` prints the live URL, e.g.:

```
https://quiz-tmdb-proxy.<your-subdomain>.workers.dev
```

Give me that URL — I'll wire it into `index.html` (replacing the old token).

## Cutover order (so the live site never breaks)

1. Deploy the worker with the **current** TMDB token as the secret. Search now
   works through the proxy.
2. Point `index.html` at the worker URL and push. The live site no longer
   contains the token.
3. **Now** rotate: regenerate the token in your TMDB account, then
   `npx wrangler secret put TMDB_TOKEN` again with the new value and redeploy.
   The old (leaked) token is dead; the new one only ever exists in the worker.

## Notes

- Only `https://nikkibouman.github.io` (and localhost) may call the worker — see
  `ALLOWED_ORIGINS` in `worker.js`. Add origins there if you host elsewhere.
- TMDB poster images (`image.tmdb.org`) are public and need no token, so they
  still load directly from the client.
- The token is never committed — it lives only in the Cloudflare secret store.
