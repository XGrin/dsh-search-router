/**
 * dsh-search-router — a DSH plugin that routes the native `web_search` tool
 * to user-configured search providers.
 *
 * It registers exactly one `WebSearchProvider` (id `search-router`) into the
 * web capability seam (`ctx.web`); the model keeps seeing the same native
 * `web_search` tool, and the composition patch beside this package points
 * `web.searchProvider` at the router. Search backends (Exa, Tavily, Brave,
 * SearXNG) are plain HTTP adapters over the global `fetch` — the plugin has
 * zero runtime dependencies and adds no tools, no MCP servers, and no
 * provider-specific fields to the model surface.
 *
 * This plugin does not provide a search engine. It routes DSH's native
 * web_search capability to user-configured search providers.
 */
import { parseConfig, createRouterProvider } from "./router.js";

/** Cordis plugin name used by loader diagnostics. */
export const name = "search-router";

/** The web seam this provider registers into. */
export const inject = ["web"];

/**
 * Register the router provider. Config validation happens here so a bad
 * composition fails loudly at load instead of silently at search time.
 *
 * @param {object} ctx - the plugin context (`web` is injected).
 * @param {unknown} config - the search-router row config (see parseConfig).
 */
export function apply(ctx, config) {
  const parsed = parseConfig(config);
  ctx.web.registerSearchProvider(createRouterProvider(ctx, parsed));
}
