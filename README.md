# dsh-search-router

> dsh-search-router does not provide a search engine. It routes DSH's native
> `web_search` capability to user-configured search providers.

A tiny [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)
plugin: one native `WebSearchProvider` (id `search-router`) registered into
`ctx.web`, forwarding every `web_search` call to a search backend **you** choose
— with sequential fallback when one fails.

The model keeps seeing the same native `web_search` tool. No new tools, no MCP
server, no reranking, no caching — just a router. Zero runtime dependencies
(global `fetch` only).

```
DSH Agent → web_search → ctx.web → dsh-search-router → Exa / Tavily / Brave / SearXNG
```

## Supported providers

| Provider | Credential | Endpoint |
| --- | --- | --- |
| **Exa** | `EXA_API_KEY` | `https://api.exa.ai` (override: `providers.exa.baseURL`) |
| **Tavily** | `TAVILY_API_KEY` | `https://api.tavily.com` (override: `providers.tavily.baseURL`) |
| **Brave** | `BRAVE_SEARCH_API_KEY` | `https://api.search.brave.com` (override: `providers.brave.baseURL`) |
| **SearXNG** | — none, self-hosted | `SEARXNG_BASE_URL` or `providers.searxng.baseUrl` |

SearXNG keeps the router fully self-hostable: with your own instance you need
no commercial search API at all. The instance must enable the `json` output
format (`search.formats` in its `settings.yml`).

## Install

```bash
# from a local checkout
dsh plugin --profile web add link:/path/to/dsh-search-router

# or, once published
dsh plugin --profile web add dsh-search-router

dsh web
```

The plugin's composition patch (`cordis.patch.yml`) does three things:

1. inserts the `search-router` plugin row;
2. sets `web.searchProvider: search-router` so the seam resolves to the router;
3. disables the built-in `web-search-deepseek` row and re-enables the
   model-facing `web_search` tool (`tool-web`, which the shipped web profile
   keeps off).

Uninstall restores the original composition:

```bash
dsh plugin --profile web remove dsh-search-router
```

## Configure

Configuration lives in the profile's own patch layer —
`$DSH_HOME/profiles/web/cordis.patch.yml` (create it if absent; it applies
after every bundle layer). A patch **replaces** the row's whole `config`, so
state the complete block each time. With zero configuration the router
auto-detects any provider whose key/endpoint is ambient (see below) and tries
them in canonical order: exa → tavily → brave → searxng.

### Exa (single provider)

```yaml
- id: search-router
  config:
    provider: exa
    providers:
      exa:
        apiKeyEnv: EXA_API_KEY   # default; resolved from env / credential store
```

### Tavily with fallback to a self-hosted SearXNG

```yaml
- id: search-router
  config:
    order: [tavily, searxng]
    providers:
      tavily:
        apiKeyEnv: TAVILY_API_KEY
      searxng:
        baseUrl: https://search.example.com
```

### SearXNG only — no commercial keys anywhere

```yaml
- id: search-router
  config:
    provider: searxng
    providers:
      searxng:
        baseUrl: http://127.0.0.1:8888
```

### Full schema

```yaml
- id: search-router
  config:
    provider: exa            # single-provider mode: one id, no fallback
    order: [exa, tavily, searxng]  # fallback-chain mode (provider XOR order)
    timeoutMs: 10000         # per-provider timeout, default 10000
    emptyResultsFallback: true    # treat 0-result success as failure, default true
    providers:
      exa:    { apiKey: …, apiKeyEnv: EXA_API_KEY, baseURL: https://api.exa.ai }
      tavily: { apiKey: …, apiKeyEnv: TAVILY_API_KEY, baseURL: https://api.tavily.com }
      brave:  { apiKey: …, apiKeyEnv: BRAVE_SEARCH_API_KEY, baseURL: https://api.search.brave.com }
      searxng: { baseUrl: …, baseUrlEnv: SEARXNG_BASE_URL }
```

Prefer `apiKeyEnv` (or plain environment variables) over literal `apiKey`:
row configs can surface in `dsh --dump-config` output, and env refs keep
secrets out of files you might commit.

## Environment variables

| Variable | Used by | Meaning |
| --- | --- | --- |
| `EXA_API_KEY` | exa | API key (also the credential-store reference) |
| `TAVILY_API_KEY` | tavily | API key (also the credential-store reference) |
| `BRAVE_SEARCH_API_KEY` | brave | API key (also the credential-store reference) |
| `SEARXNG_BASE_URL` | searxng | Instance origin, e.g. `https://search.example.com` |

Keys resolve per search through DSH's own planes: the credentials service
first (managed store + ranked env layers), then the launch-environment
snapshot, then the ambient process env. `DEEPSEEK_API_KEY` is **never**
required — installing this plugin disables the DeepSeek search provider, so
web search works without any DeepSeek credential.

## Fallback

A provider counts as failed on network errors, timeouts, any non-2xx HTTP
status (401/403/429/5xx…), unparseable responses — and, by default, on empty
result lists (`emptyResultsFallback: false` to change). The router walks the
chain in order and returns the first non-empty success; the model never sees
the earlier failures. Only when every provider fails does `web_search` throw
one aggregated, key-free error:

```
search-router: all configured search providers failed:
- exa: HTTP 429
- tavily: timeout after 10000ms
- searxng: HTTP 503
```

If every provider answers successfully but empty, the truthful empty result is
returned instead of an error. Cancellation is honored across the whole chain.
Searches are strictly sequential — no parallel fan-out, by design.

## Verify

```bash
dsh web --dump-config | grep -A3 'id: search-router'   # row present
dsh web --dump-config | grep -A2 'id: web$'            # searchProvider: search-router
```

Then ask the agent something like “search the web for the latest DSH release”
and watch the log lines:

```
[dsh-search-router] exa failed: HTTP 429 — falling back to tavily
```

## Scope (and non-scope)

v0.1.0 is deliberately minimal: four adapters, one router, one composition
patch. Not included on purpose — reranking, RRF, merging, caching, history,
stats, fetch routing (`web_fetch` stays with DSH), query rewriting, custom
HTTP providers, parallel search. The `Backend` contract in `src/router.js` is
the seam where a new provider would slot in.

## Files

```
dsh-search-router/
├── package.json          # dsh.bundle.patch declaration
├── cordis.patch.yml      # composition: insert row, aim the seam, disable deepseek search
├── README.md
└── src/
    ├── index.js          # cordis plugin glue (name/inject/apply)
    ├── router.js         # chain selection, arming, fallback, aggregation
    ├── lib.js            # fetch+timeout+normalization helpers
    └── providers/        # exa.js, tavily.js, brave.js, searxng.js
```

## Development

`test/integration.mjs` exercises the router against the **real**
`@deepseek-ai/dsh-web` seam with local mock provider endpoints (429, timeout,
success, empty) — no network, no keys:

```bash
node test/integration.mjs /path/to/a/dsh/installation/node_modules
```

The directory must contain `@deepseek-ai/dsh-web` (any DSH install, e.g. an
npx cache or the profile's healed `node_modules`).
