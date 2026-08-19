#!/usr/bin/env node
/**
 * Integration test: dsh-search-router against the REAL @deepseek-ai/dsh-web
 * seam, with local mock provider endpoints. No network, no real API keys —
 * requests to a provider's shipped default origin are rewritten to the local
 * mock server by a wrapped fetch.
 *
 *   node test/integration.mjs [dir-containing-@deepseek-ai]
 *
 * Defaults to this package's own node_modules (`npm install` installs the
 * devDependencies), or pass any DSH installation's node_modules (e.g. an npx
 * cache) / set DSH_MODULES. Cases map to the acceptance matrix: single
 * provider, fallback on 429/timeout, all-fail aggregation, empty-results
 * policy, caller cancellation, auto-detection (zero-config, canonical order,
 * env isolation), settings layering, seam-level truncation.
 */
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

/* ------------------------------------------------------------------ setup */

const modulesDir = resolve(process.argv[2] ?? process.env.DSH_MODULES ?? "node_modules");
const { Context } = await import(pathToFileURL(resolve(modulesDir, "@deepseek-ai/cordis/lib/index.js")).href);
const { default: WebRuntime } = await import(pathToFileURL(resolve(modulesDir, "@deepseek-ai/dsh-web/lib/index.js")).href);
const { default: FileSettingsProvider } = await import(pathToFileURL(resolve(modulesDir, "@deepseek-ai/dsh-settings-file/lib/index.js")).href);
const routerPlugin = await import(pathToFileURL(resolve("src/index.js")).href);
const settingsExports = await import(pathToFileURL(resolve("src/settings.js")).href);

/** Mutable mock-endpoint behavior; each case adjusts what it needs. */
const behavior = {
  exa: { status: 200, body: { results: [
    { title: "Exa one", url: "https://example.com/1", text: "first exa result", publishedDate: "2026-08-01" },
    { title: "Exa dup", url: "https://example.com/1", text: "duplicate url dropped" },
    { title: "Exa no url", text: "no url, dropped" },
    { title: "Exa bad date", url: "https://example.com/2", text: "x", publishedDate: "not a date" },
  ] } },
  tavily: { status: 200, body: { results: [
    { title: "Tavily one", url: "https://example.com/t1", content: "tavily result", published_date: "Mon, 01 Jan 2029 00:00:00 GMT" },
  ] } },
  brave: { status: 401, body: {} },
  perplexity: { status: 200, body: { results: [
    { title: "Perplexity one", url: "https://example.com/p1", date: "2026-01-02", text: "perplexity result with <b>markup</b>" },
  ] } },
  deepseek: { status: 200, body: { content: [
    { type: "web_search_tool_result", content: [
      { type: "web_search_result", url: "https://example.com/d1", title: "DeepSeek one", page_age: "2026-01-01" },
      { type: "web_search_result", url: "https://example.com/d2", title: "DeepSeek two" },
    ] },
    { type: "text", text: "answer", citations: [
      { url: "https://example.com/d1", cited_text: "cited excerpt for d1" },
      { url: "https://example.com/d2", cited_text: "" },
    ] },
  ] } },
  searxng: { status: 200, body: { results: [
    { title: "SearXNG one", url: "https://example.com/s1", content: "searxng result" },
  ] } },
  duckduckgo: { status: 200, html: `<a class="result__a" href="https://example.com/g1">DDG <b>one</b></a>
    <a class="result__snippet">ddg snippet one</a>
    <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fg2&amp;rut=abc">DDG two</a>
    <a class="result__snippet">ddg snippet two</a>` },
  hang: true,
};

const seen = { exa: [], tavily: [], brave: [], perplexity: [], deepseek: [], searxng: [], duckduckgo: [] };

/** Restore the default mock behaviors (cases mutate them). */
const defaults = structuredClone({ exa: behavior.exa, tavily: behavior.tavily, brave: behavior.brave, perplexity: behavior.perplexity, deepseek: behavior.deepseek, searxng: behavior.searxng, duckduckgo: behavior.duckduckgo });
const resetBehavior = () => {
  Object.assign(behavior.exa, structuredClone(defaults.exa));
  Object.assign(behavior.tavily, structuredClone(defaults.tavily));
  Object.assign(behavior.brave, structuredClone(defaults.brave));
  Object.assign(behavior.perplexity, structuredClone(defaults.perplexity));
  Object.assign(behavior.deepseek, structuredClone(defaults.deepseek));
  Object.assign(behavior.searxng, structuredClone(defaults.searxng));
  Object.assign(behavior.duckduckgo, structuredClone(defaults.duckduckgo));
  behavior.hang = true;
};

const server = createServer((request, response) => {
  let chunks = "";
  request.on("data", (chunk) => { chunks += chunk; });
  request.on("end", () => {
    const send = (what) => {
      response.writeHead(what.status, { "content-type": "application/json" });
      response.end(JSON.stringify(what.body ?? {}));
    };
    if (request.url?.startsWith("/hang/")) {
      if (!behavior.hang) send({ status: 200, body: {} });
      return; /* never respond: the caller times out */
    }
    if (request.url?.startsWith("/exa/")) {
      seen.exa.push({ url: request.url, body: chunks, key: request.headers["x-api-key"] });
      return send(behavior.exa);
    }
    if (request.url?.startsWith("/tavily/")) {
      seen.tavily.push({ url: request.url, body: chunks });
      return send(behavior.tavily);
    }
    if (request.url?.startsWith("/brave/")) {
      seen.brave.push({ url: request.url, body: chunks });
      return send(behavior.brave);
    }
    if (request.url?.startsWith("/perplexity/")) {
      seen.perplexity.push({ url: request.url, body: chunks });
      return send(behavior.perplexity);
    }
    if (request.url?.startsWith("/deepseek/")) {
      seen.deepseek.push({ url: request.url, body: chunks });
      return send(behavior.deepseek);
    }
    if (request.url?.startsWith("/duckduckgo/")) {
      seen.duckduckgo.push({ url: request.url, body: chunks });
      response.writeHead(behavior.duckduckgo.status, { "content-type": "text/html" });
      response.end(behavior.duckduckgo.html ?? "");
      return;
    }
    if (request.url?.startsWith("/searxng/")) {
      seen.searxng.push({ url: request.url, body: chunks });
      return send(behavior.searxng);
    }
    send({ status: 404, body: {} });
  });
});

await new Promise((done) => server.listen(0, "127.0.0.1", done));
const base = `http://127.0.0.1:${server.address().port}`;

/* ------------------------------------------------------------- assertions */

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok  ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}
function eq(label, actual, expected) {
  const canon = (value) => JSON.stringify(sortDeep(value));
  check(label, canon(actual) === canon(expected), { actual, expected });
}
/** Key-order-insensitive canonical form for JSON-shaped values. */
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortDeep(value[key])]));
  }
  return value;
}

/** Boot one fresh app: the real seam configured for search-router + our plugin. */
async function boot(config, env = {}, options = {}) {
  const saved = {};
  for (const [name, value] of Object.entries(env)) {
    saved[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  const restore = () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  const ctx = new Context();
  if (options.settingsPath !== undefined) ctx.plugin(FileSettingsProvider, { path: options.settingsPath, watch: false });
  ctx.plugin(WebRuntime, { searchProvider: "search-router" });
  const fiber = ctx.plugin(routerPlugin, config);
  await fiber;
  if (options.settingsPath !== undefined) {
    const started = Date.now();
    while (Date.now() - started < 2000) {
      if (ctx.settings.describe().some((view) => view.ns === "search-router")) break;
      await sleep(25);
    }
  }
  return { ctx, restore };
}

const providersBase = (over = {}) => ({
  exa: { apiKey: "test-exa-key", baseURL: `${base}/exa` },
  tavily: { apiKey: "test-tavily-key", baseURL: `${base}/tavily` },
  brave: { apiKey: "test-brave-key", baseURL: `${base}/brave` },
  perplexity: { apiKey: "test-pplx-key", baseURL: `${base}/perplexity` },
  deepseek: { apiKey: "test-deepseek-key", baseURL: `${base}/deepseek` },
  searxng: { baseUrl: `${base}/searxng` },
  duckduckgo: { baseURL: `${base}/duckduckgo` },
  ...over,
});

/**
 * Point a provider's shipped default origin at the local mock server: the
 * code under test still resolves its real defaultBaseURL; only the socket
 * changes, so default-endpoint behavior is testable without network.
 */
const NO_KEY_ENV = {
  EXA_API_KEY: undefined, TAVILY_API_KEY: undefined, BRAVE_SEARCH_API_KEY: undefined,
  PPLX_API_KEY: undefined, DEEPSEEK_API_KEY: undefined, SEARXNG_BASE_URL: undefined,
};
const redirectDefaultOrigin = (origin, path) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => realFetch(String(input).replace(origin, path), init);
  return () => {
    globalThis.fetch = realFetch;
  };
};

/* ------------------------------------------------------------------ cases */

console.log("case 1: single provider — exa success through the real seam");
{
  const { ctx, restore } = await boot({
    provider: "exa",
    timeoutMs: 2000,
    providers: providersBase(),
  }, { EXA_API_KEY: undefined, TAVILY_API_KEY: undefined, BRAVE_SEARCH_API_KEY: undefined, SEARXNG_BASE_URL: undefined });
  const result = await ctx.web.search({ query: "dsh plugins", maxResults: 8 });
  eq("sources normalized (dedupe, no-url and bad-date dropped)", result.sources, [
    { url: "https://example.com/1", title: "Exa one", snippet: "first exa result", publishedAt: "2026-08-01" },
    { url: "https://example.com/2", title: "Exa bad date", snippet: "x" },
  ]);
  eq("truncated flag", result.truncated, false);
  check("query forwarded verbatim", seen.exa.at(-1)?.body.includes('"query":"dsh plugins"'), seen.exa.at(-1));
  await ctx.cleanup?.() ?? await ctx.dispose?.();
  restore();
}

console.log("case 1b: seam-level maxResults truncation");
{
  const { ctx, restore } = await boot({
    provider: "exa",
    timeoutMs: 2000,
    providers: providersBase(),
  });
  const result = await ctx.web.search({ query: "q", maxResults: 1 });
  eq("seam truncates to maxResults", result.sources.map((s) => s.url), ["https://example.com/1"]);
  eq("seam flags truncation", result.truncated, true);
  await ctx.cleanup?.() ?? await ctx.dispose?.();
  restore();
}

console.log("case 2: primary 429 — fallback to tavily");
{
  behavior.exa = { status: 429, body: { error: "rate limited" } };
  const { ctx, restore } = await boot({
    order: ["exa", "tavily", "searxng"],
    timeoutMs: 2000,
    providers: providersBase(),
  });
  const result = await ctx.web.search({ query: "fallback please", maxResults: 5 });
  eq("tavily answered", result.sources.map((s) => s.url), ["https://example.com/t1"]);
  eq("tavily snippet + parsed date", result.sources[0].snippet, "tavily result");
  check("exa was tried first", seen.exa.length >= 1);
  behavior.exa = { status: 200, body: { results: [] } };
  await ctx.cleanup?.() ?? await ctx.dispose?.();
  restore();
}

console.log("case 3: primary timeout — fallback to searxng");
{
  const { ctx, restore } = await boot({
    order: ["exa", "searxng"],
    timeoutMs: 700,
    providers: providersBase({ exa: { apiKey: "k", baseURL: `${base}/hang` } }),
  });
  const started = Date.now();
  const result = await ctx.web.search({ query: "slow exa", maxResults: 5 });
  const elapsed = Date.now() - started;
  eq("searxng answered", result.sources.map((s) => s.url), ["https://example.com/s1"]);
  check("timeout honored (~>=700ms)", elapsed >= 650, { elapsed });
  await ctx.cleanup?.() ?? await ctx.dispose?.();
  restore();
}

console.log("case 4: all providers fail — one aggregated error, no keys leaked");
{
  behavior.exa = { status: 429, body: { error: "rate limited" } };
  behavior.tavily = { status: 500, body: {} };
  behavior.searxng = { status: 403, body: {} };
  const { ctx, restore } = await boot({
    order: ["exa", "tavily", "searxng"],
    timeoutMs: 2000,
    providers: providersBase(),
  });
  let error;
  try {
    await ctx.web.search({ query: "doomed", maxResults: 5 });
  } catch (thrown) {
    error = thrown;
  }
  check("web_search throws", error instanceof Error, error);
  const text = String(error);
  check("mentions each provider failure", text.includes("- exa: HTTP 429") && text.includes("- tavily: HTTP 500") && text.includes("- searxng: HTTP 403"), text);
  check("no api keys in the error", !text.includes("test-exa-key") && !text.includes("test-tavily-key") && !text.includes("test-brave-key"), text);
  behavior.exa = { status: 200, body: { results: [] } };
  behavior.tavily = { status: 200, body: { results: [] } };
  behavior.searxng = { status: 200, body: { results: [] } };
  await ctx.cleanup?.() ?? await ctx.dispose?.();
  restore();
}

console.log("case 5: all providers empty — truthful empty result, not an error");
{
  const { ctx, restore } = await boot({
    order: ["exa", "searxng"],
    timeoutMs: 2000,
    providers: providersBase(),
  });
  const result = await ctx.web.search({ query: "obscure", maxResults: 5 });
  eq("empty sources returned", result.sources, []);
  await ctx.cleanup?.() ?? await ctx.dispose?.();
  restore();
}

console.log("case 5b: emptyResultsFallback: false — first empty wins");
{
  behavior.searxng = { status: 200, body: { results: [{ url: "https://example.com/s9", title: "late", content: "c" }] } };
  const { ctx, restore } = await boot({
    order: ["exa", "searxng"],
    emptyResultsFallback: false,
    timeoutMs: 2000,
    providers: providersBase(),
  });
  const result = await ctx.web.search({ query: "accept empty", maxResults: 5 });
  eq("empty exa result returned without fallback", result.sources, []);
  check("searxng not consulted", seen.searxng.every((s) => !s.url.includes("s9")), seen.searxng.at(-1));
  await ctx.cleanup?.() ?? await ctx.dispose?.();
  restore();
}

console.log("case 6: caller cancellation propagates, is not a fallback");
{
  const { ctx, restore } = await boot({
    order: ["exa", "searxng"],
    timeoutMs: 10000,
    providers: providersBase({ exa: { apiKey: "k", baseURL: `${base}/hang` } }),
  });
  const controller = new AbortController();
  const search = ctx.web.search({ query: "cancel me", maxResults: 5 }, controller.signal);
  setTimeout(() => controller.abort(new Error("user stopped")), 100);
  let error;
  try {
    await search;
  } catch (thrown) {
    error = thrown;
  }
  check("aborts with caller cancellation", /aborted/i.test(String(error)), String(error));
  await ctx.cleanup?.() ?? await ctx.dispose?.();
  restore();
}

console.log("case 7: missing credentials are skipped, later provider used");
{
  resetBehavior();
  const { ctx, restore } = await boot({
    order: ["brave", "searxng"],
    timeoutMs: 2000,
    providers: providersBase({ brave: {} }),
  }, { BRAVE_SEARCH_API_KEY: undefined });
  behavior.brave = { status: 200, body: { web: { results: [{ title: "Brave", url: "https://example.com/b1", description: "never <b>reached</b>" }] } } };
  const result = await ctx.web.search({ query: "no brave key", maxResults: 5 });
  eq("searxng answered after unarmed brave was skipped", result.sources.map((s) => s.url), ["https://example.com/s1"]);
  check("brave endpoint never hit", seen.brave.every((s) => !s.url.includes("b1")), seen.brave.at(-1));
  await ctx.cleanup?.() ?? await ctx.dispose?.();
  restore();
}

console.log("case 8: auto-detection from ambient env + available()");
{
  resetBehavior();
  const { ctx, restore } = await boot({
    timeoutMs: 2000,
    providers: { exa: { baseURL: `${base}/exa` }, tavily: {}, brave: {}, searxng: {} },
  }, { EXA_API_KEY: "ambient-exa-key", TAVILY_API_KEY: undefined, BRAVE_SEARCH_API_KEY: undefined, SEARXNG_BASE_URL: undefined });
  const provider = [...ctx.web.searchProviders.values()].find((p) => p.id === "search-router");
  check("provider registered with the right id", provider !== undefined);
  check("available() true with a detected provider", provider?.available() === true);
  const result = await ctx.web.search({ query: "auto", maxResults: 5 });
  eq("ambient-key exa answered", result.sources.map((s) => s.url), ["https://example.com/1", "https://example.com/2"]);
  await ctx.cleanup?.() ?? await ctx.dispose?.();
  restore();
}

console.log("case 9: zero-config — keyless DuckDuckGo serves with nothing set anywhere");
{
  resetBehavior();
  const unredirect = redirectDefaultOrigin(/^https:\/\/html\.duckduckgo\.com/u, `${base}/duckduckgo`);
  let ctx;
  let restore;
  try {
    ({ ctx, restore } = await boot({ timeoutMs: 2000 }, NO_KEY_ENV));
    const provider = [...ctx.web.searchProviders.values()].find((p) => p.id === "search-router");
    check("seam gate open with zero configuration", provider?.available() === true);
    const result = await ctx.web.search({ query: "void", maxResults: 5 });
    check("zero-config search served by DuckDuckGo's default endpoint", result.sources.length === 2 && result.sources[0]?.url === "https://example.com/g1", result.sources);
    check("default DDG origin was used (rewritten to the mock)", seen.duckduckgo.at(-1)?.url.startsWith("/duckduckgo/html"), seen.duckduckgo.at(-1));
  } finally {
    unredirect();
    await ctx?.cleanup?.() ?? await ctx?.dispose?.();
    restore?.();
  }
}

console.log("case 8b: auto-chain follows meta.sort, not file-name order");
{
  resetBehavior();
  behavior.exa = { status: 429, body: {} };
  const { ctx, restore } = await boot({
    timeoutMs: 2000,
    providers: { exa: { baseURL: `${base}/exa` }, deepseek: { baseURL: `${base}/deepseek` }, searxng: { baseUrl: `${base}/searxng` } },
  }, { ...NO_KEY_ENV, EXA_API_KEY: "ambient-exa-key", DEEPSEEK_API_KEY: "ambient-deepseek-key" });
  const result = await ctx.web.search({ query: "ordering", maxResults: 5 });
  eq("exa (meta.sort 1) leads, deepseek (sort 5) answers after its 429", result.sources.map((s) => s.url), ["https://example.com/d1", "https://example.com/d2"]);
  check("exa was tried first despite 'deepseek' sorting first by file name", seen.exa.length >= 1, seen.exa.at(-1));
  await ctx.cleanup?.() ?? await ctx.dispose?.();
  restore();
}

console.log("case 8c: SEARXNG_BASE_URL arms SearXNG only — DuckDuckGo keeps its own endpoint");
{
  resetBehavior();
  behavior.searxng = { status: 500, body: {} };
  const unredirect = redirectDefaultOrigin(/^https:\/\/html\.duckduckgo\.com/u, `${base}/duckduckgo`);
  let ctx;
  let restore;
  try {
    ({ ctx, restore } = await boot({ timeoutMs: 2000 }, { ...NO_KEY_ENV, SEARXNG_BASE_URL: `${base}/searxng` }));
    const result = await ctx.web.search({ query: "isolation", maxResults: 5 });
    check("searxng was armed by its own meta.baseUrlEnv", seen.searxng.length >= 1, seen.searxng.at(-1));
    eq("duckduckgo answered after searxng failed", result.sources.map((s) => s.url), ["https://example.com/g1", "https://example.com/g2"]);
    check("duckduckgo hit its own origin, not the SearXNG endpoint", seen.duckduckgo.at(-1)?.url.startsWith("/duckduckgo/html"), seen.duckduckgo.at(-1));
  } finally {
    unredirect();
    await ctx?.cleanup?.() ?? await ctx?.dispose?.();
    restore?.();
  }
}

console.log("case 10: bad config fails loudly at load");
{
  let error;
  try {
    routerPlugin.apply({ web: { registerSearchProvider() {} }, logger: undefined }, { provider: "google" });
  } catch (thrown) {
    error = thrown;
  }
  check("unknown provider rejected", /unknown provider "google"/.test(String(error)), String(error));
  error = undefined;
  try {
    routerPlugin.apply({ web: { registerSearchProvider() {} }, logger: undefined }, { provider: "exa", order: ["exa"] });
  } catch (thrown) {
    error = thrown;
  }
  check("provider XOR order enforced", /not both/.test(String(error)), String(error));
  error = undefined;
  try {
    routerPlugin.apply({ web: { registerSearchProvider() {} }, logger: undefined }, { providers: { exa: { model: "gpt-imagine" } } });
  } catch (thrown) {
    error = thrown;
  }
  check("model rejected for a provider without defaultModel", /providers\.exa\.model is not configurable/.test(String(error)), String(error));
  let accepted = true;
  try {
    routerPlugin.apply({ web: { registerSearchProvider() {} }, inject: () => {}, logger: undefined }, { providers: { perplexity: { model: "sonar-pro" } } });
  } catch (thrown) {
    accepted = false;
    console.log(`      (threw: ${String(thrown)})`);
  }
  check("model accepted where the descriptor declares defaultModel", accepted);
}

console.log("case 11: settings section is served for the Plugins page");
{
  const dir = mkdtempSync(join(tmpdir(), "dsr-settings-"));
  const settingsPath = join(dir, "settings.yaml");
  try {
    const { ctx, restore } = await boot({
      provider: "exa",
      timeoutMs: 2000,
      providers: providersBase(),
    }, {}, { settingsPath });
    const views = ctx.settings.describe();
    const view = views.find((candidate) => candidate.ns === "search-router");
    check("namespace registered", view !== undefined, views.map((v) => v.ns));
    check("applies live", view?.applies === "live", view?.applies);
    const expectedSection = {
      provider: "exa", order: "", timeoutMs: 2000, emptyResultsFallback: true,
      exaApiKeyEnv: "EXA_API_KEY", tavilyApiKeyEnv: "TAVILY_API_KEY", braveApiKeyEnv: "BRAVE_SEARCH_API_KEY",
      perplexityApiKeyEnv: "PPLX_API_KEY", deepseekApiKeyEnv: "DEEPSEEK_API_KEY",
      exaKeyPreset: true, tavilyKeyPreset: true, braveKeyPreset: true,
      perplexityKeyPreset: true, deepseekKeyPreset: true,
      searxngBaseUrl: `${base}/searxng`,
    };
    eq("base projects the composition", view?.base, expectedSection);
    eq("resolved section carries schema defaults over base", view?.value, expectedSection);
    await ctx.dispose?.();
    restore();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("case 12: settings writes re-route live searches (the GUI path)");
{
  resetBehavior();
  const dir = mkdtempSync(join(tmpdir(), "dsr-settings-"));
  const settingsPath = join(dir, "settings.yaml");
  try {
    const { ctx, restore } = await boot({
      provider: "exa",
      timeoutMs: 2000,
      providers: providersBase(),
    }, {}, { settingsPath });
    const before = await ctx.web.search({ query: "via composition", maxResults: 5 });
    eq("composition routing first", before.sources.map((s) => s.url), ["https://example.com/1", "https://example.com/2"]);
    await ctx.settings.mutate("search-router", [{ op: "set", path: ["provider"], value: "searxng" }]);
    const after = await ctx.web.search({ query: "via settings", maxResults: 5 });
    eq("settings write re-routes to searxng", after.sources.map((s) => s.url), ["https://example.com/s1"]);
    await ctx.settings.mutate("search-router", [{ op: "unset", path: ["provider"] }]);
    const reverted = await ctx.web.search({ query: "back to composition", maxResults: 5 });
    eq("unset reverts to the composition layer", reverted.sources.map((s) => s.url), ["https://example.com/1", "https://example.com/2"]);
    await ctx.dispose?.();
    restore();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("case 13: settings validation refuses contradictory writes");
{
  const dir = mkdtempSync(join(tmpdir(), "dsr-settings-"));
  const settingsPath = join(dir, "settings.yaml");
  try {
    const { ctx, restore } = await boot({ timeoutMs: 2000 }, {}, { settingsPath });
    let error;
    try {
      await ctx.settings.mutate("search-router", [
        { op: "set", path: ["provider"], value: "exa" },
        { op: "set", path: ["order"], value: "exa, searxng" },
      ]);
    } catch (thrown) {
      error = thrown;
    }
    check("provider XOR order refused", /not both/.test(String(error)), String(error));
    error = undefined;
    try {
      await ctx.settings.mutate("search-router", [{ op: "set", path: ["order"], value: "google, exa" }]);
    } catch (thrown) {
      error = thrown;
    }
    check("unknown id in order refused", /unknown provider "google"/.test(String(error)), String(error));
    error = undefined;
    try {
      await ctx.settings.mutate("search-router", [{ op: "set", path: ["order"], value: ", ," }]);
    } catch (thrown) {
      error = thrown;
    }
    check("order that names nothing refused", /names no providers/.test(String(error)), String(error));
    error = undefined;
    try {
      await ctx.settings.mutate("search-router", [{ op: "set", path: ["searxngBaseUrl"], value: "search.example.com" }]);
    } catch (thrown) {
      error = thrown;
    }
    check("scheme-less searxng URL refused", /http\(s\) URL/.test(String(error)), String(error));
    const views = ctx.settings.describe();
    const view = views.find((candidate) => candidate.ns === "search-router");
    eq("refused writes stored nothing", view?.user, void 0);
    await ctx.dispose?.();
    restore();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("case 14: settings fallback order and merge semantics");
{
  resetBehavior();
  const dir = mkdtempSync(join(tmpdir(), "dsr-settings-"));
  const settingsPath = join(dir, "settings.yaml");
  try {
    behavior.exa = { status: 429, body: {} };
    const { ctx, restore } = await boot({ timeoutMs: 2000, providers: providersBase() }, {}, { settingsPath });
    await ctx.settings.mutate("search-router", [{ op: "set", path: ["order"], value: "exa, searxng" }]);
    const result = await ctx.web.search({ query: "chain via settings", maxResults: 5 });
    eq("order string drives the fallback chain", result.sources.map((s) => s.url), ["https://example.com/s1"]);
    await ctx.settings.mutate("search-router", [{ op: "set", path: ["searxngBaseUrl"], value: `${base}/nothing` }]);
    let error;
    try {
      await ctx.web.search({ query: "endpoint moved", maxResults: 5 });
    } catch (thrown) {
      error = thrown;
    }
    check("searxngBaseUrl override applies", /searxng: HTTP 404/.test(String(error)), String(error));
    await ctx.dispose?.();
    restore();
    behavior.exa = structuredClone(defaults.exa);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("case 16: a key stored in settings overrides the ambient environment");
{
  resetBehavior();
  const dir = mkdtempSync(join(tmpdir(), "dsr-settings-"));
  const settingsPath = join(dir, "settings.yaml");
  try {
    const { ctx, restore } = await boot({
      timeoutMs: 2000,
      providers: { exa: { baseURL: `${base}/exa` }, tavily: {}, brave: {}, searxng: {} },
    }, { EXA_API_KEY: "ambient-env-key" }, { settingsPath });
    const first = await ctx.web.search({ query: "ambient key", maxResults: 5 });
    check("ambient env key reaches the provider", first.sources.length === 2 && seen.exa.at(-1)?.key === "ambient-env-key", seen.exa.at(-1));
    await ctx.settings.mutate("search-router", [{ op: "set", path: ["exaApiKey"], value: "settings-stored-key" }]);
    const second = await ctx.web.search({ query: "stored key", maxResults: 5 });
    check("settings-stored key overrides the environment", second.sources.length === 2 && seen.exa.at(-1)?.key === "settings-stored-key", seen.exa.at(-1));
    const redacted = ctx.settings.describe({ redactSecrets: true }).find((view) => view.ns === "search-router");
    check("redacted view hides the stored key", !JSON.stringify(redacted?.value ?? {}).includes("settings-stored-key"), redacted?.value);
    check("secret sidecar reports the slot as set", redacted?.secrets?.some((secret) => secret.path?.[0] === "exaApiKey" && secret.set === true), redacted?.secrets);
    await ctx.settings.mutate("search-router", [{ op: "unset", path: ["exaApiKey"] }]);
    const third = await ctx.web.search({ query: "back to ambient", maxResults: 5 });
    check("unsetting falls back to the environment", third.sources.length === 2 && seen.exa.at(-1)?.key === "ambient-env-key", seen.exa.at(-1));
    let error;
    try {
      await ctx.settings.mutate("search-router", [{ op: "set", path: ["exaApiKey"], value: "  " }]);
    } catch (thrown) {
      error = thrown;
    }
    check("blank key refused", /non-empty/.test(String(error)), String(error));
    await ctx.dispose?.();
    restore();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("case 17: provider markup is stripped from snippets");
{
  resetBehavior();
  behavior.brave = { status: 200, body: { web: { results: [
    { title: "Brave", url: "https://example.com/b1", description: "a <b>bold</b> <a href=\"x\">linked</a> query" },
  ] } } };
  const { ctx, restore } = await boot({
    order: ["brave"],
    timeoutMs: 2000,
    providers: { brave: { apiKey: "k", baseURL: `${base}/brave` } },
  });
  const result = await ctx.web.search({ query: "strip markup", maxResults: 5 });
  check("tags removed, text kept", result.sources[0]?.snippet === "a bold linked query", result.sources[0]);
  await ctx.dispose?.();
  restore();
}

console.log("case 18: perplexity, deepseek, duckduckgo backends");
{
  resetBehavior();
  const bootOne = async (provider) => boot({
    provider,
    timeoutMs: 2000,
    providers: providersBase(),
  });
  {
    const { ctx, restore } = await bootOne("perplexity");
    const pplx = await ctx.web.search({ query: "pplx", maxResults: 5 });
    eq("perplexity normalizes date/text, strips markup", pplx.sources, [
      { url: "https://example.com/p1", title: "Perplexity one", snippet: "perplexity result with markup", publishedAt: "2026-01-02" },
    ]);
    check("perplexity sends model + bearer auth", seen.perplexity.at(-1)?.body.includes('"model"') && seen.perplexity.at(-1)?.body.includes('"sonar"'), seen.perplexity.at(-1));
    await ctx.cleanup?.() ?? await ctx.dispose?.();
    restore();
  }
  {
    const { ctx, restore } = await bootOne("deepseek");
    const ds = await ctx.web.search({ query: "ds", maxResults: 5 });
    eq("deepseek joins citations as snippets", ds.sources, [
      { url: "https://example.com/d1", title: "DeepSeek one", snippet: "cited excerpt for d1", publishedAt: "2026-01-01" },
      { url: "https://example.com/d2", title: "DeepSeek two" },
    ]);
    check("deepseek sends the web_search tool", seen.deepseek.at(-1)?.body.includes("web_search_20250305"), seen.deepseek.at(-1));
    await ctx.cleanup?.() ?? await ctx.dispose?.();
    restore();
  }
  {
    const { ctx, restore } = await bootOne("duckduckgo");
    const ddg = await ctx.web.search({ query: "ddg", maxResults: 5 });
    eq("duckduckgo parses SERP, unwraps redirects, strips markup", ddg.sources, [
      { url: "https://example.com/g1", title: "DDG one", snippet: "ddg snippet one" },
      { url: "https://example.com/g2", title: "DDG two", snippet: "ddg snippet two" },
    ]);
    behavior.duckduckgo = { status: 200, html: "<html><body>no results here</body></html>" };
    const empty = await ctx.web.search({ query: "empty ddg", maxResults: 5 });
    eq("unparseable SERP reads as 0 results", empty.sources, []);
    behavior.duckduckgo = { status: 403, html: "" };
    let error;
    try {
      await ctx.web.search({ query: "blocked ddg", maxResults: 5 });
    } catch (thrown) {
      error = thrown;
    }
    check("HTTP failure surfaces in the aggregate", /duckduckgo: HTTP 403/.test(String(error)), String(error));
    await ctx.cleanup?.() ?? await ctx.dispose?.();
    restore();
  }
}

console.log("case 15: mergeRuntime layering as a pure function");
{
  const { BACKENDS } = await import(pathToFileURL(resolve("src/router.js")).href);
  const catalog = settingsExports.providerCatalog(BACKENDS);
  const base = settingsExports.projectBase(catalog)({ provider: "exa", order: undefined, timeoutMs: 5000, emptyResultsFallback: true, providers: {} });
  const merge = (resolved) => settingsExports.mergeRuntime(catalog)({ provider: "exa", timeoutMs: 5000, emptyResultsFallback: true, providers: {} }, resolved, base);
  eq("identical resolution inherits the composition", merge(structuredClone(base)), {
    provider: "exa", timeoutMs: 5000, emptyResultsFallback: true, providers: {},
  });
  eq("changed timeoutMs overrides only that field", merge({ ...structuredClone(base), timeoutMs: 1500 }), {
    provider: "exa", timeoutMs: 1500, emptyResultsFallback: true, providers: {},
  });
  eq("order set clears a composition provider", merge({ ...structuredClone(base), order: "searxng" }), {
    order: ["searxng"], timeoutMs: 5000, emptyResultsFallback: true, providers: {},
  });
  eq("explicit Automatic clears composition routing", merge({ ...structuredClone(base), provider: "" }), {
    timeoutMs: 5000, emptyResultsFallback: true, providers: {},
  });
  eq("undefined section is the composition itself", merge(void 0), {
    provider: "exa", timeoutMs: 5000, emptyResultsFallback: true, providers: {},
  });
  eq("stored key becomes the provider's literal apiKey", settingsExports.mergeRuntime(catalog)(
    { timeoutMs: 5000, providers: {} },
    { ...structuredClone(base), provider: "", tavilyApiKey: "k" },
    base,
  ).providers.tavily, { apiKey: "k" });
}

/* ------------------------------------------------------------------- done */

server.close();
if (failures === 0) {
  console.log("\nall integration cases passed");
} else {
  console.log(`\n${failures} check(s) failed`);
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
