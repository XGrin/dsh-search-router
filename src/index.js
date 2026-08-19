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
 * Configuration has two layers over one router: the plugin row config in the
 * profile's composition (cordis.patch.yml — the full nested shape), and the
 * flat `search-router` settings section the Plugins settings page edits
 * (this package's browser half ships the card; API keys go through the
 * credentials domain, never into the settings document). The provider
 * re-resolves the merged config at every search, so either layer's changes
 * are live without a restart.
 *
 * This plugin does not provide a search engine. It routes DSH's native
 * web_search capability to user-configured search providers.
 */
import { parseConfig, createRouterProvider, BACKENDS } from "./router.js";
import { SETTINGS_NS, settingsConfig, projectBase, mergeRuntime, validateSection, providerCatalog } from "./settings.js";

/** Cordis plugin name used by loader diagnostics. */
export const name = "search-router";

/** The web seam this provider registers into. */
export const inject = ["web"];

/**
 * Register the router provider and, when the settings service is available,
 * serve the `search-router` settings section over it. The inner inject keeps
 * settings optional: a composition without the settings service still gets a
 * working router driven purely by its row config.
 *
 * @param {object} ctx - the plugin context (`web` is injected).
 * @param {unknown} config - the search-router row config (see parseConfig).
 */
export function apply(ctx, config) {
  const composition = parseConfig(config);
  const catalog = providerCatalog(BACKENDS);
  const base = projectBase(catalog)(composition);
  let section;
  ctx.inject(["settings"], (sctx) => {
    const scope = sctx.settings.register(SETTINGS_NS, settingsConfig(catalog), {
      base,
      validate: validateSection(catalog),
    });
    section = () => scope.get();
    sctx.effect(() => () => {
      section = undefined;
    }, "search-router: settings section");
  });
  ctx.web.registerSearchProvider(createRouterProvider(ctx, () => mergeRuntime(catalog)(composition, section?.(), base)));
}
