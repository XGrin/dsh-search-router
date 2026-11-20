/**
 * The settings face of dsh-search-router: the plugin row's `Config` schema.
 *
 * Since DSH 0.2.2 the settings service (`SettingsForms`) no longer exposes a
 * `register(namespace, schema, …)` API for third-party sections — it derives
 * a form from the Loader entry's own `Config` schema (see `describe`,
 * `update`, `replace`, `mutate`). This module therefore exports the Config
 * schema for the row, in exactly the nested shape `parseConfig` validates,
 * so the written composition and the generated form agree.
 *
 * API keys are NOT part of the schema: they live in the credentials store or
 * the launching environment and are referenced by name (`apiKeyEnv`), so a
 * secret never reaches the composition document.
 */
import z from "@deepseek-ai/schemastery";

/**
 * The provider catalog, derived from the router's discovered backends: every
 * field of the Config schema and every shape the form renders comes from a
 * provider's own descriptor (`id`, `defaultApiKeyEnv`, `meta`, `defaultModel`),
 * so adding a provider file changes nothing here. The catalog closes over the
 * backend index it was built from — no module-level state, so two
 * registrations in one process never cross wires.
 *
 * @param {Record<string, object>} backends - the router's BACKENDS index.
 * @returns the catalog: sorted ids, keyed/keyless splits, and per-id lookups.
 */
export function providerCatalog(backends) {
  const ids = Object.keys(backends).sort((a, b) => (backends[a].meta?.sort ?? 99) - (backends[b].meta?.sort ?? 99) || a.localeCompare(b));
  return {
    ids,
    keyed: ids.filter((id) => backends[id].defaultApiKeyEnv !== undefined),
    keyless: ids.filter((id) => backends[id].defaultApiKeyEnv === undefined),
    envOf: (id) => backends[id].defaultApiKeyEnv,
    labelOf: (id) => backends[id].meta?.label ?? id,
    needsBaseUrl: (id) => backends[id].defaultBaseURL === undefined && backends[id].meta?.keyless !== true,
    /** True when the backend accepts a `model` override (parseConfig enforces this). */
    hasModel: (id) => backends[id].defaultModel !== undefined,
  };
}

/**
 * Build the plugin row's `Config` schema for one provider catalog. It mirrors
 * {@link parseConfig}'s accepted shape exactly:
 * - `provider` — one backend id, no fallback ("" = not chosen);
 * - `order` — the fallback chain, as an array of backend ids;
 * - `timeoutMs` / `emptyResultsFallback` — router-wide policy;
 * - `providers.<id>.apiKeyKey`-style fields — `apiKeyEnv` (credential
 *   REFERENCE, never the key), `baseURL` / `baseUrlEnv` (endpoint), and
 *   `model` where the backend declares a `defaultModel`.
 *
 * `provider` and `order` are each optional and mutually exclusive; the router
 * auto-detects the chain when neither is set. A malformed composition is
 * rejected by the schema at load, and by {@link parseConfig} in the plugin
 * body — the same shape, validated twice on purpose.
 *
 * @param {ReturnType<providerCatalog>} catalog - the provider catalog.
 * @returns {z} the Config schema.
 */
export const settingsConfig = (catalog) => {
  const { ids } = catalog;
  // NOTE: the inner fields are deliberately NOT `.volatile()` — schemastery
  // rejects a volatile field under a dict wildcard path ("volatile fields
  // require a fixed object path"). Marking `providers` itself volatile makes
  // volatileForm() accept the whole subtree, which is what the form needs.
  //
  // `apiKey` IS declared here, as `role('secret')`: DSH persists it under the
  // profile's secret store and strips it from every describe() response,
  // exposing only `{ path, set }` in the `secrets` sidecar. That is what lets
  // the form offer a key field without the value ever reaching the browser or
  // the composition document. `apiKeyEnv` still names an ambient credential,
  // and an explicit `apiKey` wins over it (see arm()).
  const providerSection = (id) => z.object({
    apiKey: z.string().role("secret"),
    apiKeyEnv: z.string(),
    baseUrlEnv: z.string(),
    baseURL: z.string(),
    // Only backends that declare a defaultModel accept `model`, which is
    // what parseConfig enforces.
    ...(catalog.hasModel(id) ? { model: z.string() } : {}),
  });
  // EVERY field is `.volatile()`, exactly like the shipped providers
  // (dsh-web, dsh-web-search-deepseek). This is what makes the settings page
  // render the form at all: SettingsForms.describe() runs `volatileForm()`
  // over each row's Config schema and KEEPS ONLY volatile fields — a plain
  // field is dropped, and a schema with no volatile field yields no form.
  return z.object({
    provider: z.union([z.const(""), ...ids.map((candidate) => z.const(candidate))]).default("").volatile(),
    order: z.array(z.string()).volatile(),
    timeoutMs: z.number().step(1).min(100).default(10000).volatile(),
    emptyResultsFallback: z.boolean().default(true).volatile(),
    // Keyed by provider id; parseConfig refuses ids outside the catalog.
    providers: z.dict(providerSection(ids[0])).volatile(),
  });
};

/**
 * Parse an `order` value into backend ids. Accepts an array (the Config
 * shape) or a comma/space-separated string (handy in a patch). Throws naming
 * the bad token, so a typo fails at load instead of silently emptying the
 * chain.
 *
 * @param {string | string[] | undefined} value - the order value.
 * @param {string[]} knownIds - the registered backend ids.
 * @returns {string[]} the parsed, deduped id list.
 */
export function parseOrderString(value, knownIds) {
  const tokens = Array.isArray(value)
    ? value.map((token) => String(token))
    : String(value ?? "").split(/[\s,]+/u);
  const ids = tokens.map((token) => token.trim()).filter((token) => token.length > 0);
  for (const id of ids) {
    if (!knownIds.includes(id)) {
      throw new Error(`search-router: unknown provider "${id}" in order (expected ${knownIds.join(", ")})`);
    }
  }
  return [...new Set(ids)];
}
