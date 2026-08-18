/**
 * Brave Search adapter — `GET {baseURL}/res/v1/web/search?q=…&count=…`.
 *
 * Docs: https://api-dashboard.search.brave.com/app/documentation/web-search-query.
 * The key travels in the `X-Subscription-Token` header. Results live under
 * `web.results` and carry `title` / `url` / `description` ( Brave bold-marks
 * queries with <b> tags — stripped here) and sometimes `page_age` / `age`.
 */
import { httpJSON, normalizeSources, clampCount, joinURL } from "../lib.js";

/** The Brave backend descriptor (see src/router.js for the backend contract). */
export const brave = {
  id: "brave",
  defaultApiKeyEnv: "BRAVE_SEARCH_API_KEY",
  defaultBaseURL: "https://api.search.brave.com",

  async search(request, armed, options) {
    const url = joinURL(armed.baseURL, "res/v1/web/search");
    url.searchParams.set("q", request.query);
    url.searchParams.set("count", String(clampCount(request.maxResults, 8, 20)));
    const json = await httpJSON(url.href, {
      method: "GET",
      headers: {
        "x-subscription-token": armed.apiKey,
        accept: "application/json",
        "user-agent": "dsh-search-router/0.1.0",
      },
    }, options);
    return normalizeSources(json?.web?.results, request.maxResults);
  },
};
