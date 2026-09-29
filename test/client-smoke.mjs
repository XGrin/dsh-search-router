#!/usr/bin/env node
/** Browser-loader regression: current configForms/remote APIs, nested edits and teardown. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { Config } from "../src/index.js";

let moduleRecord;
const reactState = { values: [], at: 0 };
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useEffect: () => {}, useState: value => [reactState.values[reactState.at++] ?? value, () => {}],
};
vm.runInNewContext(readFileSync(new URL("../src/client/client.js", import.meta.url), "utf8"), {
  window: { __ModuleLoader__: { load(record) { moduleRecord = record; } } },
  console, setTimeout, clearTimeout,
});
assert.equal(moduleRecord.id, "dsh-search-router");
const plugin = moduleRecord.factory(id => { assert.equal(id, "react"); return React; });
assert.deepEqual(Array.from(plugin.inject), ["slots", "locale", "remote", "remote.credentials", "configForms"]);

const base = { provider: "deepseek", timeoutMs: 10000, emptyResultsFallback: true,
  providers: { exa: { apiKeyEnv: "EXA_API_KEY" }, searxng: { baseUrl: "https://search.example.com" } } };
let value = structuredClone(base), user = {}, revision = 1, ready = true, writable = true, refusal = false;
let described = { EXA_API_KEY: { configured: true }, DEEPSEEK_API_KEY: { configured: true } };
const scopeListeners = new Set(), mirrorListeners = new Set(), effects = [], writes = [];
const off = (set, listener) => { set.add(listener); return () => set.delete(listener); };
const clone = object => JSON.parse(JSON.stringify(object));
const secretPaths = () => Object.entries(value.providers ?? {}).filter(([, p]) => p.apiKey !== undefined)
  .map(([id]) => ({ path: ["providers", id, "apiKey"], set: true }));
function redacted(object) {
  const copy = clone(object);
  for (const p of Object.values(copy.providers ?? {})) delete p.apiKey;
  return copy;
}
function at(object, path) { return path.reduce((o, key) => o?.[key], object); }
function put(object, path, item) {
  let node = object;
  for (const key of path.slice(0, -1)) node = node[key] ??= {};
  if (item === undefined) delete node[path.at(-1)]; else node[path.at(-1)] = clone(item);
}
const mirror = {
  getSnapshot: () => ({ status: "ready", view: { namespaces: [{ ns: "search-router", schema: Config.toJSON(),
    value: redacted(value), secrets: secretPaths() }] } }),
  subscribe: listener => off(mirrorListeners, listener),
};
const form = {
  getSnapshot: () => ({ status: ready ? "ready" : "unavailable", value: redacted(value),
    user: redacted(user), base: redacted(base), revision, writable }),
  subscribe: listener => off(scopeListeners, listener),
  async mutate(ops, expected) {
    writes.push(clone(ops));
    if (refusal || expected !== revision) return false;
    const next = structuredClone(value);
    for (const op of ops) put(next, op.path, op.op === "set" ? op.value : at(base, op.path));
    const validation = Config["~standard"].validate(next);
    if (validation.issues) return false;
    value = next; user = structuredClone(value); revision++;
    for (const f of scopeListeners) f();
    for (const f of mirrorListeners) f();
    return true;
  },
};
let registration, component, credentialListener, servedDisposed = false, slotDisposed = false;
let describe = async refs => ({ ok: true, value: Object.fromEntries(refs.map(ref => [ref, described[ref] ?? { configured: false }])) });
const ctx = {
  effect(fn) { const dispose = fn(); effects.push(dispose); return dispose; },
  locale: { register: () => () => {} },
  configForms: {
    get(ns) { assert.equal(ns, "search-router"); return form; },
    describe: () => mirror,
    whileServed(names, fn) { assert.equal(names[0], "search-router"); const d = fn(); return () => { servedDisposed = true; d(); }; },
  },
  remote: {
    credentials: { describe: refs => describe(refs) },
    $on(name, fn) { assert.equal(name, "credentials/reference-updated"); credentialListener = fn; return () => { credentialListener = undefined; }; },
  },
  slots: {
    inject(name, fn) { assert.equal(name, "plugins.bundle.config"); const d = fn(); return () => { slotDisposed = true; d(); }; },
    register(options, render) { registration = options; component = render; return () => {}; },
  },
};
plugin.apply(ctx);
const settle = async () => { for (let n = 0; n < 6; n++) await Promise.resolve(); };
await settle();
assert.equal(registration.key, "dsh-search-router");
const injected = registration.inject(), actions = injected.actions, store = injected.hooks.searchRouterCard;
const state = () => clone(store.getSnapshot());
assert.deepEqual(state().chain, ["deepseek"], "explicit provider beats ambient Exa");
assert.ok(state().labels.exa && state().addable.includes("exa"));
const stable = store.getSnapshot(); assert.equal(store.getSnapshot(), stable);
assert.equal(await actions.addProvider("exa"), true);
assert.deepEqual(state().chain, ["deepseek", "exa"]);
assert.equal(writes.at(-1).length, 2, "single-to-chain is one atomic write");
assert.equal(value.provider, null);
assert.equal(await actions.moveEarlier("exa"), true);
assert.deepEqual(state().chain, ["exa", "deepseek"]);
assert.equal(await actions.removeProvider("deepseek"), true);
assert.equal(value.provider, "exa"); assert.equal(value.order, null);
assert.equal(await actions.saveKey("exa", "dummy-private-key"), true);
assert.ok(state().keys.exa.stored);
assert.ok(!JSON.stringify(state()).includes("dummy-private-key"));
assert.equal(await actions.writeTimeout(2500), true);
assert.equal(value.providers.exa.apiKey, "dummy-private-key", "unrelated edits preserve secrets");
assert.equal(await actions.clearKey("exa"), true);
assert.equal(value.providers.exa.apiKey, undefined);
assert.equal(await actions.writeEndpoint("searxng", "https://new.example.com"), true);
assert.equal(value.providers.searxng.baseURL, "https://new.example.com");
assert.equal(await actions.resetField("searxngBaseUrl"), true);
assert.equal(actions.endpointUrl("searxng"), "https://search.example.com");
refusal = true;
assert.equal(await actions.writeTimeout(5000), false);
assert.equal(state().status.kind, "error");
assert.equal(value.timeoutMs, 2500);
refusal = false;
writable = false;
const count = writes.length;
assert.equal(await actions.writeTimeout(4000), false);
assert.equal(writes.length, count, "read-only deployment sends no writes");
writable = true;
ready = false;
for (const listener of scopeListeners) listener();
const disconnectedWrites = writes.length;
assert.equal(await actions.writeTimeout(4000), false);
assert.equal(writes.length, disconnectedWrites, "disconnected form cannot write");
assert.equal(state().available, false);
ready = true;
for (const listener of scopeListeners) listener();
await settle();
assert.equal(state().available, true, "reconnect restores form");
const originalMutate = form.mutate;
form.mutate = async () => { throw Error("connection lost"); };
assert.equal(await actions.writeTimeout(4000), false);
assert.equal(state().status.kind, "error");
form.mutate = originalMutate;
assert.equal(await actions.writeTimeout(2500), true, "save works after reconnect");
assert.equal(await actions.writeTimeout(1), false);
assert.equal(await actions.resetOrder(), true);
assert.equal(value.provider, null); assert.equal(value.order, null);
assert.ok(state().chain.includes("duckduckgo"));
await settle();
const pending = [];
describe = refs => new Promise(resolve => pending.push({ refs, resolve }));
credentialListener("EXA_API_KEY"); credentialListener("EXA_API_KEY");
pending[1].resolve({ ok: true, value: { EXA_API_KEY: { configured: false } } });
await settle();
pending[0].resolve({ ok: true, value: { EXA_API_KEY: { configured: true } } });
await settle();
assert.equal(state().keys.exa.configured, false, "late credential replies cannot overwrite newer state");
reactState.at = 0;
const tree = component({ t: key => key, useSearchRouterCard: fn => fn(store.getSnapshot()), actions });
assert.equal(tree.type, "section");
assert.equal(tree.props["data-open"], "true");
credentialListener("EXA_API_KEY");
let notifications = 0;
store.subscribe(() => notifications++);
for (const dispose of effects.reverse()) await dispose?.();
assert.equal(scopeListeners.size, 0); assert.equal(mirrorListeners.size, 0);
assert.ok(servedDisposed && slotDisposed); assert.equal(credentialListener, undefined);
pending.at(-1).resolve({ ok: true, value: { EXA_API_KEY: { configured: true } } });
await settle();
assert.equal(notifications, 0, "disposed controller ignores late responses");
assert.equal(await actions.writeTimeout(5000), false);
console.log("client smoke passed: current slots, Config, atomic routing, hidden secrets, refused writes, races and teardown");
