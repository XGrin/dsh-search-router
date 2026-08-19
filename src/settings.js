/**
 * The settings face of dsh-search-router: the flat schema the Plugins
 * settings page edits, the projection of the composition config into that
 * flat shape, and the merge that folds a resolved settings section back over
 * the composition — so the GUI and the profile's cordis.patch.yml are two
 * layers over one router, with the GUI winning per field.
 *
 * The schema is deliberately flat and scalar: the client settings scope
 * writes one top-level field per operation, so every editable knob is a
 * top-level field. Provider endpoint/key overrides that only a composition
 * author needs (per-provider baseURL literals, nested provider sections)
 * stay in the plugin row config; the GUI covers the knobs a user owns:
 * which provider(s) run, the timeout, the empty-results policy, the SearXNG
 * endpoint, and the three commercial API keys (through the credentials
 * domain, never inside the settings document).
 */
import z from "@deepseek-ai/schemastery";

/** Settings namespace this plugin serves (== the plugin's short name). */
export const SETTINGS_NS = "search-router";

/** Known backend ids, in canonical auto-detection order. */
export const BACKEND_IDS = ["exa", "tavily", "brave", "searxng"];

/** Default env-var names for the three commercial keys. */
export const DEFAULT_KEY_ENVS = {
  exa: "EXA_API_KEY",
  tavily: "TAVILY_API_KEY",
  brave: "BRAVE_SEARCH_API_KEY",
};

/**
 * The settings section schema. Field semantics:
 * - `provider` — single-backend mode ("" = not chosen here);
 * - `order` — fallback-chain mode as a comma/space-separated id list
 *   ("" = not chosen here); exactly one of provider/order may be set;
 * - `timeoutMs` — per-provider timeout;
 * - `emptyResultsFallback` — treat a 0-result success as a failure;
 * - `*ApiKey` — a stored key that OVERRIDES the environment/credential
 *   reference for that provider (`role('secret')`: the wire redacts it, the
 *   settings document persists it); absent = resolve from the environment;
 * - `*ApiKeyEnv` — credential-reference names the router resolves per search;
 * - `searxngBaseUrl` / `searxngBaseUrlEnv` — the self-hosted endpoint.
 */
export const SettingsConfig = z.object({
  provider: z.union([z.const(""), z.const("exa"), z.const("tavily"), z.const("brave"), z.const("searxng")]).default(""),
  order: z.string().default(""),
  timeoutMs: z.number().step(1).min(100).default(10000),
  emptyResultsFallback: z.boolean().default(true),
  exaApiKey: z.string().role("secret"),
  tavilyApiKey: z.string().role("secret"),
  braveApiKey: z.string().role("secret"),
  exaApiKeyEnv: z.string().role("credential-ref").default(DEFAULT_KEY_ENVS.exa),
  tavilyApiKeyEnv: z.string().role("credential-ref").default(DEFAULT_KEY_ENVS.tavily),
  braveApiKeyEnv: z.string().role("credential-ref").default(DEFAULT_KEY_ENVS.brave),
  searxngBaseUrl: z.string().default(""),
  searxngBaseUrlEnv: z.string().default(""),
});

/**
 * Parse an `order` string into backend ids. Throws naming the bad token so
 * the settings service can refuse the write that produced it.
 *
 * @param {string} text - comma/space-separated backend ids.
 * @returns {string[]} the parsed, deduped id list.
 */
export function parseOrderString(text) {
  const ids = String(text ?? "").split(/[\s,]+/u).filter((token) => token.length > 0);
  for (const id of ids) {
    if (!BACKEND_IDS.includes(id)) {
      throw new Error(`search-router: unknown provider "${id}" in order (expected ${BACKEND_IDS.join(", ")})`);
    }
  }
  return [...new Set(ids)];
}

/**
 * Cross-field validation for the settings register: exactly one of
 * provider/order, and the order list must parse. Runs on every write, so a
 * bad value is refused at save time rather than disabling the router.
 *
 * @param {object} section - the resolved settings section.
 */
export function validateSection(section) {
  if (section.provider !== "" && section.order.trim() !== "") {
    throw new Error('search-router: set either "provider" (single) or "order" (fallback chain), not both');
  }
  if (section.order.trim() !== "") {
    // ", ," parses to zero providers; an order that names nothing would
    // silently empty the chain, so refuse it at the same layer the
    // composition's parseConfig refuses an empty array.
    if (parseOrderString(section.order).length === 0) {
      throw new Error(`search-router: "order" names no providers (expected ${BACKEND_IDS.join(", ")})`);
    }
  }
  const searxngUrl = String(section.searxngBaseUrl ?? "").trim();
  if (searxngUrl !== "") {
    let parsed;
    try {
      parsed = new URL(searxngUrl);
    } catch {
      throw new Error("search-router: searxngBaseUrl must be a valid http(s) URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("search-router: searxngBaseUrl must be an http(s) URL");
    }
  }
  for (const field of ["exaApiKey", "tavilyApiKey", "braveApiKey"]) {
    if (section[field] !== undefined && String(section[field]).trim() === "") {
      throw new Error(`search-router: ${field} must be non-empty when set (unset it to fall back to the environment)`);
    }
  }
}

/**
 * Project the composition config into the flat settings shape, used as the
 * settings register's `base` layer: schema defaults < this base < user layer.
 * Every field is filled, so a resolved field equal to its base value means
 * "the user layer did not choose" and the composition value stays in force.
 *
 * @param {object} composition - the normalized plugin row config.
 * @returns {object} the flat base layer.
 */
export function projectBase(composition) {
  const section = (id) => composition.providers[id] ?? {};
  return {
    provider: composition.provider ?? "",
    order: (composition.order ?? []).join(", "),
    timeoutMs: composition.timeoutMs,
    emptyResultsFallback: composition.emptyResultsFallback,
    exaApiKeyEnv: section("exa").apiKeyEnv ?? DEFAULT_KEY_ENVS.exa,
    tavilyApiKeyEnv: section("tavily").apiKeyEnv ?? DEFAULT_KEY_ENVS.tavily,
    braveApiKeyEnv: section("brave").apiKeyEnv ?? DEFAULT_KEY_ENVS.brave,
    searxngBaseUrl: section("searxng").baseURL ?? "",
    searxngBaseUrlEnv: section("searxng").baseUrlEnv ?? "",
  };
}

/**
 * Fold one resolved settings section over the composition config, producing
 * the effective router config (the shape {@link parseConfig} emits). A field
 * the user layer set differs from the base layer this section was resolved
 * against — that difference, not the resolved value alone, is what marks an
 * override, because schema defaults and the composition base both fill the
 * resolved section regardless of user choice.
 *
 * @param {object} composition - the normalized plugin row config.
 * @param {object | undefined} resolved - the resolved settings section, or
 *   undefined when the settings service is not available (pure composition).
 * @param {object} base - the base layer the section was resolved against
 *   (see {@link projectBase}); pass the same value used at registration.
 * @returns {object} the effective router config.
 */
export function mergeRuntime(composition, resolved, base) {
  if (resolved === undefined) return composition;
  const chosen = (field) => resolved[field] !== base[field];
  const merged = {
    timeoutMs: chosen("timeoutMs") ? resolved.timeoutMs : composition.timeoutMs,
    emptyResultsFallback: chosen("emptyResultsFallback") ? resolved.emptyResultsFallback : composition.emptyResultsFallback,
    providers: structuredClone(composition.providers),
  };
  // Routing precedence: a user-chosen fallback chain beats everything; next
  // a user-chosen single provider ("" = deliberately automatic, which also
  // clears a composition chain); with neither chosen, the composition's
  // routing stands. The section's own validate refuses provider+order set
  // together in one layer, but a composition/section mix reaches here and
  // must resolve the same way the GUI presents it: settings win.
  const orderChosen = chosen("order") && resolved.order.trim() !== "";
  const providerChosen = chosen("provider");
  if (orderChosen) {
    merged.order = parseOrderString(resolved.order);
  } else if (providerChosen) {
    if (resolved.provider !== "") merged.provider = resolved.provider;
  } else if (composition.provider !== undefined) {
    merged.provider = composition.provider;
  } else if (composition.order !== undefined) {
    merged.order = composition.order;
  }
  const section = (id) => {
    merged.providers[id] ??= {};
    return merged.providers[id];
  };
  // A key stored in the settings document is the strongest key source: it
  // lands as the section's literal `apiKey`, which `arm()` resolves before
  // the credential reference — so it overrides both the managed credential
  // store and the ambient environment. Unsetting the field removes the
  // override and falls back to them.
  for (const [field, id] of Object.entries({ exaApiKey: "exa", tavilyApiKey: "tavily", braveApiKey: "brave" })) {
    if (chosen(field)) section(id).apiKey = resolved[field] === undefined ? undefined : resolved[field];
  }
  if (chosen("exaApiKeyEnv")) section("exa").apiKeyEnv = resolved.exaApiKeyEnv;
  if (chosen("tavilyApiKeyEnv")) section("tavily").apiKeyEnv = resolved.tavilyApiKeyEnv;
  if (chosen("braveApiKeyEnv")) section("brave").apiKeyEnv = resolved.braveApiKeyEnv;
  if (chosen("searxngBaseUrl")) section("searxng").baseURL = resolved.searxngBaseUrl === "" ? undefined : resolved.searxngBaseUrl;
  if (chosen("searxngBaseUrlEnv")) section("searxng").baseUrlEnv = resolved.searxngBaseUrlEnv === "" ? undefined : resolved.searxngBaseUrlEnv;
  return merged;
}
