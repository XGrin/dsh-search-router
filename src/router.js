/**
 * The search router: one DSH `WebSearchProvider` (id `search-router`) that
 * forwards each `web_search` call to a user-configured chain of search
 * backends, falling through to the next backend on failure.
 *
 * Backend contract (one object per src/providers/*.js):
 *   {
 *     id: string,                       // 'exa' | 'tavily' | 'brave' | 'searxng'
 *     defaultApiKeyEnv?: string,        // credential ref / env var name
 *     defaultBaseURL?: string,          // API origin (searxng has none — user-supplied)
 *     async search(request, armed, options): Promise<{ sources, content? }>
 *   }
 * `armed` is `{ apiKey?: string, baseURL: string }` resolved by the router
 * right before the call; `options` is `{ signal, timeoutMs }`. A backend
 * reports failure by throwing — the router owns every fallback decision.
 *
 * Selection modes (from the plugin config):
 *   - `order: [exa, tavily, searxng]` — sequential fallback chain;
 *   - `provider: exa` — that one backend, no fallback;
 *   - neither — every backend whose credential/endpoint is locally
 *     discoverable, in canonical order (exa, tavily, brave, searxng).
 *
 * A backend counts as failed on network errors, timeouts, HTTP 401/403/429/
 * 5xx (any non-2xx in fact), unparseable responses — and, by default, on
 * empty result lists. When every backend yields an empty-but-successful
 * response, the (truthful) empty result is returned instead of an error.
 */
import { DEFAULT_TIMEOUT_MS, callerAborted, isCallerAborted } from "./lib.js";
import { exa } from "./providers/exa.js";
import { tavily } from "./providers/tavily.js";
import { brave } from "./providers/brave.js";
import { searxng } from "./providers/searxng.js";

/** The backends this router knows, in canonical auto-detection order. */
const BACKENDS = { exa, tavily, brave, searxng };

/** The id the router registers under in the DSH web seam. */
export const SEARCH_ROUTER_PROVIDER_ID = "search-router";

/** Default result count passed to providers that support a count control. */
const DEFAULT_MAX_RESULTS = 8;

/**
 * Validate and normalize the plugin config. Throws descriptive errors —
 * a typo in the composition should fail loudly at load, never silently
 * no-op. Shape:
 *
 *   {
 *     provider?: 'exa' | 'tavily' | 'brave' | 'searxng',
 *     order?: string[],
 *     timeoutMs?: number,                 // per-provider, default 10000
 *     emptyResultsFallback?: boolean,     // default true
 *     providers?: {
 *       exa?:    { apiKey?, apiKeyEnv?, baseURL? },
 *       tavily?: { apiKey?, apiKeyEnv?, baseURL? },
 *       brave?:  { apiKey?, apiKeyEnv?, baseURL? },
 *       searxng: { baseUrl? | baseURL?, baseUrlEnv? },
 *     },
 *   }
 *
 * @param {unknown} raw - the row config cordis passed to apply().
 * @returns {object} the normalized config.
 */
export function parseConfig(raw) {
  const config = raw ?? {};
  if (typeof config !== "object" || Array.isArray(config)) {
    throw new Error("search-router: config must be an object");
  }
  const { provider, order, timeoutMs, emptyResultsFallback, providers, ...unknown } = config;
  for (const key of Object.keys(unknown)) {
    throw new Error(`search-router: unknown config key "${key}" (expected provider, order, timeoutMs, emptyResultsFallback, providers)`);
  }
  if (provider !== undefined && !isBackendId(provider)) {
    throw new Error(`search-router: unknown provider "${provider}" (expected ${ids().join(", ")})`);
  }
  if (order !== undefined) {
    if (!Array.isArray(order) || order.length === 0 || order.some((id) => !isBackendId(id))) {
      throw new Error(`search-router: order must be a non-empty array of provider ids (expected ${ids().join(", ")})`);
    }
  }
  if (provider !== undefined && order !== undefined) {
    throw new Error("search-router: configure either provider (single) or order (fallback chain), not both");
  }
  if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 100)) {
    throw new Error("search-router: timeoutMs must be an integer >= 100 (milliseconds)");
  }
  if (emptyResultsFallback !== undefined && typeof emptyResultsFallback !== "boolean") {
    throw new Error("search-router: emptyResultsFallback must be a boolean");
  }
  return {
    provider,
    order: order === undefined ? undefined : [...new Set(order)],
    timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
    emptyResultsFallback: emptyResultsFallback ?? true,
    providers: parseProviderSections(providers),
  };
}

/** Validate the per-provider sections; unknown ids and keys are rejected. */
function parseProviderSections(providers) {
  if (providers === undefined) return {};
  if (typeof providers !== "object" || Array.isArray(providers)) {
    throw new Error("search-router: providers must be an object keyed by provider id");
  }
  const parsed = {};
  for (const [id, section] of Object.entries(providers)) {
    if (!isBackendId(id)) {
      throw new Error(`search-router: unknown provider section "${id}" (expected ${ids().join(", ")})`);
    }
    if (typeof section !== "object" || section === null || Array.isArray(section)) {
      throw new Error(`search-router: providers.${id} must be an object`);
    }
    const { apiKey, apiKeyEnv, baseURL, baseUrl, baseUrlEnv, ...unknown } = section;
    for (const key of Object.keys(unknown)) {
      throw new Error(`search-router: unknown key "${key}" in providers.${id}`);
    }
    parsed[id] = {
      apiKey: optionalString(apiKey, `providers.${id}.apiKey`),
      apiKeyEnv: optionalString(apiKeyEnv, `providers.${id}.apiKeyEnv`),
      baseURL: normalizeOptionalURL(baseURL ?? baseUrl, `providers.${id}.baseURL`),
      baseUrlEnv: optionalString(baseUrlEnv, `providers.${id}.baseUrlEnv`),
    };
  }
  return parsed;
}

/** The registered backend ids in canonical order. */
function ids() {
  return Object.keys(BACKENDS);
}

/** True for a known backend id. */
function isBackendId(id) {
  return typeof id === "string" && id in BACKENDS;
}

/** A non-empty string or undefined; anything else throws. */
function optionalString(value, field) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new Error(`search-router: ${field} must be a non-empty string`);
  return value;
}

/** An http(s) URL or undefined; anything else throws. */
function normalizeOptionalURL(value, field) {
  const text = optionalString(value, field);
  if (text === undefined) return undefined;
  const url = new URL(text);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`search-router: ${field} must be an http(s) URL`);
  }
  return text.replace(/\/+$/u, "");
}

/**
 * Build the router provider. Credential and endpoint resolution goes through
 * DSH's own planes when present — the credentials service first (it owns the
 * managed store and already ranks env layers), then the launch environment
 * snapshot, then the ambient process env — so keys never live in code and
 * `apiKeyEnv` doubles as the credential reference, exactly like the shipped
 * web-search-deepseek provider.
 *
 * @param {object} ctx - the plugin context (`web` is injected).
 * @param {object} config - the normalized plugin config.
 * @returns {object} the `search-router` WebSearchProvider.
 */
export function createRouterProvider(ctx, config) {
  const log = typeof ctx.logger === "function" ? ctx.logger("dsh-search-router") : ctx.logger;

  /** Resolve one variable through the launch snapshot, then process.env. */
  const ambient = (name) => {
    const value = ctx.get("launchEnvironment")?.get(name)?.value ?? process.env[name];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };

  /** Resolve one secret: credentials service over ambient environment. */
  const resolveSecret = async (name) => {
    const credentials = ctx.get("credentials");
    if (credentials !== undefined) {
      try {
        const resolved = await credentials.resolve(name);
        if (resolved?.value !== undefined && resolved.value.length > 0) return resolved.value;
      } catch {
        /* fall through to the ambient environment */
      }
    }
    return ambient(name);
  };

  /** The backend chain per the CURRENT config (cheap, sync, no network). */
  const chain = () => {
    if (config.order !== undefined) return config.order;
    if (config.provider !== undefined) return [config.provider];
    return ids().filter((id) => locallyConfigured(id));
  };

  /**
   * Cheap sync usability check for auto-detection and the seam's
   * `available()`: a literal config key or an ambient env value. Backends
   * reachable only through the managed credentials store are intentionally
   * not auto-detected — set `provider`/`order` explicitly for those.
   */
  const locallyConfigured = (id) => {
    const section = config.providers[id] ?? {};
    if (BACKENDS[id].defaultApiKeyEnv === undefined) {
      return (section.baseURL ?? ambient(section.baseUrlEnv ?? "SEARXNG_BASE_URL")) !== undefined;
    }
    return (section.apiKey ?? ambient(section.apiKeyEnv ?? BACKENDS[id].defaultApiKeyEnv)) !== undefined;
  };

  /** Resolve everything one backend needs right before calling it. */
  const arm = async (id) => {
    const section = config.providers[id] ?? {};
    const backend = BACKENDS[id];
    const keyed = backend.defaultApiKeyEnv !== undefined;
    const apiKey = keyed ? section.apiKey ?? await resolveSecret(section.apiKeyEnv ?? backend.defaultApiKeyEnv) : undefined;
    const baseURL = section.baseURL
      ?? (keyed ? undefined : ambient(section.baseUrlEnv ?? "SEARXNG_BASE_URL"));
    return { apiKey, baseURL: baseURL ?? backend.defaultBaseURL };
  };

  return {
    id: SEARCH_ROUTER_PROVIDER_ID,

    available() {
      return chain().length > 0;
    },

    async search(request, signal) {
      if (signal?.aborted === true) throw callerAborted(signal);
      const ids_ = chain();
      if (ids_.length === 0) {
        throw new Error(
          "search-router: no search provider is configured — set provider/order in the search-router config, "
          + "or export EXA_API_KEY / TAVILY_API_KEY / BRAVE_SEARCH_API_KEY / SEARXNG_BASE_URL",
        );
      }
      const failures = [];
      let emptiest;
      for (let index = 0; index < ids_.length; index += 1) {
        const id = ids_[index];
        const backend = BACKENDS[id];
        const armed = await arm(id);
        if ((backend.defaultApiKeyEnv !== undefined && armed.apiKey === undefined) || armed.baseURL === undefined) {
          const hint = backend.defaultApiKeyEnv === undefined
            ? `missing endpoint (set providers.searxng.baseUrl or export ${section0(config, id).baseUrlEnv ?? "SEARXNG_BASE_URL"})`
            : `missing API key (set providers.${id}.apiKey, or export ${section0(config, id).apiKeyEnv ?? backend.defaultApiKeyEnv})`;
          failures.push(`${id}: ${hint}`);
          log?.info?.(`${id}: ${hint} — skipped${next(id, ids_)}`);
          continue;
        }
        if (signal?.aborted === true) throw callerAborted(signal);
        try {
          const result = await backend.search(
            { query: request.query, maxResults: request.maxResults ?? DEFAULT_MAX_RESULTS },
            armed,
            { signal, timeoutMs: config.timeoutMs },
          );
          if (result.sources.length === 0 && config.emptyResultsFallback) {
            failures.push(`${id}: 0 results`);
            emptiest = result;
            log?.info?.(`${id}: 0 results${next(id, ids_)}`);
            continue;
          }
          return {
            sources: result.sources,
            truncated: result.truncated ?? false,
            ...result.content !== undefined ? { content: result.content } : {},
          };
        } catch (error) {
          if (isCallerAborted(error) || signal?.aborted === true) throw callerAborted(signal);
          failures.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
          log?.info?.(`${id} failed: ${error instanceof Error ? error.message : String(error)}${next(id, ids_)}`);
        }
      }
      if (emptiest !== undefined) return { sources: emptiest.sources, truncated: emptiest.truncated ?? false };
      throw new Error(`search-router: all configured search providers failed:\n${failures.map((f) => `- ${f}`).join("\n")}`);
    },
  };
}

/** The provider section for `id`, or `{}` (kept tiny; used for error hints). */
function section0(config, id) {
  return config.providers[id] ?? {};
}

/** `" — falling back to <next>"` when another backend follows, else `""`. */
function next(id, ids) {
  const following = ids[ids.indexOf(id) + 1];
  return following === undefined ? "" : ` — falling back to ${following}`;
}
