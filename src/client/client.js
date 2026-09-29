/** DSH 0.1.7 browser bundle: live nested Config, shared mirror, and third-party settings page. */
window.__ModuleLoader__.load({
	id: "dsh-search-router",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const { createElement: h, useEffect, useState } = React;

		//#region constants

		/** Settings namespace the host half serves (== the plugin's short name). */
		const NS = "search-router";
		/** Locale dictionary namespace for this card's copy. */
		const LOCALE_NS = "searchRouter.card";
		/** The Plugins page's keyed card slot. */
		const ITEM_SLOT = "plugins.bundle.config";
		/** Sentinel row key for the drag-to-end drop zone. */
		const TAIL = "__tail__";

		/**
		 * The catalog before the wire schema arrives — no providers, no
		 * keys, nothing usable: the card renders its loading state.
		 */
		const EMPTY_CATALOG = Object.freeze({ ids: [], keyed: [] });

		/**
		 * Derive the provider catalog from the settings namespace's
		 * SERIALIZED schema envelope (`settings.describe`'s `schema` field —
		 * schemastery's `toJSON()` reffed form; the scope snapshot itself
		 * carries only values). Nested providers.<id> sections and their
		 * metadata declare labels, credential references and endpoint needs.
		 * Adding a provider file therefore needs no client catalog edit.
		 * @param envelope - the serialized schema envelope (uid + refs).
		 * @returns {{ ids: string[], keyed: string[], labels: Record<string, string> }} the catalog.
		 */
		function catalogFromEnvelope(envelope) {
      if (envelope === null || typeof envelope !== "object") return EMPTY_CATALOG;
      const refs = envelope.refs ?? {};
      const deref = entry => typeof entry === "number" ? refs[entry]
        : entry?.uid !== undefined ? refs[entry.uid] : entry;
      const dict = deref(deref(envelope)?.dict?.providers)?.dict;
      if (!dict) return EMPTY_CATALOG;
      const ids = Object.keys(dict), keyed = [], endpoints = [], labels = {}, envs = {}, baseUrlEnvs = {};
      for (const id of ids) {
        const meta = deref(dict[id])?.meta ?? {};
        labels[id] = meta.providerLabel ?? id;
        if (meta.providerKeyEnv) { keyed.push(id); envs[id] = meta.providerKeyEnv; }
        if (meta.providerNeedsBaseUrl) endpoints.push(id);
        if (meta.providerBaseUrlEnv) baseUrlEnvs[id] = meta.providerBaseUrlEnv;
      }
      return { ids, keyed, endpoints, labels, envs, baseUrlEnvs };
    }

		//#endregion
		//#region stylesheet (values mirror the Models settings page)

		const CSS = `
.dsr-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}
.dsr-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.dsr-card[data-open=true]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.dsr-head{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.dsr-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dsr-headtext{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.dsr-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.dsr-desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.dsr-chev{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}
.dsr-chev[data-open=true]{transform:rotate(180deg)}
.dsr-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding:12px 0 14px;display:flex;flex-direction:column}
.dsr-readonly{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:18px}
.dsr-banner{color:var(--dsw-alias-label-tertiary);align-items:center;gap:8px;margin:0;font-size:12px;line-height:18px;display:flex}
.dsr-reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5;flex:none}
.dsr-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.dsr-reset:disabled{cursor:default;opacity:.4}
.dsr-reset:focus-visible{outline:2px solid var(--dsw-alias-border-l3);outline:none}
.dsr-rows{flex-direction:column;gap:8px;margin:0;padding:0;list-style:none;display:flex}
.dsr-tail{border:1px dashed var(--dsw-alias-border-l3);border-radius:8px;justify-content:center;list-style:none;display:flex}
.dsr-tail[data-over=true]{border-color:var(--dsw-alias-brand-primary)}
.dsr-taillabel{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;padding:2px 0}
.dsr-row{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;flex-direction:column;gap:12px;padding:12px 14px;display:flex}
.dsr-row[data-dragging=true]{opacity:.45}
.dsr-row[data-dropbefore=true]{border-top:2px solid var(--dsw-alias-brand-primary);margin-top:-1px}
.dsr-rowhead{align-items:center;gap:10px;display:flex}
.dsr-grip{box-sizing:border-box;width:28px;height:28px;color:var(--dsw-alias-label-tertiary);cursor:grab;background:0 0;border:none;border-radius:6px;justify-content:center;align-items:center;display:inline-flex}
.dsr-grip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsr-grip:active{cursor:grabbing}
.dsr-grip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsr-rank{border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);border-radius:4px;flex:none;min-width:20px;text-align:center;padding:1px 6px;font-size:11px;line-height:16px}
.dsr-rowname{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}
.dsr-rowtag{border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);border-radius:4px;flex:none;padding:1px 6px;font-size:11px;line-height:16px}
.dsr-dot{box-sizing:border-box;border-radius:50%;flex:none;width:8px;height:8px;display:inline-block}
.dsr-dot[data-state=ok]{background:var(--dsw-alias-state-success-primary)}
.dsr-dot[data-state=missing]{background:var(--dsw-alias-state-error-primary)}
.dsr-rowactions{align-items:center;gap:4px;margin-left:auto;display:inline-flex}
.dsr-btn{box-sizing:border-box;height:28px;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;background:0 0;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;align-items:center;gap:4px;padding:0 10px;font-size:12px;line-height:18px;display:inline-flex}
.dsr-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}
.dsr-btn:disabled{opacity:.4;cursor:default}
.dsr-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:transparent}
.dsr-btn-danger:hover:not(:disabled){background:var(--dsh-alias-interactive-bg-hover-danger);background:var(--dsw-alias-interactive-bg-hover-danger)}
.dsr-btn-confirm{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border-color:transparent}
.dsr-btn-confirm:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dsr-btn:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3);outline:none}
.dsr-editor{background:var(--dsw-alias-bg-module-platform);border-radius:12px;flex-direction:column;gap:14px;padding:14px 16px;display:flex}
.dsr-editorhead{align-items:baseline;gap:8px;display:flex}
.dsr-editortitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}
.dsr-editorsub{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dsr-field{flex-direction:column;gap:6px;padding:12px 0;display:flex}
.dsr-field+.dsr-field{border-top:1px solid var(--dsw-alias-border-l2)}
.dsr-fieldlabel{min-width:0;align-items:center;gap:8px;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5;display:flex}
.dsr-fieldhint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}
.dsr-fieldhint[role=alert]{color:var(--dsw-alias-label-error)}
.dsr-input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5;box-sizing:border-box;width:100%}
.dsr-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.dsr-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.dsr-input::placeholder{color:var(--dsw-alias-label-dimmed)}
.dsr-editoractions{justify-content:flex-end;gap:8px;display:flex}
.dsr-check{align-items:center;gap:8px;display:flex}
.dsr-check input{width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-brand-primary)}
.dsr-add{border:1px dashed var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;background:0 0;border-radius:12px;justify-content:center;align-items:center;gap:6px;min-width:180px;height:44px;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex}
.dsr-add:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsr-add:disabled{opacity:.4;cursor:default}
.dsr-add:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3);outline:none}
.dsr-addcard{background:var(--dsw-alias-bg-module-platform);border-radius:12px;flex-direction:column;gap:14px;padding:14px 16px;display:flex}
.dsr-select{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 32px 0 12px;font-size:13px;line-height:1.5;cursor:pointer;max-width:240px;appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-position:right 12px center;background-repeat:no-repeat;background-size:12px 12px}
.dsr-select:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.dsr-adv{border-top:1px solid var(--dsw-alias-border-l2);padding-top:10px}
.dsr-advsummary{cursor:pointer;width:fit-content;color:var(--dsw-alias-label-secondary);border-radius:6px;align-items:center;gap:6px;padding:2px 0;font-size:12px;font-weight:500;line-height:18px;list-style:none;display:flex}
.dsr-advsummary::-webkit-details-marker{display:none}
.dsr-advsummary:before{content:"";border-bottom:1.5px solid;border-right:1.5px solid;width:5px;height:5px;transition:transform .12s;transform:rotate(-45deg) translate(-1px,-1px)}
.dsr-adv[open]>.dsr-advsummary:before{transform:rotate(45deg) translate(-1px,-1px)}
.dsr-advsummary:hover{color:var(--dsw-alias-label-primary)}
.dsr-advbody{flex-direction:column;padding-top:2px;display:flex}
.dsr-fieldInline{flex-direction:row;align-items:center}
.dsr-status{color:var(--dsw-alias-state-success-primary);margin:0;font-size:12px;line-height:18px}
.dsr-status[data-kind=error]{color:var(--dsw-alias-state-error-primary)}
.dsr-empty{border:1px dashed var(--dsw-alias-border-l3);color:var(--dsw-alias-label-tertiary);text-align:center;border-radius:8px;margin:0;padding:12px;font-size:12px;line-height:18px}
@media (prefers-reduced-motion:reduce){.dsr-advsummary:before{transition:none}}
`;
		function ensureStyles() {
			const tagId = "dsh-search-router/card.css";
			if (typeof document === "undefined" || document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-search-router";
			tag.dataset.pluginCss = tagId;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		//#endregion
		//#region controller

		/**
		 * The card's state: the settings scope, the credentials domain, and the
		 * derived chain. Structural changes commit immediately — one scoped
		 * settings write per action — because a drag IS the user's decision;
		 * there is nothing to preview. The snapshot is minted only in publish()
		 * so useSyncExternalStore sees a stable reference between changes.
		 */
		class SearchRouterCardController {
      constructor(scope, mirror, remote) {
        this.scope = scope;
        this.mirror = mirror;
        this.remote = remote;
        this.listeners = new Set();
        this.busy = false;
        this.disposed = false;
        this.generation = 0;
        this.credentials = {};
        this.stored = {};
        this.catalog = EMPTY_CATALOG;
        this.cached = this.projection();
        this.disposers = [
          scope.subscribe(() => this.readState()),
          mirror.subscribe(() => this.readState()),
        ];
        this.readState();
      }

      view = {
        getSnapshot: () => this.cached,
        subscribe: listener => {
          this.listeners.add(listener);
          return () => this.listeners.delete(listener);
        },
      };

      snapshotOf() { return this.scope.getSnapshot(); }
      providerSection(id) { return this.snapshotOf().value?.providers?.[id] ?? {}; }
      fieldPath(field) {
        const match = /^(\w+)(ApiKeyEnv|ApiKey|BaseUrl)$/.exec(field);
        if (!match || !this.catalog.ids.includes(match[1])) return [field];
        return ["providers", match[1], { ApiKeyEnv: "apiKeyEnv", ApiKey: "apiKey", BaseUrl: "baseURL" }[match[2]]];
      }
      sectionValue(field) {
        return this.fieldPath(field).reduce((node, key) => node?.[key], this.snapshotOf().value);
      }
      overridden(field) {
        const path = this.fieldPath(field);
        const parent = path.slice(0, -1).reduce((node, key) => node?.[key], this.snapshotOf().user);
        if (parent !== undefined && parent !== null && Object.hasOwn(parent, path.at(-1))) return true;
        return path[2] === "baseURL" && parent !== undefined && parent !== null && Object.hasOwn(parent, "baseUrl");
      }
      keyConfigured(id) { return this.credentials[id]?.configured === true; }
      keyStored(id) { return this.stored[id] === true; }
      presetKey() { return false; }
      hasBaseUrlField(id) { return (this.catalog.endpoints ?? []).includes(id); }
      keyless(id) { return !this.catalog.keyed.includes(id) && !this.hasBaseUrlField(id); }
      envOf(id) { return this.providerSection(id).apiKeyEnv ?? this.catalog.envs?.[id] ?? ""; }
      baseUrlRef(id) { return this.providerSection(id).baseUrlEnv ?? this.catalog.baseUrlEnvs?.[id] ?? ""; }
      endpointUrl(id) { const p = this.providerSection(id); return String(p.baseURL ?? p.baseUrl ?? "").trim(); }
      usable(id) {
        if (this.keyless(id)) return true;
        if (this.hasBaseUrlField(id)) return this.endpointUrl(id) !== "" || this.credentials[id]?.configured === true;
        return this.keyConfigured(id) || this.keyStored(id);
      }
      explicitOrder() {
        return this.sectionValue("provider") != null || this.sectionValue("order") != null;
      }
      chain() {
        const order = this.sectionValue("order"), provider = this.sectionValue("provider");
        if (Array.isArray(order)) return order.filter(id => this.catalog.ids.includes(id));
        if (provider != null) return this.catalog.ids.includes(provider) ? [provider] : [];
        return this.catalog.ids.filter(id => this.usable(id));
      }

      /** Atomic path edits preserve masked credentials and fence stale views. */
      async write(ops) {
        if (this.disposed || this.busy || !this.snapshotOf().writable || this.snapshotOf().status !== "ready") return false;
        this.busy = true;
        this.status = undefined;
        this.publish();
        let accepted = false;
        try {
          accepted = await this.scope.mutate(Array.isArray(ops) ? ops : [ops], this.snapshotOf().revision);
        } catch (_transportFailure) {
          // Only a generic, localized failure reaches the card; never a wire payload.
        }
        if (this.disposed) return false;
        this.busy = false;
        this.status = { kind: accepted ? "ok" : "error" };
        this.publish();
        return accepted;
      }
      commitChain(ids) {
        const unique = [...new Set(ids)];
        if (unique.some(id => !this.catalog.ids.includes(id))) return Promise.resolve(false);
        return this.write([
          { op: "set", path: ["provider"], value: unique.length === 1 ? unique[0] : null },
          { op: "set", path: ["order"], value: unique.length > 1 ? unique : null },
        ]);
      }
      reorder(dragId, targetId) {
        const current = this.chain();
        if (!current.includes(dragId) || (targetId !== undefined && !current.includes(targetId))) return Promise.resolve(false);
        const ids = current.filter(id => id !== dragId);
        const at = targetId === undefined ? ids.length : ids.indexOf(targetId);
        ids.splice(at < 0 ? ids.length : at, 0, dragId);
        return this.commitChain(ids);
      }
      addProvider(id) { return this.commitChain([...this.chain(), id]); }
      removeProvider(id) { return this.commitChain(this.chain().filter(candidate => candidate !== id)); }
      resetOrder() { return this.commitChain([]); }
      moveEarlier(id) { return this.move(id, -1); }
      moveLater(id) { return this.move(id, 1); }
      move(id, delta) {
        const ids = this.chain(), at = ids.indexOf(id);
        if (at < 0 || at + delta < 0 || at + delta >= ids.length) return Promise.resolve(false);
        [ids[at], ids[at + delta]] = [ids[at + delta], ids[at]];
        return this.commitChain(ids);
      }
      writeTimeout(value) {
        return Number.isInteger(value) && value >= 100
          ? this.write({ op: "set", path: ["timeoutMs"], value }) : Promise.resolve(false);
      }
      writeEmptyFallback(value) { return this.write({ op: "set", path: ["emptyResultsFallback"], value }); }
      writeEndpoint(id, text) {
        const value = String(text ?? "").trim();
        if (value === "") return this.resetField(id + "BaseUrl");
        return this.write([
          { op: "set", path: ["providers", id, "baseURL"], value },
          { op: "set", path: ["providers", id, "baseUrl"], value: null },
        ]);
      }
      resetField(field) {
        const path = this.fieldPath(field);
        const ops = [{ op: "unset", path }];
        if (path[2] === "baseURL") ops.push({ op: "unset", path: ["providers", path[1], "baseUrl"] });
        return this.write(ops);
      }
      saveKey(id, value) { return this.write({ op: "set", path: ["providers", id, "apiKey"], value }); }
      clearKey(id) { return this.write({ op: "unset", path: ["providers", id, "apiKey"] }); }

      readState() {
        if (this.disposed) return;
        const view = this.mirror.getSnapshot().view?.namespaces.find(candidate => candidate.ns === NS);
        this.catalog = view ? catalogFromEnvelope(view.schema) : EMPTY_CATALOG;
        this.stored = Object.fromEntries(this.catalog.keyed.map(id => [
          id, (view?.secrets ?? []).some(secret => secret.set && secret.path?.join(".") === "providers." + id + ".apiKey"),
        ]));
        this.publish();
        void this.readCredentialAvailability();
      }
      async readCredentialAvailability() {
        const generation = ++this.generation;
        const ids = [...this.catalog.keyed, ...(this.catalog.endpoints ?? [])];
        const refsById = Object.fromEntries(ids.map(id => [id, this.hasBaseUrlField(id) ? this.baseUrlRef(id) : this.envOf(id)]));
        const refs = [...new Set(Object.values(refsById).filter(Boolean))];
        if (refs.length === 0) return;
        let response;
        try { response = await this.remote.credentials.describe(refs); }
        catch (_readFailure) { return; }
        if (this.disposed || generation !== this.generation || !response.ok) return;
        this.credentials = Object.fromEntries(ids.map(id => [id, {
          ref: refsById[id], configured: response.value[refsById[id]]?.configured ?? false,
        }]));
        this.publish();
      }
      refreshCredential(ref) {
        if (this.catalog.ids.some(id => this.envOf(id) === ref || this.baseUrlRef(id) === ref)) void this.readCredentialAvailability();
      }
      dispose() {
        this.disposed = true;
        ++this.generation;
        for (const dispose of this.disposers) dispose();
        this.listeners.clear();
      }
      projection() {
        const snap = this.snapshotOf();
        return {
          available: snap.status === "ready", writable: snap.writable, busy: this.busy, status: this.status,
          explicit: this.explicitOrder(), chain: this.chain(),
          labels: this.catalog.labels ?? {},
          addable: this.catalog.ids.filter(id => !this.chain().includes(id)),
          keys: Object.fromEntries(this.catalog.keyed.map(id => [id, { ...this.credentials[id], stored: this.keyStored(id), preset: false }])),
          endpoints: Object.fromEntries((this.catalog.endpoints ?? []).map(id => [id, {
            url: this.endpointUrl(id), configured: this.usable(id), overridden: this.overridden(id + "BaseUrl"),
          }])),
          timeoutMs: { value: this.sectionValue("timeoutMs"), overridden: this.overridden("timeoutMs") },
          emptyFallback: { value: this.sectionValue("emptyResultsFallback") !== false, overridden: this.overridden("emptyResultsFallback") },
          orderOverridden: this.overridden("order") || this.overridden("provider"),
        };
      }
      publish() {
        if (this.disposed) return;
        this.cached = this.projection();
        for (const listener of this.listeners) listener();
      }
      inject() {
        const names = ["reorder", "addProvider", "removeProvider", "resetOrder", "writeTimeout", "writeEmptyFallback",
          "writeEndpoint", "resetField", "saveKey", "clearKey", "moveEarlier", "moveLater", "endpointUrl"];
        return { hooks: { searchRouterCard: this.view }, actions: Object.fromEntries(names.map(name => [name, (...args) => this[name](...args)])) };
      }
    }

		//#endregion
		//#region icons

		function IconChevron({ open }) {
			return h("svg", { className: "dsr-chev", "data-open": open ? "true" : void 0, width: "14", height: "14", viewBox: "0 0 14 14", "aria-hidden": "true" },
				h("path", { d: "M3 5l4 4 4-4", fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round" })
			);
		}

		function IconGrip() {
			return h("svg", { width: "10", height: "14", viewBox: "0 0 10 14", "aria-hidden": "true" },
				Array.from({ length: 6 }, (_, index) => h("circle", { key: index, cx: index % 2 === 0 ? 3 : 7, cy: 3 + Math.floor(index / 2) * 4, r: "1.4", fill: "currentColor" }))
			);
		}

		function IconPlus() {
			return h("svg", { width: "12", height: "12", viewBox: "0 0 12 12", "aria-hidden": "true" },
				h("path", { d: "M6 2v8M2 6h8", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round" })
			);
		}

		//#endregion
		//#region components

		/** The expandable card: header row plus the chain editor. */
		function SearchRouterCard(props) {
			const { t } = props;
			const state = props.useSearchRouterCard((snapshot) => snapshot);
			const [open, setOpen] = useState(true);
			const [editing, setEditing] = useState(void 0);
			const [adding, setAdding] = useState(false);
			const [dragId, setDragId] = useState(void 0);
			const [overId, setOverId] = useState(void 0);
			useEffect(() => {
				ensureStyles();
			}, []);
			if (!state.available) return null;
			const disabled = !state.writable || state.busy;
			const endDrag = () => {
				setDragId(void 0);
				setOverId(void 0);
			};
			return h("section", { className: "dsr-card", "data-open": open ? "true" : void 0 },
				h("button", {
					type: "button", className: "dsr-head", "aria-expanded": open,
					"aria-label": `${t(open ? "collapse" : "expand")}: ${t("title")}`,
					onClick: () => {
						setOpen(!open);
					}
				},
					h("span", { className: "dsr-headtext" },
						h("span", { className: "dsr-name" }, t("title")),
						h("span", { className: "dsr-desc" }, t("description"))
					),
					h(IconChevron, { open })
				),
				open ? h("div", { className: "dsr-body" },
					!state.writable ? h("p", { className: "dsr-readonly", role: "status" }, t("readOnly")) : null,
					h("p", { className: "dsr-banner" },
						state.explicit ? t("explicitBanner") : t("autoBanner"),
						state.orderOverridden ? h("button", { type: "button", className: "dsr-reset", disabled, onClick: () => {
							props.actions.resetOrder();
						} }, t("resetToAuto")) : null
					),
					state.chain.length === 0 ? h("p", { className: "dsr-empty" }, t("emptyChain")) : h("ul", { className: "dsr-rows" },
						state.chain.map((id, index) => h(ProviderRow, {
							key: id, id, rank: index + 1, t, state, disabled,
							label: state.labels[id] ?? id,
							primary: index === 0,
							keyState: props0(state, id).ok ? "ok" : "missing",
							keyLabel: t(props0(state, id).ok ? "configured" : props0(state, id).kind === "keyless" ? "keyless" : "notConfigured"),
							storedKey: state.keys[id]?.stored === true,
							editable: props0(state, id).kind !== "keyless",
							endpoint: props0(state, id).kind === "endpoint" ? { url: state.endpoints[id]?.url ?? "", overridden: state.endpoints[id]?.overridden === true } : undefined,
							editing: editing === id,
							dragging: dragId === id,
							dropBefore: overId === id && dragId !== void 0 && dragId !== id,
							onEdit: () => {
								setAdding(false);
								setEditing(editing === id ? void 0 : id);
							},
							onRemove: () => {
								setEditing(void 0);
								props.actions.removeProvider(id);
							},
							onDragStart: () => {
								setDragId(id);
							},
							onDragOver: (over) => {
								setOverId(over ? id : void 0);
							},
							onDrop: () => {
								if (dragId !== void 0 && dragId !== id) props.actions.reorder(dragId, id);
								endDrag();
							},
							onDragEnd: endDrag,
							onMove: (delta) => {
								if (delta < 0) props.actions.moveEarlier(id);
								else props.actions.moveLater(id);
							},
							actions: props.actions
						})),
						dragId !== void 0 ? h("li", {
							className: "dsr-tail",
							"data-over": overId === TAIL ? "true" : void 0,
							onDragOver: (event) => {
								if (event.dataTransfer.types.includes("text/plain") !== true) return;
								event.preventDefault();
								event.dataTransfer.dropEffect = "move";
								setOverId(TAIL);
							},
							onDrop: (event) => {
								event.preventDefault();
								if (dragId !== void 0) props.actions.reorder(dragId, void 0);
								endDrag();
							}
						}, h("span", { className: "dsr-taillabel" }, t("dropToEnd"))) : null
					),
					state.addable.length > 0 ? (adding ? h(AddProviderCard, {
						t, addable: state.addable, disabled, stateLabels: state.labels,
						onAdd: (id) => {
							setAdding(false);
							if (id !== "") props.actions.addProvider(id);
						},
						onCancel: () => {
							setAdding(false);
						}
					}) : h("button", { type: "button", className: "dsr-add", disabled, onClick: () => {
						setEditing(void 0);
						setAdding(true);
					} }, h(IconPlus), t("add"))) : null,
					h(AdvancedFold, { t, state, disabled, actions: props.actions }),
					state.status !== void 0 ? h("p", { className: "dsr-status", role: "status", "data-kind": state.status.kind }, state.status.kind === "error" ? t("writeFailed") : t("saved")) : null
				) : null
			);
		}

		/** The add flow: a placeholder select plus an explicit confirm button. */
		function AddProviderCard(props) {
			const { t } = props;
			const stateLabels = props.stateLabels ?? {};
			const [pick, setPick] = useState("");
			return h("div", { className: "dsr-addcard" },
				h("div", { className: "dsr-field" },
					h("span", { className: "dsr-fieldlabel" }, t("addProvider")),
					h("select", {
						className: "dsr-select", value: pick, disabled: props.disabled,
						"aria-label": t("addProvider"),
						onChange: (event) => {
							setPick(event.target.value);
						}
					}, [h("option", { value: "", key: "" }, t("addPick")), ...props.addable.map((id) => h("option", { value: id, key: id }, stateLabels[id] ?? id))])
				),
				h("div", { className: "dsr-editoractions" },
					h("button", { type: "button", className: "dsr-btn", onClick: props.onCancel }, t("cancel")),
					h("button", { type: "button", className: "dsr-btn dsr-btn-confirm", disabled: pick === "" || props.disabled, onClick: () => {
						props.onAdd(pick);
					} }, t("add"))
				)
			);
		}

		/** One provider's readiness projection for the row chrome. */
		function props0(state, id) {
			if (state.keys[id]?.configured === true || state.keys[id]?.stored === true || state.keys[id]?.preset === true) return { kind: "key", ok: true };
			const endpoint = state.endpoints?.[id];
			if (endpoint !== undefined) return { kind: "endpoint", ok: endpoint.configured === true };
			if (state.keys[id] !== undefined) return { kind: "key", ok: false };
			return { kind: "keyless", ok: true };
		}

		/** One provider in the chain: rank, name, credential dot, actions. */
		function ProviderRow(props) {
			const { t } = props;
			return h("li", {
				className: "dsr-row",
				"data-dragging": props.dragging ? "true" : void 0,
				"data-dropbefore": props.dropBefore ? "true" : void 0,
				draggable: !props.disabled,
				onDragStart: (event) => {
					event.dataTransfer.effectAllowed = "move";
					event.dataTransfer.setData("text/plain", `dsh-search-router/${props.id}`);
					props.onDragStart();
				},
				onDragOver: (event) => {
					if (event.dataTransfer.types.includes("text/plain") !== true) return;
					event.preventDefault();
					event.dataTransfer.dropEffect = "move";
					props.onDragOver(true);
				},
				onDragLeave: (event) => {
					// Only clear when the pointer leaves the row itself, not on
					// the child-element crossings the event also fires for.
					if (event.currentTarget.contains(event.relatedTarget)) return;
					props.onDragOver(false);
				},
				onDrop: (event) => {
					event.preventDefault();
					props.onDrop();
				},
				onDragEnd: props.onDragEnd
			},
				h("div", { className: "dsr-rowhead" },
					h("button", { type: "button", className: "dsr-grip", "aria-label": t("dragHandle", { name: props.label }), disabled: props.disabled, onKeyDown: (event) => {
					if (event.key === "ArrowUp") {
						event.preventDefault();
						props.onMove(-1);
					} else if (event.key === "ArrowDown") {
						event.preventDefault();
						props.onMove(1);
					}
				} }, h(IconGrip)),
					h("span", { className: "dsr-rank" }, String(props.rank)),
					h("span", { className: "dsr-rowname" }, props.label),
					props.primary ? h("span", { className: "dsr-rowtag" }, t("primaryTag")) : null,
					h("span", { className: "dsr-dot", "data-state": props.keyState, role: "img", "aria-label": props.keyLabel, title: props.keyLabel }),
					h("span", { className: "dsr-rowactions" },
						props.editable ? h("button", { type: "button", className: "dsr-btn", disabled: props.disabled, onClick: props.onEdit }, t("edit")) : null,
						h("button", { type: "button", className: "dsr-btn dsr-btn-danger", disabled: props.disabled, onClick: props.onRemove }, t("remove"))
					)
				),
				props.editing ? (props.endpoint !== undefined ? h(EndpointEditor, { id: props.id, endpoint: props.endpoint, state: props.state, t, disabled: props.disabled, actions: props.actions }) : h(KeyEditor, { id: props.id, t, state: props.state, disabled: props.disabled, actions: props.actions })) : null
			);
		}

		/** The inline key editor for a keyed provider. */
		function KeyEditor(props) {
			const { t } = props;
			const [text, setText] = useState("");
			const trimmed = text.trim();
			const key = props.state.keys[props.id] ?? {};
			const blocked = props.disabled || trimmed === "";
			return h("div", { className: "dsr-editor" },
				h("div", { className: "dsr-editorhead" },
					h("span", { className: "dsr-editortitle" }, props.state.labels[props.id] ?? props.id),
					h("span", { className: "dsr-editorsub" }, key.stored === true ? t("storedKey") : key.preset === true ? t("presetKey") : key.configured === true ? t("envKey", { ref: key.ref ?? "" }) : t("noKey"))
				),
				h("div", { className: "dsr-field" },
					h("span", { className: "dsr-fieldlabel" }, t("apiKey")),
					h("input", {
						className: "dsr-input", type: "password", autoComplete: "off", value: text, disabled: props.disabled,
						placeholder: key.stored === true || key.configured === true ? t("keyKeep") : t("keyEnter"),
						onChange: (event) => {
							setText(event.target.value);
						}
					})
				),
				h("div", { className: "dsr-editoractions" },
					key.stored === true ? h("button", { type: "button", className: "dsr-btn dsr-btn-danger", disabled: props.disabled, onClick: () => {
						setText("");
						props.actions.clearKey(props.id);
					} }, t("clearKey")) : null,
					h("button", { type: "button", className: "dsr-btn dsr-btn-confirm", disabled: blocked, onClick: () => {
						props.actions.saveKey(props.id, trimmed).then((ok) => {
							if (ok) setText("");
						});
					} }, t("apply"))
				)
			);
		}

		/** The inline endpoint editor for SearXNG. */
		function EndpointEditor(props) {
			const { t } = props;
			const [text, setText] = useState(props.endpoint.url);
			const trimmed = text.trim();
			const changed = trimmed !== props.endpoint.url;
			return h("div", { className: "dsr-editor" },
				h("div", { className: "dsr-editorhead" },
					h("span", { className: "dsr-editortitle" }, props.state.labels[props.id] ?? props.id),
					h("span", { className: "dsr-editorsub" }, t("selfHostedSub"))
				),
				h("div", { className: "dsr-field" },
					h("span", { className: "dsr-fieldlabel" },
						t("endpoint"),
						props.endpoint.overridden ? h("button", { type: "button", className: "dsr-reset", disabled: props.disabled, onClick: () => {
							props.actions.resetField(`${props.id}BaseUrl`).then(() => {
								setText(props.actions.endpointUrl(props.id));
							});
						} }, t("reset")) : null
					),
					h("input", {
						className: "dsr-input", type: "text", value: text, disabled: props.disabled, placeholder: t("endpointPlaceholder"),
						onChange: (event) => {
							setText(event.target.value);
						}
					})
				),
				h("div", { className: "dsr-editoractions" },
					h("button", { type: "button", className: "dsr-btn dsr-btn-confirm", disabled: props.disabled || !changed, onClick: () => {
						props.actions.writeEndpoint(props.id, trimmed).then(() => {
							setText(props.actions.endpointUrl(props.id));
						});
					} }, t("apply"))
				)
			);
		}

		/** The advanced fold: per-provider timeout and empty-results policy. */
		function AdvancedFold(props) {
			const { t, state } = props;
			const [draft, setDraft] = useState(void 0);
			const effective = draft ?? String(state.timeoutMs.value ?? "");
			const parsed = Number(effective.trim());
			const invalid = effective.trim() !== "" && (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 100);
			const commit = () => {
				if (invalid || draft === void 0) return;
				props.actions.writeTimeout(parsed);
				setDraft(void 0);
			};
			return h("details", { className: "dsr-adv" },
				h("summary", { className: "dsr-advsummary" }, t("advanced")),
				h("div", { className: "dsr-advbody" },
					h("div", { className: "dsr-field" },
						h("span", { className: "dsr-fieldlabel" },
							t("timeoutMs"),
							state.timeoutMs.overridden ? h("button", { type: "button", className: "dsr-reset", disabled: props.disabled, onClick: () => {
								props.actions.resetField("timeoutMs");
								setDraft(void 0);
							} }, t("reset")) : null
						),
						h("input", {
							className: "dsr-input", type: "text", inputMode: "numeric", value: effective, disabled: props.disabled,
							onChange: (event) => {
								setDraft(event.target.value);
							},
							onBlur: commit,
							onKeyDown: (event) => {
								if (event.key === "Enter") commit();
							}
						}),
						invalid ? h("p", { className: "dsr-fieldhint", role: "alert" }, t("invalidNumber")) : null
					),
					h("div", { className: "dsr-field dsr-fieldInline" },
						h("span", { className: "dsr-check" },
							h("input", {
								id: "dsr-empty-fallback", type: "checkbox", checked: state.emptyFallback.value, disabled: props.disabled,
								onChange: (event) => {
									props.actions.writeEmptyFallback(event.target.checked);
								}
							})
						),
						h("span", { className: "dsr-fieldlabel" },
							t("emptyResultsFallback"),
							state.emptyFallback.overridden ? h("button", { type: "button", className: "dsr-reset", disabled: props.disabled, onClick: () => {
								props.actions.resetField("emptyResultsFallback");
							} }, t("reset")) : null
						)
					)
				)
			);
		}

		//#endregion
		//#region locale

		/** English copy. */
		const en = {
			title: "Search router",
			description: "Routes the web_search tool to your choice of search providers, with fallback.",
			expand: "Show settings",
			collapse: "Hide settings",
			readOnly: "This deployment stores settings read-only.",
			autoBanner: "Automatic order — the first configured provider is used.",
			explicitBanner: "Drag rows to change fallback priority.",
			resetToAuto: "Reset to automatic",
			emptyChain: "No provider configured — add one below.",
			primaryTag: "Primary",
			edit: "Edit",
			remove: "Remove",
			dragHandle: "Reorder {name} (drag, or focus and use arrow keys)",
			dropToEnd: "Drop to move to the end",
			addProvider: "Add provider",
			add: "Add",
			addPick: "Select a provider…",
			cancel: "Cancel",
			apply: "Apply",
			apiKey: "API key",
			keyEnter: "Enter an API key",
			keyKeep: "A key is already set — leave blank to keep it",
			storedKey: "Using the key stored in settings",
			presetKey: "Using the key set in the profile config",
			envKey: "Using {ref} from the environment",
			noKey: "No key set",
			clearKey: "Reset key override",
			configured: "Configured",
			notConfigured: "Not configured",
			selfHostedSub: "Self-hosted — no API key",
			endpoint: "Endpoint",
			keyless: "Keyless",
			endpointPlaceholder: "https://search.example.com",
			advanced: "Advanced",
			reset: "Reset",
			timeoutMs: "Timeout per provider (ms)",
			invalidNumber: "Enter a whole number ≥ 100.",
			emptyResultsFallback: "Fall back on empty results",
			saved: "Saved.",
			writeFailed: "The deployment did not accept this change."
		};

		/** Simplified Chinese copy. */
		const zh = {
			title: "搜索路由",
			description: "将 web_search 工具路由到你选择的搜索提供方，并支持故障切换。",
			expand: "展开设置",
			collapse: "收起设置",
			readOnly: "本部署的设置为只读。",
			autoBanner: "自动顺序：使用首个已配置的提供方。",
			explicitBanner: "拖动卡片调整故障切换优先级。",
			resetToAuto: "恢复自动",
			emptyChain: "尚未配置提供方，在下方添加。",
			primaryTag: "首选",
			edit: "编辑",
			remove: "移除",
			dragHandle: "拖动调整 {name} 的顺序（或聚焦后用方向键）",
			dropToEnd: "拖到此处移到末尾",
			addProvider: "添加提供方",
			add: "添加",
			addPick: "选择提供方…",
			cancel: "取消",
			apply: "应用",
			apiKey: "API Key",
			keyEnter: "输入 API Key",
			keyKeep: "已设置密钥，留空表示保持不变",
			storedKey: "使用设置中存储的密钥",
			presetKey: "使用配置文件中设置的密钥",
			envKey: "使用环境变量 {ref}",
			noKey: "未设置密钥",
			clearKey: "重置密钥覆盖",
			configured: "已配置",
			notConfigured: "未配置",
			selfHostedSub: "自托管，无需 API Key",
			endpoint: "实例地址",
			keyless: "无需密钥",
			endpointPlaceholder: "https://search.example.com",
			advanced: "高级",
			reset: "重置",
			timeoutMs: "单个提供方超时（毫秒）",
			invalidNumber: "请输入不小于 100 的整数。",
			emptyResultsFallback: "空结果时切换",
			saved: "已保存。",
			writeFailed: "本部署没有接受该更改。"
		};

		//#endregion
		//#region plugin

		/** Required services (cordis fiber inject). */
		const inject = ["slots", "locale", "remote", "remote.credentials", "configForms"];

    /** Mount the third-party bundle page only while its Host Config exists. */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), "search-router: dictionary");
      const controller = new SearchRouterCardController(ctx.configForms.get(NS), ctx.configForms.describe(), ctx.remote);
      ctx.effect(() => () => controller.dispose(), "search-router: subscriptions");
      ctx.effect(() => ctx.remote.$on("credentials/reference-updated", ref => controller.refreshCredential(ref)), "search-router: credentials");
      ctx.effect(() => ctx.configForms.whileServed([NS], () => ctx.slots.inject(ITEM_SLOT, () => ctx.slots.register({
        name: ITEM_SLOT,
        key: "dsh-search-router",
        locale: LOCALE_NS,
        inject: () => controller.inject(),
      }, SearchRouterCard))), "search-router: bundle page");
    }

		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
