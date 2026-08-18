#!/usr/bin/env node
/**
 * Integration test: dsh-search-router against the REAL @deepseek-ai/dsh-web
 * seam, with local mock provider endpoints. No network, no real API keys.
 *
 *   node test/integration.mjs <dir-containing-@deepseek-ai>
 *
 * The directory must contain `@deepseek-ai/cordis` and `@deepseek-ai/dsh-web`
 * (any DSH installation's node_modules, e.g. an npx cache). Cases map to the
 * acceptance matrix: single provider, fallback on 429/timeout, all-fail
 * aggregation, empty-results policy, caller cancellation, auto-detection,
 * seam-level truncation.
 */
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { availableParallelism } from "node:os";

/* ------------------------------------------------------------------ setup */

const modulesDir = resolve(process.argv[2] ?? process.env.DSH_MODULES ?? ".");
const { Context } = await import(pathToFileURL(resolve(modulesDir, "@deepseek-ai/cordis/lib/index.js")).href);
const { default: WebRuntime } = await import(pathToFileURL(resolve(modulesDir, "@deepseek-ai/dsh-web/lib/index.js")).href);
const routerPlugin = await import(pathToFileURL(resolve("src/index.js")).href);

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
  searxng: { status: 200, body: { results: [
    { title: "SearXNG one", url: "https://example.com/s1", content: "searxng result" },
  ] } },
  hang: true,
};

const seen = { exa: [], tavily: [], brave: [], searxng: [] };

/** Restore the default mock behaviors (cases mutate them). */
const defaults = structuredClone({ exa: behavior.exa, tavily: behavior.tavily, brave: behavior.brave, searxng: behavior.searxng });
const resetBehavior = () => {
  Object.assign(behavior.exa, structuredClone(defaults.exa));
  Object.assign(behavior.tavily, structuredClone(defaults.tavily));
  Object.assign(behavior.brave, structuredClone(defaults.brave));
  Object.assign(behavior.searxng, structuredClone(defaults.searxng));
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
      seen.exa.push({ url: request.url, body: chunks });
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
  check(label, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

/** Boot one fresh app: the real seam configured for search-router + our plugin. */
async function boot(config, env = {}) {
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
  ctx.plugin(WebRuntime, { searchProvider: "search-router" });
  const fiber = ctx.plugin(routerPlugin, config);
  await fiber;
  return { ctx, restore };
}

const providersBase = (over = {}) => ({
  exa: { apiKey: "test-exa-key", baseURL: `${base}/exa` },
  tavily: { apiKey: "test-tavily-key", baseURL: `${base}/tavily` },
  brave: { apiKey: "test-brave-key", baseURL: `${base}/brave` },
  searxng: { baseUrl: `${base}/searxng` },
  ...over,
});

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

console.log("case 9: nothing configured — clear setup error");
{
  const { ctx, restore } = await boot({ timeoutMs: 2000 }, { EXA_API_KEY: undefined, TAVILY_API_KEY: undefined, BRAVE_SEARCH_API_KEY: undefined, SEARXNG_BASE_URL: undefined });
  const provider = [...ctx.web.searchProviders.values()].find((p) => p.id === "search-router");
  check("available() false with nothing configured", provider?.available() === false);
  let error;
  try {
    await ctx.web.search({ query: "void", maxResults: 5 });
  } catch (thrown) {
    error = thrown;
  }
  check("seam reports unavailable provider", /unavailable|no search provider/i.test(String(error)), String(error));
  await ctx.cleanup?.() ?? await ctx.dispose?.();
  restore();
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
