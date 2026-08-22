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

/**
 * Minimal React stand-in: createElement returns plain descriptors, and
 * useState reads from a per-render queue so tests can drive the card's
 * local UI state (open, editing, adding) through the same call order the
 * component uses.
 */
const reactState = { queue: [], index: 0 };
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  Fragment: Symbol.for("react.fragment"),
  useEffect: () => {},
  useState: (initial) => {
    const slot = reactState.index;
    reactState.index += 1;
    return [slot < reactState.queue.length ? reactState.queue[slot] : initial, () => {}];
  },
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

/**
 * The serialized schema envelope the browser actually receives through
 * `settings.describe` — the REAL `settingsConfig(...).toJSON()` from the
 * host half, so the stub cannot drift from what the wire carries
 * (schemastery's reffed form: dict values are uid pointers into `refs`).
 * The scope snapshot itself carries NO schema (see SettingsScopeSnapshot),
 * so the card must parse this envelope.
 */
const { BACKENDS } = await import(pathToFileURL(resolve("src/router.js")).href);
const { providerCatalog, settingsConfig } = await import(pathToFileURL(resolve("src/settings.js")).href);
const SCHEMA_ENVELOPE = settingsConfig(providerCatalog(BACKENDS)).toJSON();

const baseLayer = {
  provider: "", order: "", timeoutMs: 10000, emptyResultsFallback: true,
  exaApiKeyEnv: "EXA_API_KEY", tavilyApiKeyEnv: "TAVILY_API_KEY", braveApiKeyEnv: "BRAVE_SEARCH_API_KEY",
  perplexityApiKeyEnv: "PPLX_API_KEY", deepseekApiKeyEnv: "DEEPSEEK_API_KEY",
  searxngBaseUrl: "",
};
const userLayer = {};
let scopeListener = () => {};
const scope = {
  getSnapshot: () => ({
    status: "ready",
    writable: true,
    revision: 1,
    base: baseLayer,
    user: Object.keys(userLayer).length > 0 ? { ...userLayer } : void 0,
    value: { ...baseLayer, ...userLayer },
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
            schema: SCHEMA_ENVELOPE,
            value: { ...baseLayer, ...userLayer },
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
/* the wire schema arrives asynchronously — let the describe read settle */
await flush();

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

/* base-layer preset flag: a key set in the profile config counts as configured */
baseLayer.exaKeyPreset = true;
scopeListener();
state = face.hooks.searchRouterCard.getSnapshot();
check("composition preset flag marks the provider configured", state.keys.exa.preset === true && state.chain.includes("exa") === true, { chain: state.chain, exa: state.keys.exa });
delete baseLayer.exaKeyPreset;
scopeListener();

/* render smoke: walk the descriptor tree — labels must actually appear */
const walkTree = (node, visit) => {
  if (Array.isArray(node)) {
    for (const child of node) walkTree(child, visit);
    return;
  }
  if (node !== null && typeof node === "object") {
    visit(node);
    // Resolve component references (ProviderRow, AddProviderCard, icons…):
    // their content lives in the descriptor the function returns.
    if (typeof node.type === "function") {
      walkTree(node.type(node.props), visit);
      return;
    }
    for (const child of node.children ?? []) walkTree(child, visit);
  }
};
const nodesWith = (root, className) => {
  const found = [];
  walkTree(root, (node) => {
    if (node.props?.className === className) found.push(node);
  });
  return found;
};
const renderProps = {
  t: (key, params) => (params === undefined ? key : `${key} ${Object.values(params).join(" ")}`),
  useSearchRouterCard: () => state,
  actions,
};
const renderCard = (uiState) => {
  reactState.queue = uiState;
  reactState.index = 0;
  return card.component(renderProps);
};
try {
  state = face.hooks.searchRouterCard.getSnapshot();
  const tree = renderCard([true]);
  check("component renders to a descriptor tree", tree?.type === "li" && tree?.props?.className === "dsr-card");
  const rows = nodesWith(tree, "dsr-rowname");
  check(
    "every chain row renders its provider label",
    rows.length === state.chain.length && rows.every((row) => typeof row.children[0] === "string" && row.children[0] === state.labels[state.chain[rows.indexOf(row)]]),
    { chain: state.chain, rowNames: rows.map((row) => row.children[0]) },
  );
  const grips = nodesWith(tree, "dsr-grip");
  check(
    "grip aria-labels carry the provider name, never undefined",
    grips.length === state.chain.length && grips.every((grip) => String(grip.props["aria-label"]).includes(state.labels[state.chain[grips.indexOf(grip)]]) && !String(grip.props["aria-label"]).includes("undefined")),
    grips.map((grip) => grip.props["aria-label"]),
  );
  const addTree = renderCard([true, void 0, true]);
  const select = nodesWith(addTree, "dsr-select")[0];
  const options = [];
  walkTree(select, (node) => {
    if (node.type === "option" && node.props?.value !== "" && node.props?.value !== undefined) options.push(node);
  });
  check(
    "add-provider dropdown shows labels, not raw ids",
    select !== undefined && options.length === state.addable.length && options.every((option) => option.children[0] === state.labels[option.props.value]),
    options.map((option) => [option.props.value, option.children[0]]),
  );
} catch (error) {
  check("component renders to a descriptor tree", false, String(error));
}

/* first-frame race regression: a fresh bind reads credential state through
   the wire describe alone — NO scope event fires between bind and read, so
   an env-backed provider must already appear in the first snapshot */
{
  credentialView = { TAVILY_API_KEY: { configured: true, writable: true } };
  let credentialReads = 0;
  const api2 = {
    credentials: {
      describe: async ({ refs }) => {
        credentialReads += 1;
        return { result: { ok: true, value: { credentials: Object.fromEntries(refs.map((ref) => [ref, credentialView[ref] ?? { configured: false, writable: true }])) } } };
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
              schema: SCHEMA_ENVELOPE,
              value: { ...baseLayer, ...userLayer },
              secrets: ["exaApiKey", "tavilyApiKey", "braveApiKey", "perplexityApiKey", "deepseekApiKey"].map((field) => ({ path: [field], set: Object.hasOwn(userLayer, field) })),
            }],
          },
        },
      }),
    },
  };
  const subscribedEvents = [];
  const ctx2 = {
    get: (name) => (name === "connection" ? { api: api2 } : undefined),
    effect: (effect) => {
      const dispose = effect();
      return () => void dispose?.();
    },
    locale: { register: () => () => {} },
    remote: { $on: (event) => {
      subscribedEvents.push(event);
      return () => {};
    } },
    settingsScope: { bind: () => scope },
    slots: { inject: (slot, factory) => factory(), register: (options) => { slotRegistrations.push({ options }); return () => {}; } },
  };
  exports.apply(ctx2);
  await flush();
  check("subscribes to the credential-invalidation event", subscribedEvents.includes("credentials/reference-updated"), subscribedEvents);
  check("subscribes exactly one credential event", subscribedEvents.length === 1, subscribedEvents);
  const fresh = slotRegistrations.at(-1)?.options.inject();
  const first = fresh.hooks.searchRouterCard.getSnapshot();
  check("fresh bind shows the env-keyed provider on the FIRST frame", first.chain.includes("tavily") === true, { chain: first.chain });
  check("credential state was read without any scope event", credentialReads >= 1, credentialReads);
  credentialView = {};
}

if (failures === 0) console.log("\nall client-smoke checks passed");
else {
  console.log(`\n${failures} check(s) failed`);
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
