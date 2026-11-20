/**
 * dsh-search-router — browser half.
 *
 * DSH 0.2.2 renders plugin configuration through the 插件 panel: a bundle
 * declares its rows, and each row's editable form is contributed by a client
 * slot keyed `<package name>#<row id>`. A Host-only bundle therefore runs but
 * shows no configure control — this file is what makes the router's row
 * configurable in the UI.
 *
 * The owner passes `{ view, form }` (PluginConfigViewProps in
 * @deepseek-ai/dsh-client-ui-plugin-manager): `form.state` is the redacted
 * resolved config and `form.mutate(ops, revision)` writes path edits back to
 * the profile patch. Styling is built only from the `--dsw-*` theme alias
 * tokens the rest of the app uses, so the form follows light/dark themes and
 * needs no component-library import.
 */
window.__ModuleLoader__.load({
  id: "dsh-search-router",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { createElement: h, useState, useId } = React;

    /** Package name + row id, exactly as cordis.patch.yml declares the row. */
    const ROW_KEY = "dsh-search-router#search-router";
    const LOCALE_NS = "searchRouter.panel";

    /** The search backends this router ships, in canonical order. */
    const PROVIDERS = ["exa", "tavily", "brave", "perplexity", "deepseek", "searxng", "duckduckgo"];

    const zh = {
      description: "把 DSH 的 web_search 路由到你配置的提供方链，失败时依次回退。",
      chain: "提供方回退链",
      chainHint: "按从上到下的顺序尝试，前一个失败自动回退到下一个。",
      addProvider: "添加提供方",
      remove: "移除",
      moveUp: "上移",
      moveDown: "下移",
      autoTitle: "自动探测",
      autoBody: "未指定回退链时，按环境中可用的凭据自动选择提供方。",
      advanced: "高级",
      timeout: "单次搜索超时",
      timeoutHint: "每个提供方最多等待的时间。",
      emptyFallback: "空结果时继续尝试下一个",
      emptyFallbackHint: "关闭后，第一个返回空结果即视为最终结果。",
      save: "保存",
      saving: "保存中…",
      saved: "已保存，下次搜索生效",
      failed: "保存失败：",
      hint: "密钥保存在本机凭据库中，不会出现在配置文件里，也不会回传到浏览器。留空则回落到环境变量或 providers.<id>.apiKeyEnv。",
      ms: "毫秒",
      summaryAuto: "自动探测",
      keyPlaceholder: "粘贴 API Key 后回车",
      keySet: "已保存密钥（留空则不修改）",
      keyClear: "清除",
    };
    const en = {
      description: "Routes DSH's web_search through your provider chain, falling back in order.",
      chain: "Provider fallback chain",
      chainHint: "Tried top to bottom; a failing provider falls through to the next.",
      addProvider: "Add provider",
      remove: "Remove",
      moveUp: "Move up",
      moveDown: "Move down",
      autoTitle: "Auto-detect",
      autoBody: "With no chain set, providers are chosen from the credentials available in the environment.",
      advanced: "Advanced",
      timeout: "Search timeout",
      timeoutHint: "Longest each provider may take.",
      emptyFallback: "Try the next provider on empty results",
      emptyFallbackHint: "When off, an empty result ends the search.",
      save: "Save",
      saving: "Saving…",
      saved: "Saved; applies to the next search",
      failed: "Save failed: ",
      hint: "Keys are stored in the local secret store: never in the config file, never sent back to the browser. Left blank, the provider falls back to the environment or providers.<id>.apiKeyEnv.",
      ms: "ms",
      summaryAuto: "Auto-detect",
      keyPlaceholder: "Paste an API key and press Enter",
      keySet: "Key saved (leave blank to keep)",
      keyClear: "Clear",
    };

    /** Class prefix; injected once per page. */
    const P = "dsr";

    /**
     * The stylesheet, built from the same `--dsw-*` alias tokens the app's own
     * settings pages use, so the form inherits theme and dark mode.
     */
    const CSS = `
.${P}_root{display:flex;flex-direction:column;gap:20px;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:20px;max-width:760px}
.${P}_lead{margin:0;color:var(--dsw-alias-label-secondary)}
.${P}_section{display:flex;flex-direction:column;gap:8px}
.${P}_sectionHead{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.${P}_sectionTitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0}
.${P}_sectionHint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px}
.${P}_list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.${P}_row{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}
.${P}_rowHead{display:flex;align-items:center;gap:10px}
.${P}_rowBody{display:flex;align-items:center;gap:8px;padding-left:30px}
.${P}_keyInput{flex:1;min-width:0;padding:4px 8px;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
.${P}_keyInput:focus{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.${P}_keyClear{flex:none;padding:3px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;cursor:pointer}
.${P}_keyClear:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.${P}_index{flex:none;width:20px;height:20px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-size:11px;display:flex;align-items:center;justify-content:center}
.${P}_name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code);font-size:12px}
.${P}_actions{display:flex;gap:2px;flex:none}
.${P}_iconBtn{width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:13px;line-height:1}
.${P}_iconBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.${P}_iconBtn:disabled{opacity:.4;cursor:default}
.${P}_empty{margin:0;padding:14px 12px;border:1px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-1)}
.${P}_emptyTitle{display:block;font-weight:600;color:var(--dsw-alias-label-secondary);margin-bottom:2px}
.${P}_add{position:relative;align-self:flex-start;display:inline-flex;align-items:center;gap:8px;padding:5px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}
.${P}_add:hover{background:var(--dsw-alias-interactive-bg-hover)}
.${P}_add:has(.${P}_addSelect:disabled){opacity:.5;cursor:default}
.${P}_addLabel{pointer-events:none;white-space:nowrap}
.${P}_addCaret{pointer-events:none;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:1}
.${P}_addSelect{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;font:inherit}
.${P}_addSelect:disabled{cursor:default}
.${P}_field{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 0;border-top:.5px solid var(--dsw-alias-border-l2)}
.${P}_fieldText{display:flex;flex-direction:column;gap:1px;min-width:0}
.${P}_fieldTitle{color:var(--dsw-alias-label-primary)}
.${P}_fieldHint{color:var(--dsw-alias-label-tertiary);font-size:12px}
.${P}_input{width:110px;padding:4px 8px;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;text-align:right}
.${P}_input:focus{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.${P}_switch{position:relative;flex:none;width:36px;height:20px;border:0;border-radius:999px;background:var(--dsw-alias-border-l3);cursor:pointer;transition:background .15s}
.${P}_switch[data-on="true"]{background:var(--dsw-alias-state-business-primary)}
.${P}_switch:disabled{opacity:.5;cursor:default}
.${P}_knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .15s}
.${P}_switch[data-on="true"] .${P}_knob{transform:translateX(16px)}
.${P}_footer{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.${P}_save{padding:5px 14px;border:0;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground);font:inherit;font-size:12px;cursor:pointer}
.${P}_save:disabled{opacity:.5;cursor:default}
.${P}_notice{font-size:12px;color:var(--dsw-alias-label-secondary)}
.${P}_notice[data-error="true"]{color:var(--dsw-alias-state-error-primary)}
.${P}_notice[data-ok="true"]{color:var(--dsw-alias-state-success-primary)}
.${P}_hintLine{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px}
`;

    /** Inject the stylesheet once per document. */
    function ensureStyles() {
      if (typeof document === "undefined") return;
      const tag = `style[data-plugin-css="${P}"]`;
      if (document.querySelector(tag) !== null) return;
      const el = document.createElement("style");
      el.dataset.plugin = "dsh-search-router";
      el.dataset.pluginCss = P;
      el.textContent = CSS;
      document.head.appendChild(el);
    }

    /**
     * Build the row's configuration page.
     *
     * @param {object} ctx - client plugin context.
     * @returns {Function} the component registered into `plugins.row.config`.
     */
    function createForm(ctx) {
      return function SearchRouterConfig({ view, form }) {
        const t = ctx.locale.bind(LOCALE_NS);
        const ids = { add: useId() };
        ensureStyles();

        const value = form?.state?.value ?? {};
        const order = Array.isArray(value.order) ? value.order : [];
        const revision = form?.state?.revision;
        const timeout = typeof value.timeoutMs === "number" ? value.timeoutMs : 10000;
        const emptyFallback = value.emptyResultsFallback !== false;

        // The Host exposes only whether a secret slot is set, never its value.
        const secrets = form?.state?.secrets ?? form?.secrets ?? [];
        const keySet = (id) => secrets.some((secret) => {
          const path = secret?.path ?? [];
          return secret?.set === true && path.length === 3 && path[0] === "providers"
            && path[1] === id && path[2] === "apiKey";
        });

        const [busy, setBusy] = useState(false);
        const [notice, setNotice] = useState({ text: "", kind: "" });
        const [timeoutDraft, setTimeoutDraft] = useState(String(timeout));

        // A row's one-liner.
        if (view === "summary") {
          return h("span", null, order.length > 0 ? order.join(" → ") : t("summaryAuto"));
        }

        /** Write one path edit and report the outcome. */
        const commit = async (ops) => {
          if (form === undefined) return;
          setBusy(true);
          setNotice({ text: "", kind: "" });
          try {
            await form.mutate(ops, revision);
            setNotice({ text: t("saved"), kind: "ok" });
          } catch (error) {
            setNotice({ text: `${t("failed")}${error instanceof Error ? error.message : String(error)}`, kind: "error" });
          } finally {
            setBusy(false);
          }
        };

        const setOrder = (next) => commit([{ op: "set", path: ["order"], value: next }]);
        const disabled = busy || form === undefined;
        const available = PROVIDERS.filter((id) => !order.includes(id));

        return h(
          "div",
          { className: `${P}_root`, "data-search-router": ROW_KEY },
          h("p", { className: `${P}_lead` }, t("description")),

          // ---- fallback chain
          h(
            "section",
            { className: `${P}_section` },
            h(
              "div",
              { className: `${P}_sectionHead` },
              h("h4", { className: `${P}_sectionTitle` }, t("chain")),
              h("p", { className: `${P}_sectionHint` }, t("chainHint")),
            ),
            order.length === 0
              ? h(
                "p",
                { className: `${P}_empty` },
                h("span", { className: `${P}_emptyTitle` }, t("autoTitle")),
                t("autoBody"),
              )
              : h(
                "ol",
                { className: `${P}_list` },
                order.map((id, index) => h(
                  "li",
                  { key: `${id}-${index}`, className: `${P}_row` },
                  h(
                    "div",
                    { className: `${P}_rowHead` },
                    h("span", { className: `${P}_index` }, String(index + 1)),
                    h("span", { className: `${P}_name` }, id),
                    h(
                      "span",
                      { className: `${P}_actions` },
                    h("button", {
                      type: "button",
                      className: `${P}_iconBtn`,
                      title: t("moveUp"),
                      "aria-label": `${t("moveUp")} ${id}`,
                      disabled: disabled || index === 0,
                      onClick: () => {
                        const next = [...order];
                        [next[index - 1], next[index]] = [next[index], next[index - 1]];
                        setOrder(next);
                      },
                    }, "↑"),
                    h("button", {
                      type: "button",
                      className: `${P}_iconBtn`,
                      title: t("moveDown"),
                      "aria-label": `${t("moveDown")} ${id}`,
                      disabled: disabled || index === order.length - 1,
                      onClick: () => {
                        const next = [...order];
                        [next[index], next[index + 1]] = [next[index + 1], next[index]];
                        setOrder(next);
                      },
                    }, "↓"),
                    h("button", {
                      type: "button",
                      className: `${P}_iconBtn`,
                      title: t("remove"),
                      "aria-label": `${t("remove")} ${id}`,
                      disabled,
                      onClick: () => setOrder(order.filter((_, i) => i !== index)),
                    }, "✕"),
                    ),
                  ),
                  // The key field: `role('secret')` in Config, so the Host
                  // persists it in the secret store and never sends the value
                  // back — only whether it is set.
                  h(
                    "div",
                    { className: `${P}_rowBody` },
                    h("input", {
                      className: `${P}_keyInput`,
                      type: "password",
                      autoComplete: "off",
                      spellCheck: false,
                      placeholder: keySet(id) ? t("keySet") : t("keyPlaceholder"),
                      disabled,
                      onKeyDown: (event) => {
                        if (event.key === "Enter") {
                          const value = String(event.currentTarget.value ?? "").trim();
                          if (value !== "") commit([{ op: "set", path: ["providers", id, "apiKey"], value }]);
                          event.currentTarget.value = "";
                        }
                      },
                      onBlur: (event) => {
                        const value = String(event.currentTarget.value ?? "").trim();
                        if (value !== "") {
                          commit([{ op: "set", path: ["providers", id, "apiKey"], value }]);
                          event.currentTarget.value = "";
                        }
                      },
                    }),
                    keySet(id)
                      ? h("button", {
                        type: "button",
                        className: `${P}_keyClear`,
                        disabled,
                        onClick: () => commit([{ op: "unset", path: ["providers", id, "apiKey"] }]),
                      }, t("keyClear"))
                      : null,
                  ),
                )),
              ),
            available.length > 0
              ? h(
                // A native <select> stretched over the whole pill: the entire
                // control is the hit area, so a click anywhere opens the list.
                // (Wrapping a label around it only forwarded clicks on the text,
                // and the popup anchored to the select itself.)
                "div",
                { className: `${P}_add` },
                h("span", { className: `${P}_addLabel`, "aria-hidden": "true" }, `+ ${t("addProvider")}`),
                h("span", { className: `${P}_addCaret`, "aria-hidden": "true" }, "▾"),
                h(
                  "select",
                  {
                    id: ids.add,
                    className: `${P}_addSelect`,
                    "aria-label": t("addProvider"),
                    disabled,
                    value: "",
                    onChange: (event) => {
                      const picked = event.target.value;
                      if (picked !== "") setOrder([...order, picked]);
                      event.target.value = "";
                    },
                  },
                  h("option", { value: "" }, ""),
                  available.map((id) => h("option", { key: id, value: id }, id)),
                ),
              )
              : null,
          ),

          // ---- advanced
          h(
            "section",
            { className: `${P}_section` },
            h("h4", { className: `${P}_sectionTitle` }, t("advanced")),
            h(
              "div",
              { className: `${P}_field` },
              h(
                "span",
                { className: `${P}_fieldText` },
                h("span", { className: `${P}_fieldTitle` }, t("timeout")),
                h("span", { className: `${P}_fieldHint` }, t("timeoutHint")),
              ),
              h("input", {
                className: `${P}_input`,
                type: "number",
                min: 100,
                step: 1,
                value: timeoutDraft,
                disabled,
                onChange: (event) => setTimeoutDraft(event.target.value),
                onBlur: () => {
                  const next = Number(timeoutDraft);
                  if (Number.isInteger(next) && next >= 100) {
                    if (next !== timeout) commit([{ op: "set", path: ["timeoutMs"], value: next }]);
                  } else {
                    setTimeoutDraft(String(timeout));
                  }
                },
              }),
            ),
            h(
              "div",
              { className: `${P}_field` },
              h(
                "span",
                { className: `${P}_fieldText` },
                h("span", { className: `${P}_fieldTitle` }, t("emptyFallback")),
                h("span", { className: `${P}_fieldHint` }, t("emptyFallbackHint")),
              ),
              h("button", {
                type: "button",
                role: "switch",
                "aria-checked": emptyFallback ? "true" : "false",
                "aria-label": t("emptyFallback"),
                className: `${P}_switch`,
                "data-on": emptyFallback ? "true" : "false",
                disabled,
                onClick: () => commit([{ op: "set", path: ["emptyResultsFallback"], value: !emptyFallback }]),
              }, h("span", { className: `${P}_knob` })),
            ),
          ),

          h("p", { className: `${P}_hintLine` }, t("hint")),
          notice.text !== ""
            ? h("p", {
              className: `${P}_notice`,
              role: "status",
              "data-error": notice.kind === "error" ? "true" : "false",
              "data-ok": notice.kind === "ok" ? "true" : "false",
            }, notice.text)
            : null,
        );
      };
    }

    /** @param {object} ctx - client plugin context. */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), "search-router: panel dictionaries");
      const Form = createForm(ctx);
      ctx.slots.inject("plugins.row.config", () =>
        ctx.slots.register({ name: "plugins.row.config", key: ROW_KEY, locale: LOCALE_NS }, Form),
      );
    }

    exports.apply = apply;
    exports.inject = ["slots", "locale"];
    exports.ROW_KEY = ROW_KEY;
    return module.exports;
  },
});
