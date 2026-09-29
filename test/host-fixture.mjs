/** Current DSH modules and a real, isolated ConfigEditor/Settings fixture. */
import { mkdirSync, mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

export const hostImport = (name, path) => import(process.env.DSH_ROOT
  ? pathToFileURL(resolve(process.env.DSH_ROOT, path)).href : name);
export const { Context } = await hostImport("@deepseek-ai/cordis", "vendor/cordis/src/index.ts");
export const { default: WebRuntime } = await hostImport("@deepseek-ai/dsh-web", "packages/web/web/src/index.ts");

/** Keep every created test file for inspection; deletion needs a separate approval. */
export async function settingsFixture(router, config) {
  const { boot, initProfile, readProfilePatches } = await hostImport("@deepseek-ai/dsh-app-boot", "packages/boot/app-boot/src/index.ts");
  const { default: Settings } = await hostImport("@deepseek-ai/dsh-settings", "packages/settings/settings/src/index.ts");
  const { default: ConfigEditor } = await hostImport("@deepseek-ai/dsh-config-editor", "packages/boot/config-editor/src/index.ts");
  const root = resolve(process.env.DSH_ROUTER_TEST_ROOT ?? ".local/test-runs");
  mkdirSync(root, { recursive: true });
  const home = realpathSync(mkdtempSync(join(root, "settings-")));
  const dir = join(home, "profiles", "test");
  initProfile(dir, ["router-test-bundle"]);
  const bundle = join(dir, "node_modules", "router-test-bundle");
  mkdirSync(bundle, { recursive: true });
  writeFileSync(join(home, "package.json"), '{"name":"router-test-installation"}\n');
  writeFileSync(join(bundle, "package.json"), JSON.stringify({
    name: "router-test-bundle", version: "1.0.0", dsh: { bundle: { patch: "cordis.patch.yml" } },
  }));
  writeFileSync(join(bundle, "cordis.patch.yml"), JSON.stringify([{ insert: [
    { id: "config-editor", name: "cordis:editor" },
    { id: "settings", name: "cordis:settings" },
    { id: "web", name: "cordis:web", config: { searchProvider: "search-router" } },
    { id: "search-router", name: "cordis:router", config },
  ] }]));
  writeFileSync(join(dir, "cordis.yml"), "[]\n");
  const profile = {
    name: "test", startedBundles: ["router-test-bundle"], dir, patchPath: join(dir, "cordis.patch.yml"),
    installAnchor: join(home, "package.json"), cwd: home, home, overlays: [],
  };
  async function start() {
    return await boot("router-test", join(dir, "cordis.yml"), readProfilePatches("router-test", profile), ctx => {
      ctx.provide("profileContext", profile);
      ctx.provide("appReady", { onReady(listener) { listener(); return () => {}; } });
      Object.assign(ctx.loader.builtins, { editor: ConfigEditor, settings: Settings, web: WebRuntime, router });
    });
  }
  return { ctx: await start(), profile, home, start };
}
