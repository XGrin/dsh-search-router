# dsh-search-router

**English** · [中文](README.zh.md)

Compatibility repair of [XGrin/dsh-search-router](https://github.com/XGrin/dsh-search-router), based on `d500bd7`, for **DSH 0.1.7-rc.2**. Older DSH APIs are unsupported. One native `WebSearchProvider` routes the existing `web_search` tool to a chosen backend or a sequential fallback chain.

## Backends

| Backend | Default credential reference | Default endpoint |
| --- | --- | --- |
| Exa | EXA_API_KEY | https://api.exa.ai |
| Tavily | TAVILY_API_KEY | https://api.tavily.com |
| Brave | BRAVE_SEARCH_API_KEY | https://api.search.brave.com |
| Perplexity | PPLX_API_KEY | https://api.perplexity.ai |
| DeepSeek | DEEPSEEK_API_KEY | https://api.deepseek.com/anthropic/v1 |
| SearXNG | none; endpoint from SEARXNG_BASE_URL | Self-hosted; JSON format required |
| DuckDuckGo | none | Public HTML search |

The DeepSeek adapter makes its own Messages API request (default model `deepseek-v4-flash`, up to 5 server-side search uses). It does not delegate to DSH's `deepseek-official` provider. Commercial requests may incur charges. Perplexity's default model is `sonar`.

## Local installation

Use this repaired checkout, not the unmodified upstream GitHub install command:

```sh
dsh plugin --profile web add link:/absolute/path/to/dsh-search-router
```

That command installs dependencies and changes the profile. Review its disk effects before running it. For this Windows deployment, dependencies are reused from the existing E-drive DSH installation and the profile is linked manually; see the local delivery report. Do not run a package installer in the daily profile just to refresh this link.

The bundle selects `web.searchProvider: search-router`, disables `web-search-deepseek`, and enables `tool-web` with fetch disabled. Profile patches apply last. Preserve your existing web and tool-web settings when adding overrides. **Select an explicit backend before first use** to avoid auto-detecting a paid service unintentionally:

```yaml
- id: search-router
  config:
    provider: deepseek
    timeoutMs: 10000
- id: web
  config:
    searchProvider: search-router
    fetchProvider: http
- id: tool-web
  disabled: false
  config:
    fetch: false
    searchTimeoutMs: 60000
```

## GUI and YAML share one configuration

Open **Plugins → dsh-search-router → Search router**. Add/remove providers, drag rows or use the grip's arrow keys to reorder, edit keys/endpoints, and adjust timeout/empty-result behavior. One row selects a single backend; multiple rows form a fallback chain. Exa can remain unused until explicitly selected here.

The public `Config` schema is volatile: changes affect the next search without remounting the plugin. The card uses `configForms.get('search-router')`, the shared configuration mirror, `remote.credentials`, and the third-party `plugins.bundle.config` slot. It no longer uses `settings.register`, `settingsScope.bind`, or `connection.api`.

GUI edits are path-level operations with a revision check. They write the profile's `cordis.patch.yml`, the same layer you can edit as YAML. Save rejection, conflicts and transport failure are shown as failure; the card does not assume a rejected write succeeded. Disconnected/read-only forms cannot write. Reconnection refreshes the shared state; unloading releases subscriptions and ignores late replies.

`provider` and `order` are mutually exclusive. GUI transitions change both atomically; `null` clears an inherited choice. Do not copy both active alternatives into one config:

```yaml
# Single backend
- id: search-router
  config:
    provider: deepseek
    order: null

# Alternative: explicit fallback
- id: search-router
  config:
    provider: null
    order: [deepseek, exa]
    timeoutMs: 15000
    emptyResultsFallback: true
    providers:
      deepseek:
        apiKeyEnv: DEEPSEEK_API_KEY
        model: deepseek-v4-flash
      exa:
        apiKeyEnv: EXA_API_KEY
      searxng:
        baseURL: https://search.example.com
```

Use only one of these example rows. If neither selection is set (including both null), auto mode tries available backends in this order: Exa, Tavily, Brave, Perplexity, DeepSeek, SearXNG, DuckDuckGo. The card's automatic action explicitly enters that mode; it is not a switch back to DeepSeek.

All providers accept `apiKey`, `apiKeyEnv`, `baseURL` (alias `baseUrl`) and `baseUrlEnv`; model overrides apply only to DeepSeek/Perplexity. Endpoint environment references apply to keyless backends; keyed backends use their explicit/default endpoint. `timeoutMs` is an integer >= 100 (default 10000). Unknown fields and conflicting routing choices are rejected.

## Credentials and reset behavior

Existing credentials are resolved through DSH's credentials service. There is no migration or rewriting of the existing credential store. Prefer credential references over literal keys.

A key entered in the router card is a **plaintext profile configuration override**, hidden in the GUI/wire schema; redaction is not encryption. It takes precedence over a credential reference. Ordinary field edits never replace the redacted config object and therefore preserve hidden keys. Reset removes the profile override and inherits the bundle configuration; if no inherited key remains, the credential reference is used. Never commit profile files containing secrets.

The former independent settings document is not migrated. Move any needed old settings manually into this nested profile format after reviewing it.

## Fallback and cancellation

The router tries the chain in order on network errors, non-2xx responses, invalid JSON, or timeout. Timeout covers headers and response body. Caller cancellation stops the chain. Empty results trigger fallback by default; if all successful responses are empty, the router returns an empty list. With `emptyResultsFallback: false`, the first successful empty response wins.

## Development and verification

Tests use local mock endpoints and block external requests. The integration test uses real DSH WebRuntime, Settings and ConfigEditor services. It creates and retains fixture files under `.local/test-runs`; cleanup is separate.

With matching DSH packages installed:

```sh
node test/integration.mjs
node test/client-smoke.mjs
```

To reuse an existing DSH source checkout on Windows, set `DSH_ROOT` to its absolute path, set `TSX_TSCONFIG_PATH` to its tsconfig.json, and run integration with `node --import file:///E:/path/to/dsh/node_modules/tsx/dist/esm/index.mjs test/integration.mjs`. Redirect `DSH_HOME`, `TEMP`, `TMP` into this project's `.local`; disable tsx/Node compile caches with `TSX_DISABLE_CACHE=1` and `NODE_DISABLE_COMPILE_CACHE=1`.

The obsolete lockfiles and machine-specific live probe were removed: they targeted old DSH packages and could mutate settings or call paid services. No real API requests run in the test suite. The local delivery report records separately authorized real-host/GUI and paid API checks. For GUI isolation, configure DSH's default workspace explicitly as well as DSH_HOME; changing the working directory alone is insufficient.

Removing the bundle does not remove your profile overrides. To restore native search, restore the profile backup (including dependency/lockfile state) or explicitly select `deepseek-official`, enable `web-search-deepseek`, and remove stale router overrides. Review link removal separately.

MIT.
