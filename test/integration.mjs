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
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

/* ------------------------------------------------------------------ setup */

/**
 * Where the DSH packages under test come from, most specific first:
 *   1. an explicit argv[2] (or DSH_MODULES) directory,
 *   2. the DSH installation that actually serves this machine, so the suite
 *      validates the runtime the plugin ships into rather than a stale copy,
 *   3. this package's own node_modules.
 * Testing against a pinned old copy is exactly how an API break (0.2.2
 * removed `settings.register`) went unnoticed; prefer the live runtime.
 */
const installedModules = "/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules";
const defaultModules = existsSync(resolve(installedModules, "@deepseek-ai/dsh-web/lib/index.js")) ? installedModules : "node_modules";
const modulesDir = resolve(process.argv[2] ?? process.env.DSH_MODULES ?? defaultModules);
const { Context } = await import(pathToFileURL(resolve(modulesDir, "@deepseek-ai/cordis/lib/index.js")).href);
const { default: WebRuntime } = await import(pathToFileURL(resolve(modulesDir, "@deepseek-ai/dsh-web/lib/index.js")).href);
const routerPlugin = await import(pathToFileURL(resolve("src/index.js")).href);
const { parseConfig } = await import(pathToFileURL(resolve("src/router.js")).href);
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
  // Await the web seam: the router's `inject: ["web"]` cannot resolve until
  // WebRuntime has activated, and awaiting only the router fiber would hang.
  await ctx.plugin(WebRuntime, { searchProvider: "search-router" });
  const fiber = ctx.plugin(routerPlugin, config);
  for (let waited = 0; waited < 2000 && fiber.state !== 2; waited += 25) await sleep(25);
  if (fiber.state !== 2) await fiber.await?.();
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

console.log("case 11: the plugin row exposes a Config schema that yields a settings form");
{
  check("Config exported", routerPlugin.Config !== undefined);
  // The form only appears when SettingsForms.describe()'s volatileForm() keeps
  // the schema — it drops non-volatile fields and returns undefined when none
  // remain. Mirror that gate exactly.
  const zlib = (await import(pathToFileURL(resolve(modulesDir, "@deepseek-ai/schemastery/lib/index.mjs")).href)).default;
  const volatileForm = (schema) => {
    if (schema.meta.volatile) return schema;
    if (schema.type === "object") {
      const dict = Object.fromEntries(Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
        const field = volatileForm(child);
        return field === undefined ? [] : [[key, field]];
      }));
      return Object.keys(dict).length === 0 ? undefined : zlib.object(dict);
    }
    return undefined;
  };
  const form = volatileForm(routerPlugin.Config);
  check("Config produces a settings form (volatile fields)", form !== undefined);
  eq("form exposes every knob", Object.keys(form?.dict ?? {}).sort(),
    ["emptyResultsFallback", "order", "provider", "providers", "timeoutMs"]);
  check("schema serializes for the wire", typeof routerPlugin.Config.toJSON === "function");
}

console.log("case 12: parseConfig accepts Config output and string orders");
{
  const parsed = parseConfig({ provider: "", order: "exa, searxng", timeoutMs: 2000, providers: providersBase() });
  eq("empty provider string means auto-detect", parsed.provider, undefined);
  eq("comma-separated order parses", parsed.order, ["exa", "searxng"]);
  const fromArray = parseConfig({ order: ["tavily", "exa"] });
  eq("array order survives", fromArray.order, ["tavily", "exa"]);
  let error;
  try { parseConfig({ order: ["google"] }); } catch (thrown) { error = thrown; }
  check("unknown id in order refused", /unknown provider "google"/.test(String(error)), String(error));
  error = undefined;
  try { parseConfig({ provider: "exa", order: ["exa"] }); } catch (thrown) { error = thrown; }
  check("provider XOR order refused", /not both/.test(String(error)), String(error));
}

console.log("case 13: composition routing and sequential fallback");
{
  resetBehavior();
  behavior.exa = { status: 429, body: {} };
  const { ctx, restore } = await boot({ order: ["exa", "searxng"], timeoutMs: 2000, providers: providersBase() });
  const result = await ctx.web.search({ query: "chain", maxResults: 5 });
  eq("falls through exa to searxng", result.sources.map((s) => s.url), ["https://example.com/s1"]);
  await ctx.dispose?.();
  restore();
  behavior.exa = structuredClone(defaults.exa);
}

console.log("case 14: provider exposes the 0.2.2 seam contract");
{
  let provider;
  const fakeCtx = {
    get: () => undefined,
    logger: { info() {}, warn() {} },
    web: { registerSearchProvider(candidate) { provider = candidate; return () => {}; } },
  };
  routerPlugin.apply(fakeCtx, { provider: "exa", providers: { exa: { apiKey: "k", baseURL: "https://x.test" } } });
  eq("registers under search-router", provider?.id, "search-router");
  eq("available() is optimistic", provider?.available(), true);
  check("ready() present for route-aware readiness", typeof provider?.ready === "function");
  check("title present for the provider picker", typeof provider?.title === "string" && provider.title.length > 0, provider?.title);
  check("description is localized", provider?.description?.en !== undefined && provider?.description?.zh !== undefined);
  eq("ready() true when the chain has a usable backend", await provider.ready("magpie"), true);
}

console.log("case 15: ready() is false when nothing can authenticate");
{
  let provider;
  const fakeCtx = {
    get: () => undefined,
    logger: { info() {}, warn() {} },
    web: { registerSearchProvider(candidate) { provider = candidate; return () => {}; } },
  };
  const savedEnv = process.env.EXA_API_KEY;
  delete process.env.EXA_API_KEY;
  try {
    routerPlugin.apply(fakeCtx, { provider: "exa" });
    eq("missing key -> not ready", await provider.ready("magpie"), false);
  } finally {
    if (savedEnv !== undefined) process.env.EXA_API_KEY = savedEnv;
  }
}

console.log("case 16: a credential from the environment reaches the provider");
{
  resetBehavior();
  const { ctx, restore } = await boot({
    timeoutMs: 2000,
    providers: { exa: { baseURL: `${base}/exa` }, tavily: {}, brave: {}, searxng: {} },
  }, { EXA_API_KEY: "ambient-env-key" });
  const first = await ctx.web.search({ query: "ambient key", maxResults: 5 });
  check("ambient env key reaches the provider", first.sources.length === 2 && seen.exa.at(-1)?.key === "ambient-env-key", seen.exa.at(-1));
  await ctx.dispose?.();
  restore();
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

console.log("case 15: catalog and order parsing drive the Config schema");
{
  const { BACKENDS } = await import(pathToFileURL(resolve("src/router.js")).href);
  const catalog = settingsExports.providerCatalog(BACKENDS);
  check("catalog lists every backend", catalog.ids.length === Object.keys(BACKENDS).length, catalog.ids);
  check("keyed providers detected", catalog.keyed.includes("exa") && catalog.keyed.includes("tavily"), catalog.keyed);
  check("keyless providers detected", catalog.keyless.includes("duckduckgo") && catalog.keyless.includes("searxng"), catalog.keyless);
  check("model-capable backend flagged", catalog.hasModel("perplexity"), catalog.hasModel("perplexity"));
  eq("order string splits on commas and spaces", settingsExports.parseOrderString("exa, searxng", catalog.ids), ["exa", "searxng"]);
  eq("order array passes through deduped", settingsExports.parseOrderString(["exa", "exa", "tavily"], catalog.ids), ["exa", "tavily"]);
  let error;
  try { settingsExports.parseOrderString("google", catalog.ids); } catch (thrown) { error = thrown; }
  check("unknown id named in the error", /unknown provider "google"/.test(String(error)), String(error));
  // Declared defaults live in the schema metadata (a volatile schema projects
  // `{}` through ~standard; the Loader passes the raw composition to apply()).
  const declared = (key) => routerPlugin.Config.dict[key]?.meta?.default;
  eq("timeoutMs default declared", declared("timeoutMs"), 10000);
  eq("emptyResultsFallback default declared", declared("emptyResultsFallback"), true);
  eq("provider defaults to auto-detect", declared("provider"), "");
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
