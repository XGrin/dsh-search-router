/**
 * dsh-search-router — a DSH plugin that routes the native `web_search` tool
 * to user-configured search providers.
 *
 * It registers exactly one `WebSearchProvider` (id `search-router`) into the
 * web capability seam (`ctx.web`); the model keeps seeing the same native
 * `web_search` tool, and the composition patch beside this package points
 * `web.searchProvider` at the router. Search backends — one file each under
 * src/providers/ — are plain HTTP adapters over the global `fetch`; the
 * plugin adds no tools, no MCP servers, and no provider-specific fields to
 * the model surface.
 *
 * Configuration is the plugin row config in the profile's composition
 * (cordis.patch.yml — the full nested shape). Since DSH 0.2.2 the settings
 * service no longer hosts third-party namespaces: config editing happens
 * through the Loader entry's own `Config` schema, which the settings service
 * derives a form from. This plugin therefore declares `Config` (validated by
 * parseConfig) and lets the profile patch be the editable surface. The
 * provider re-resolves that config at every search.
 *
 * This plugin does not provide a search engine. It routes DSH's native
 * web_search capability to user-configured search providers.
 */
import { parseConfig, createRouterProvider, BACKENDS } from "./router.js";
import { settingsConfig, providerCatalog } from "./settings.js";

/** Cordis plugin name used by loader diagnostics. */
export const name = "search-router";

/** The web seam this provider registers into. */
export const inject = ["web"];

/**
 * The plugin row's Config schema: the nested shape parseConfig validates,
 * expressed as schemastery so DSH can offer a generated settings form and so
 * a malformed composition fails at load with a field-level message.
 */
export const Config = settingsConfig(providerCatalog(BACKENDS));

/**
 * Register the router provider. The router reads the composition config
 * directly; the provider re-arms credentials at every search, so a key that
 * appears in the ambient environment or managed store is picked up live.
 *
 * @param {object} ctx - the plugin context (`web` is injected).
 * @param {unknown} config - the search-router row config (see parseConfig).
 */
export function apply(ctx, config) {
  const composition = parseConfig(config);
  ctx.web.registerSearchProvider(createRouterProvider(ctx, () => composition));
}
