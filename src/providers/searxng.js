/**
 * SearXNG adapter — `GET {baseURL}/search?q=…&format=json`.
 *
 * Docs: https://docs.searxng.org/admin/search_api.html. SearXNG is a
 * metasearch engine you host yourself: no API key, no vendor lock-in — the
 * provider of last resort that keeps this router fully self-hostable. The
 * instance must enable the `json` format (`search.formats` in settings.yml);
 * instances that refuse it answer HTTP 403, which the router treats as a
 * normal provider failure and falls through. Result items carry `url` /
 * `title` / `content` (mapped to `snippet`) and sometimes `publishedDate`.
 * SearXNG has no count parameter, so the shared normalizer truncates.
 */
import { httpJSON, normalizeSources, joinURL } from "../lib.js";

/** The SearXNG backend descriptor (see src/router.js for the backend contract). */
export const searxng = {
  id: "searxng",
  defaultApiKeyEnv: undefined,
  defaultBaseURL: undefined,

  async search(request, armed, options) {
    const url = joinURL(armed.baseURL, "search");
    url.searchParams.set("q", request.query);
    url.searchParams.set("format", "json");
    const json = await httpJSON(url.href, {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": "dsh-search-router/0.1.0",
      },
    }, options);
    return normalizeSources(json?.results, request.maxResults);
  },
};
