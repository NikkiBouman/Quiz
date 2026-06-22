/* TMDB search proxy — keeps the TMDB read token server-side.
 * The browser calls THIS worker; the worker adds the token and forwards to TMDB.
 * Token lives in the Worker secret `TMDB_TOKEN` (set via `wrangler secret put TMDB_TOKEN`),
 * never in the client and never in this repo.
 */

const ALLOWED_ORIGINS = new Set([
  "https://nikkibouman.github.io", // GitHub Pages (production)
  "http://localhost:8000",         // local testing
  "http://127.0.0.1:8000",
]);

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : "https://nikkibouman.github.io";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request.headers.get("Origin") || "");

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405, headers: cors });
    }

    const query = new URL(request.url).searchParams.get("query");
    if (!query) {
      return new Response(JSON.stringify({ results: [] }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const tmdbUrl =
      "https://api.themoviedb.org/3/search/movie?include_adult=false&language=nl-NL&page=1&query=" +
      encodeURIComponent(query);

    const res = await fetch(tmdbUrl, {
      headers: { Authorization: `Bearer ${env.TMDB_TOKEN}`, accept: "application/json" },
    });

    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: {
        ...cors,
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=86400", // cache identical searches for a day
      },
    });
  },
};
