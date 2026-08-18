/**
 * One-shot in-composition probe (dev artifact, not part of the plugin).
 *
 * Mounted temporarily through a --patch overlay, it verifies inside a live
 * `dsh web` boot: the `search-router` settings section is served for the
 * Plugins page, a search runs through the router, a settings write (the
 * exact path the GUI's save takes) re-routes the next search live, and the
 * model-facing web_search tool is registered. Prints one line per fact.
 */
export const name = "search-probe";
export const inject = ["web", "tools", "settings"];

export function apply(ctx) {
  const started = Date.now();
  const search = (query) => ctx.web.search({ query, maxResults: 3 });
  const line = (ok, label, detail) => {
    console.log(`[search-probe] ${ok ? "OK  " : "FAIL"} ${label}${detail === undefined ? "" : `: ${detail}`}`);
  };
  setTimeout(() => {
    try {
      line(ctx.tools.get("web_search") !== undefined, "web_search tool registered");
      const views = ctx.settings.describe({ redactSecrets: true });
      const view = views.find((candidate) => candidate.ns === "search-router");
      line(view !== undefined, "settings namespace served", view === undefined ? views.map((v) => v.ns).join(", ") : `applies=${view.applies} fields=${Object.keys(view.value ?? {}).length}`);
      const first = search("probe before settings write");
      const rerouted = first
        .then(() => ctx.settings.mutate("search-router", [{ op: "set", path: ["provider"], value: "searxng" }]))
        .then(() => search("probe after settings write"))
        .then(async (result) => {
          await ctx.settings.mutate("search-router", [{ op: "unset", path: ["provider"] }]);
          return result;
        });
      Promise.all([first, rerouted]).then(([before, after]) => {
        line(true, `search before write (${before.sources.length} sources via composition)`, JSON.stringify(before.sources.map((s) => s.url)));
        line(true, `search after write (${after.sources.length} sources via settings)`, JSON.stringify(after.sources.map((s) => s.url)));
        console.log(`[search-probe] done in ${Date.now() - started}ms (user settings restored)`);
      }).catch((error) => {
        console.log(`[search-probe] FAILED in ${Date.now() - started}ms: ${String(error)}`);
      });
    } catch (error) {
      console.log(`[search-probe] FAILED: ${String(error)}`);
    }
  }, 1500);
}
