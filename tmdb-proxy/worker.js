/* TMDB search proxy — keeps the TMDB read token server-side.
 * The browser calls THIS worker; the worker adds the token and forwards to TMDB.
 * Token lives in the Worker secret `TMDB_TOKEN` (set via `wrangler secret put TMDB_TOKEN`),
 * never in the client and never in this repo.
 *
 * Endpoints (all GET):
 *   /search?query=...              → movie search  (default, backward-compatible)
 *   /search?type=movie&query=...   → movie search  (explicit)
 *   /search?type=person&query=...  → person search (resolve an actor name to a profile_path).
 *   /search?type=credits&id=862    → movie cast (top-billed actors of a film, for the film
 *                                    builder: each cast member has name + profile_path; the
 *                                    client builds image.tmdb.org URLs — photos never pass
 *                                    through this Worker).
 */

const ALLOWED_ORIGINS = new Set([
  "https://nikkibouman.github.io", // GitHub Pages (production)
  "http://localhost:8000",         // local testing
  "http://127.0.0.1:8000",
]);

// Only these TMDB search kinds may be proxied. Keeps the Worker from becoming an open proxy.
const SEARCH_PATHS = {
  movie: "https://api.themoviedb.org/3/search/movie",
  person: "https://api.themoviedb.org/3/search/person",
};

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

    const params = new URL(request.url).searchParams;
    const query = params.get("query");
    const type = params.get("type") || "movie";

    let tmdbUrl;
    if (type === "credits") {
      // movie cast lookup: /search?type=credits&id=862
      const id = params.get("id");
      if (!id || !/^\d+$/.test(id)) {
        return new Response(JSON.stringify({ cast: [], error: "invalid id" }), {
          status: 400,
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }
      tmdbUrl = `https://api.themoviedb.org/3/movie/${id}/credits?language=nl-NL`;
    } else {
      const base = SEARCH_PATHS[type];
      if (!base) {
        return new Response(JSON.stringify({ results: [], error: "unsupported type" }), {
          status: 400,
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }
      if (!query) {
        return new Response(JSON.stringify({ results: [] }), {
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }
      tmdbUrl = `${base}?include_adult=false&language=nl-NL&page=1&query=` + encodeURIComponent(query);
    }

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
