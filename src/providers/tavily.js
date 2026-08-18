/**
 * Tavily adapter — `POST {baseURL}/search`.
 *
 * Docs: https://docs.tavily.com/api-reference/endpoint/search. The key
 * travels as `Authorization: Bearer …`; `max_results` is Tavily's native
 * count control. Response items carry `title` / `url` / `content` (mapped to
 * `snippet`) and sometimes `published_date`. The API can also synthesize an
 * answer (`include_answer`) — deliberately not requested in the MVP.
 */
import { httpJSON, normalizeSources, clampCount } from "../lib.js";

/** The Tavily backend descriptor (see src/router.js for the backend contract). */
export const tavily = {
  id: "tavily",
  defaultApiKeyEnv: "TAVILY_API_KEY",
  defaultBaseURL: "https://api.tavily.com",

  async search(request, armed, options) {
    const body = {
      query: request.query,
      max_results: clampCount(request.maxResults, 8, 20),
      search_depth: "basic",
    };
    const json = await httpJSON(`${armed.baseURL}/search`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${armed.apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
    }, options);
    return normalizeSources(json?.results, request.maxResults);
  },
};
