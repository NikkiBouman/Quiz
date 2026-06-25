/* TMDB search proxy — keeps the TMDB read token server-side.
 * The browser calls THIS worker; the worker adds the token and forwards to TMDB.
 * Token lives in the Worker secret `TMDB_TOKEN` (set via `wrangler secret put TMDB_TOKEN`),
 * never in the client and never in this repo.
 *
 * Endpoints (all GET):
 *   /search?query=...              → movie search  (default, backward-compatible)
 *   /search?type=movie&query=...   → movie search  (explicit)
 *   /search?type=tv&query=...      → TV-series search (puzzle figures from series, not films).
 *   /search?type=person&query=...  → person search (resolve an actor name to a profile_path).
 *   /search?type=credits&id=862    → movie cast (top-billed actors of a film, for the film
 *                                    builder: each cast member has name + profile_path; the
 *                                    client builds image.tmdb.org URLs — photos never pass
 *                                    through this Worker).
 *   /search?type=details&id=862    → full movie details + credits + translations in one call
 *                                    (/movie/{id}?append_to_response=credits,translations): genres,
 *                                    runtime, vote_average, release_date, poster, cast+crew, and
 *                                    translated titles (so a non-Latin title can fall back to NL/EN).
 *                                    Feeds the media builder's info-facts and the actor hints.
 *                                    Photos still load straight from the CDN.
 *   …&media=tv                     → on details/credits, look up a TV series (/tv/{id}) instead of
 *                                    a movie. TV fields differ (name/first_air_date/episode_run_time);
 *                                    the client normalises them.
 */

const ALLOWED_ORIGINS = new Set([
  "https://nikkibouman.github.io", // GitHub Pages (production)
  "http://localhost:8000",         // local testing
  "http://127.0.0.1:8000",
]);

// Only these TMDB search kinds may be proxied. Keeps the Worker from becoming an open proxy.
const SEARCH_PATHS = {
  movie: "https://api.themoviedb.org/3/search/movie",
  tv: "https://api.themoviedb.org/3/search/tv",
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
    if (type === "credits" || type === "details") {
      // lookup by id: cast-only (/credits) or full details + credits (?append_to_response=credits).
      // media=tv → /tv/{id} (series); anything else → /movie/{id} (default, backward-compatible).
      const id = params.get("id");
      const media = params.get("media") === "tv" ? "tv" : "movie";
      if (!id || !/^\d+$/.test(id)) {
        return new Response(JSON.stringify({ cast: [], error: "invalid id" }), {
          status: 400,
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }
      tmdbUrl = type === "details"
        ? `https://api.themoviedb.org/3/${media}/${id}?language=nl-NL&append_to_response=credits,translations`
        : `https://api.themoviedb.org/3/${media}/${id}/credits?language=nl-NL`;
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
