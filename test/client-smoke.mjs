#!/usr/bin/env node
/**
 * Client-bundle smoke test: loads client/client.js the way the web shell's
 * module loader does (registers the factory on window.__ModuleLoader__),
 * materializes it with a stub React, applies it against a stub plugin
 * context, and drives the chain controller through add / drag-reorder /
 * remove / advanced writes — asserting the Settings → Plugins wiring (slot
 * key, locale, injected face), the Models-page interaction model (every
 * structural change commits the `order` field immediately), and that keys
 * reach only the credentials domain.
 *
 *   node test/client-smoke.mjs
 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

let failures = 0;
function check(label, condition, detail) {
  if (condition) console.log(`  ok  ${label}`);
  else {
    failures += 1;
    console.log(`FAIL  ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}
/** Let fire-and-forget writes settle through their awaited scope calls. */
const flush = () => new Promise((done) => setTimeout(done, 20));

/* --------------------------------------------------------------- the load */

let record;
globalThis.window = globalThis;
globalThis.__ModuleLoader__ = {
  load(entry) {
    record = entry;
  },
};
await import(pathToFileURL(resolve("src/client/client.js")).href);
check("factory registered on window.__ModuleLoader__", record?.id === "dsh-search-router", record?.id);

/** Minimal React stand-in: createElement returns plain descriptors. */
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  Fragment: Symbol.for("react.fragment"),
  useEffect: () => {},
  useState: (initial) => [initial, () => {}],
};
const exports = record.factory((id) => {
  if (id === "react") return React;
  throw new Error(`unexpected require: ${id}`);
});
check("plugin exports apply + inject", typeof exports.apply === "function" && Array.isArray(exports.inject), exports.inject);
check(
  "inject declares the card's services",
  ["slots", "locale", "connection", "remote", "settingsScope"].every((service) => exports.inject.includes(service)),
  exports.inject,
);

/* ------------------------------------------------------------ stub canvas */

const registered = {};
const scopeWrites = [];
const credentialWrites = [];
let credentialView = {};

/** The serialized schema shape the browser actually receives (schemastery toJSON refs flattened). */
const SCHEMA = { dict: Object.fromEntries([
  ["provider", { type: "union", meta: { default: "" } }],
  ["order", { type: "string", meta: { default: "" } }],
  ["timeoutMs", { type: "number", meta: { default: 10000 } }],
  ["emptyResultsFallback", { type: "boolean", meta: { default: true } }],
  ...["exa", "tavily", "brave", "perplexity", "deepseek"].flatMap((id) => [
    [`${id}ApiKey`, { type: "string", meta: { role: "secret" } }],
    [`${id}ApiKeyEnv`, { type: "string", meta: { role: "credential-ref", default: { exa: "EXA_API_KEY", tavily: "TAVILY_API_KEY", brave: "BRAVE_SEARCH_API_KEY", perplexity: "PPLX_API_KEY", deepseek: "DEEPSEEK_API_KEY" }[id] } }],
  ]),
  ["searxngBaseUrl", { type: "string", meta: { default: "" } }],
  ...[["exa", "Exa"], ["tavily", "Tavily"], ["brave", "Brave"], ["perplexity", "Perplexity"], ["deepseek", "DeepSeek"], ["searxng", "SearXNG"], ["duckduckgo", "DuckDuckGo"]].map(([id, label]) => [`${id}Provider`, { type: "const", meta: { providerLabel: label } }]),
]) };

const BASE = {
  provider: "", order: "", timeoutMs: 10000, emptyResultsFallback: true,
  exaApiKeyEnv: "EXA_API_KEY", tavilyApiKeyEnv: "TAVILY_API_KEY", braveApiKeyEnv: "BRAVE_SEARCH_API_KEY",
  perplexityApiKeyEnv: "PPLX_API_KEY", deepseekApiKeyEnv: "DEEPSEEK_API_KEY",
  searxngBaseUrl: "", searxngBaseUrlEnv: "",
};
const userLayer = {};
let scopeListener = () => {};
const scope = {
  getSnapshot: () => ({
    status: "ready",
    writable: true,
    revision: 1,
    schema: SCHEMA,
    base: BASE,
    user: Object.keys(userLayer).length > 0 ? { ...userLayer } : void 0,
    value: { ...BASE, ...userLayer },
  }),
  subscribe: (listener) => {
    scopeListener = listener;
    return () => {
      scopeListener = () => {};
    };
  },
  set: async (field, value) => {
    scopeWrites.push({ op: "set", field, value });
    userLayer[field] = value;
    scopeListener();
  },
  unset: async (field) => {
    scopeWrites.push({ op: "unset", field });
    delete userLayer[field];
    scopeListener();
  },
};

const api = {
  credentials: {
    describe: async ({ refs }) => ({ result: { ok: true, value: { credentials: Object.fromEntries(refs.map((ref) => [ref, credentialView[ref] ?? { configured: false, writable: true }])) } } }),
    set: async ({ ref, value }) => {
      credentialWrites.push({ ref, value });
      credentialView = { ...credentialView, [ref]: { configured: true, writable: true } };
      return { result: { ok: true, value: {} } };
    },
  },
  settings: {
    describe: async () => ({
      result: {
        ok: true,
        value: {
          writable: true,
          namespaces: [{
            ns: "search-router",
            applies: "live",
            revision: 1,
            value: { ...BASE, ...userLayer },
            secrets: ["exaApiKey", "tavilyApiKey", "braveApiKey", "perplexityApiKey", "deepseekApiKey"].map((field) => ({ path: [field], set: Object.hasOwn(userLayer, field) })),
          }],
        },
      },
    }),
  },
};

const locales = {};
const slotRegistrations = [];
const ctx = {
  get: (name) => (name === "connection" ? { api } : undefined),
  effect: (effect) => {
    const dispose = effect();
    return () => void dispose?.();
  },
  locale: {
    register: (ns) => {
      locales[ns] = true;
      return () => {};
    },
  },
  remote: {
    $on: () => () => {},
  },
  settingsScope: {
    bind: (spec) => {
      registered.boundNamespace = spec.namespace;
      return scope;
    },
  },
  slots: {
    inject: (slot, factory) => {
      registered.injectedSlot = slot;
      registered.injectDispose = factory();
    },
    register: (options, component) => {
      slotRegistrations.push({ options, component });
      return () => {};
    },
  },
};

exports.apply(ctx);

/* -------------------------------------------------------------- assertions */

check("settings scope bound to the search-router namespace", registered.boundNamespace === "search-router");
check("card dictionary registered", Object.keys(locales).includes("searchRouter.card"), Object.keys(locales));
check("claimed the Plugins page card slot", registered.injectedSlot === "settings.plugin.item");
const card = slotRegistrations[0];
check("card keyed on the settings namespace", card?.options.key === "search-router", card?.options);
check("card declares its locale", card?.options.locale === "searchRouter.card");
check("card component is a function", typeof card?.component === "function");
const face = card?.options.inject();
check("face exposes the store hook", typeof face.hooks?.searchRouterCard?.getSnapshot === "function" && typeof face.hooks?.searchRouterCard?.subscribe === "function");
check("face exposes the chain actions", ["reorder", "addProvider", "removeProvider", "resetOrder", "writeTimeout", "writeEmptyFallback", "writeEndpoint", "resetField", "saveKey", "clearKey", "moveEarlier", "moveLater", "endpointUrl"].every((action) => typeof face.actions?.[action] === "function"), Object.keys(face.actions ?? {}));
const actions = face.actions;

let state = face.hooks.searchRouterCard.getSnapshot();
check("state ready + writable", state.available === true && state.writable === true);
check("auto mode with nothing configured → keyless DuckDuckGo alone", state.explicit === false && state.chain.join() === "duckduckgo" && state.addable.length === 6, { chain: state.chain, addable: state.addable });
check(
  "getSnapshot is referentially stable until a change (React #185 regression)",
  (() => {
    const first = face.hooks.searchRouterCard.getSnapshot();
    const second = face.hooks.searchRouterCard.getSnapshot();
    return first === second;
  })(),
);

/* add providers — each commits the order field immediately */
await actions.addProvider("exa");
await flush();
state = face.hooks.searchRouterCard.getSnapshot();
check("adding commits the order incl. auto DuckDuckGo", state.chain.join() === "duckduckgo,exa" && scopeWrites.at(-1)?.value === "duckduckgo, exa", { chain: state.chain, last: scopeWrites.at(-1) });
await actions.addProvider("searxng");
await flush();
await actions.addProvider("tavily");
await flush();
state = face.hooks.searchRouterCard.getSnapshot();
check("chain reflects additions in order", state.chain.join() === "duckduckgo,exa,searxng,tavily", state.chain);
check("addable shrinks to the remainder", state.addable.join() === "brave,perplexity,deepseek", state.addable);

/* drag reorder — moving searxng above exa */
await actions.reorder("searxng", "exa");
await flush();
state = face.hooks.searchRouterCard.getSnapshot();
check("drag reorder commits the new priority", state.chain.join() === "duckduckgo,searxng,exa,tavily", state.chain);
check("last write is the reordered order string", scopeWrites.at(-1)?.value === "duckduckgo, searxng, exa, tavily", scopeWrites.at(-1));
await actions.moveEarlier("tavily");
await flush();
state = face.hooks.searchRouterCard.getSnapshot();
check("keyboard moveEarlier commits", state.chain.join() === "duckduckgo,searxng,tavily,exa", state.chain);
await actions.moveLater("searxng");
await flush();
state = face.hooks.searchRouterCard.getSnapshot();
check("keyboard moveLater commits", state.chain.join() === "duckduckgo,tavily,searxng,exa", state.chain);

/* drag to end (tail zone): reorder(_, undefined) appends */
await actions.reorder("duckduckgo", void 0);
await flush();
state = face.hooks.searchRouterCard.getSnapshot();
check("reorder to end appends", state.chain.join() === "tavily,searxng,exa,duckduckgo", state.chain);

/* remove */
await actions.removeProvider("tavily");
await flush();
state = face.hooks.searchRouterCard.getSnapshot();
check("removing drops the provider and commits", state.chain.join() === "searxng,exa,duckduckgo" && scopeWrites.at(-1)?.value === "searxng, exa, duckduckgo", { chain: state.chain, last: scopeWrites.at(-1) });

/* removing every row returns to automatic */
await actions.removeProvider("searxng");
await actions.removeProvider("exa");
await actions.removeProvider("duckduckgo");
await flush();
state = face.hooks.searchRouterCard.getSnapshot();
check("empty chain unsets order (back to auto DuckDuckGo)", state.explicit === false && scopeWrites.at(-1)?.op === "unset" && scopeWrites.at(-1)?.field === "order" && state.chain.join() === "duckduckgo", { chain: state.chain, last: scopeWrites.at(-1) });

/* stored-key override: settings key persists and wins over the environment */
await actions.saveKey("tavily", "test-tavily-key");
await flush();
state = face.hooks.searchRouterCard.getSnapshot();
check("key write persists in the settings document", scopeWrites.some((write) => write.op === "set" && write.field === "tavilyApiKey" && write.value === "test-tavily-key"), scopeWrites.filter((w) => /apikey/i.test(w.field)));
check("stored flag reflects the secret sidecar", state.keys.tavily.stored === true, state.keys.tavily);
check("stored key makes the provider auto-detected", state.chain.join() === "tavily,duckduckgo" && state.explicit === false, state.chain);
check("redacted key value never rides the settings view", face.hooks.searchRouterCard.getSnapshot().keys.tavily.ref !== "test-tavily-key");
await actions.clearKey("tavily");
await flush();
state = face.hooks.searchRouterCard.getSnapshot();
check("clearing drops the stored override", scopeWrites.at(-1)?.op === "unset" && scopeWrites.at(-1)?.field === "tavilyApiKey" && state.keys.tavily.stored === false, scopeWrites.at(-1));

/* env-backed credential availability still drives auto-detection */
credentialView = { TAVILY_API_KEY: { configured: true, writable: true } };
await actions.resetOrder();
await flush();
state = face.hooks.searchRouterCard.getSnapshot();
check("env credential alone also auto-detects the provider", state.chain.join() === "tavily,duckduckgo", state.chain);
check("keys never route through the credentials domain anymore", credentialWrites.length === 0, credentialWrites);

/* per-provider editor writes */
await actions.writeEndpoint("searxng", "http://127.0.0.1:8888");
await flush();
state = face.hooks.searchRouterCard.getSnapshot();
check("searxng endpoint write lands as one field", scopeWrites.some((write) => write.op === "set" && write.field === "searxngBaseUrl" && write.value === "http://127.0.0.1:8888"), scopeWrites.filter((w) => w.field === "searxngBaseUrl"));
check("auto chain now includes searxng before duckduckgo", state.chain.join() === "tavily,searxng,duckduckgo", state.chain);
await actions.writeEndpoint("searxng", "");
await flush();
check("blank endpoint clears the field", scopeWrites.at(-1)?.op === "unset" && scopeWrites.at(-1)?.field === "searxngBaseUrl", scopeWrites.at(-1));

/* advanced writes */
check("invalid timeout refused without writing", (await actions.writeTimeout(50)) === false && !scopeWrites.some((w) => w.field === "timeoutMs"));
await actions.writeTimeout(15000);
await flush();
check("timeout write lands", scopeWrites.some((write) => write.op === "set" && write.field === "timeoutMs" && write.value === 15000));
await actions.writeEmptyFallback(false);
await flush();
check("empty-results policy write lands", scopeWrites.some((write) => write.op === "set" && write.field === "emptyResultsFallback" && write.value === false));

/* reset to automatic */
await actions.addProvider("brave");
await flush();
await actions.resetOrder();
await flush();
check("reset to automatic unsets the user order", scopeWrites.at(-1)?.op === "unset" && scopeWrites.at(-1)?.field === "order", scopeWrites.at(-1));

/* the new providers surface through the same paths */
await actions.saveKey("deepseek", "test-deepseek-key");
await flush();
state = face.hooks.searchRouterCard.getSnapshot();
check("deepseek stored key auto-detected", state.chain.includes("deepseek") === true && state.keys.deepseek.stored === true, { chain: state.chain, deepseek: state.keys.deepseek });
await actions.clearKey("deepseek");
await actions.saveKey("perplexity", "test-pplx-key");
await flush();
state = face.hooks.searchRouterCard.getSnapshot();
check("perplexity stored key auto-detected with PPLX ref", state.keys.perplexity.stored === true && state.keys.perplexity.ref === "PPLX_API_KEY", state.keys.perplexity);
await actions.clearKey("perplexity");
await flush();

/* render smoke: the component builds a descriptor tree without throwing */
try {
  const tree = card.component({
    t: (key) => key,
    useSearchRouterCard: () => state,
    actions,
  });
  check("component renders to a descriptor tree", tree?.type === "li" && tree?.props?.className === "dsr-card");
} catch (error) {
  check("component renders to a descriptor tree", false, String(error));
}

if (failures === 0) console.log("\nall client-smoke checks passed");
else {
  console.log(`\n${failures} check(s) failed`);
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
