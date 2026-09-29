/**
 * Route the native web_search tool through user-selected HTTP backends.
 * DSH owns configuration persistence and updates the live Config reference;
 * each search reads that reference without recreating the provider.
 */
import { parseConfig, createRouterProvider, BACKENDS } from "./router.js";
import { createConfig } from "./settings.js";

/** Cordis plugin name; the bundle uses the same unique entry id. */
export const name = "search-router";

/** Required capability seam. Settings remain optional for headless use. */
export const inject = ["web"];

/** DSH projects this schema into the search-router configuration form. */
export const Config = createConfig(BACKENDS, parseConfig);

/**
 * Register the router with live, validated configuration.
 * @param {object} ctx Cordis context supplying the web service.
 * @param {{ get(): object }} config Root volatile Config reference.
 */
export function apply(ctx, config) {
  ctx.web.registerSearchProvider(createRouterProvider(ctx, () => parseConfig(config.get())));
}
