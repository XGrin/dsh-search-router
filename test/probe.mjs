/**
 * One-shot in-composition probe (dev artifact, not part of the plugin).
 *
 * Mounted temporarily through a --patch overlay, it runs exactly one search
 * through the booted composition's real ctx.web seam and confirms the
 * model-facing web_search tool is registered — proving the whole chain
 * (tools registry → seam → search-router → provider) inside a live
 * `dsh web` process. No state, two console lines.
 */
export const name = "search-probe";
export const inject = ["web", "tools"];

export function apply(ctx) {
  const started = Date.now();
  setTimeout(() => {
    ctx.web.search({ query: "dsh-search-router boot probe", maxResults: 3 })
      .then((result) => {
        console.log(`[search-probe] OK in ${Date.now() - started}ms: ${JSON.stringify(result)}`);
      })
      .catch((error) => {
        console.log(`[search-probe] FAILED in ${Date.now() - started}ms: ${String(error)}`);
      });
    const registered = ctx.tools.get("web_search") !== undefined;
    console.log(`[search-probe] web_search tool registered: ${registered}`);
  }, 1500);
}
