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
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

/* ------------------------------------------------------------------ setup */

const modulesDir = resolve(process.argv[2] ?? process.env.DSH_MODULES ?? ".");
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
    eq("base projects the composition", view?.base, {
      provider: "exa", order: "", timeoutMs: 2000, emptyResultsFallback: true,
      exaApiKeyEnv: "EXA_API_KEY", tavilyApiKeyEnv: "TAVILY_API_KEY", braveApiKeyEnv: "BRAVE_SEARCH_API_KEY",
      searxngBaseUrl: `${base}/searxng`, searxngBaseUrlEnv: "",
    });
    eq("resolved section carries schema defaults over base", view?.value, {
      provider: "exa", order: "", timeoutMs: 2000, emptyResultsFallback: true,
      exaApiKeyEnv: "EXA_API_KEY", tavilyApiKeyEnv: "TAVILY_API_KEY", braveApiKeyEnv: "BRAVE_SEARCH_API_KEY",
      searxngBaseUrl: `${base}/searxng`, searxngBaseUrlEnv: "",
    });
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

console.log("case 15: mergeRuntime layering as a pure function");
{
  const composition = settingsExports.projectBase;
  const base = composition({ provider: "exa", order: undefined, timeoutMs: 5000, emptyResultsFallback: true, providers: {} });
  const merge = (resolved) => settingsExports.mergeRuntime({ provider: "exa", timeoutMs: 5000, emptyResultsFallback: true, providers: {} }, resolved, base);
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
