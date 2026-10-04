#!/usr/bin/env node
/**
 * Check the published manifest against DSH's real version gate.
 * Version strings below are boundary inputs, not installed host versions.
 * No fixture files, network requests, or compatibility exemptions are used.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const hostModule = process.env.DSH_ROOT
  ? pathToFileURL(resolve(process.env.DSH_ROOT, "packages/boot/app-boot/src/plugin-compatibility.ts")).href
  : "@deepseek-ai/dsh-app-boot";
const { evaluatePluginCompatibility, getDshRuntimeVersion } = await import(hostModule);
assert.equal(typeof evaluatePluginCompatibility, "function", "DSH must expose its compatibility evaluator");
assert.equal(typeof manifest.peerDependencies?.["@deepseek-ai/dsh-web"], "string",
  "Keep the DSH web peer declaration; removing it would bypass the host gate");

const accepted = [
  "0.1.7-rc.2", "0.1.7", "0.1.8-rc.1",
  "0.2.0-rc.1", "0.2.0-rc.2", "0.2.0",
  "0.2.1-alpha.1", "0.2.1-beta.1", "0.2.1-rc.1", "0.2.1",
  "0.2.1-rc.1+test", "0.2.10-alpha.1", "0.2.99",
];
const rejected = [
  "0.1.1", "0.1.6", "0.1.7-rc.1",
  "0.2.0-alpha.1", "0.2.0-beta.1",
  "0.3.0-0", "0.3.0-alpha.1", "0.3.0-rc.1", "0.3.0", "1.0.0",
];
for (const version of accepted) {
  assert.equal(evaluatePluginCompatibility(manifest, {}, version), undefined,
    "Expected version gate to accept " + version);
  console.log("  accepted " + version);
}
for (const version of rejected) {
  const issue = evaluatePluginCompatibility(manifest, {}, version);
  assert.ok(issue, "Expected version gate to reject " + version);
  assert.equal(issue.exempted, false, "No compatibility exemption may bypass rejection");
  assert.ok(Object.hasOwn(issue.peers, "@deepseek-ai/dsh-web"));
  console.log("  rejected " + version);
}

const runtime = getDshRuntimeVersion();
assert.equal(evaluatePluginCompatibility(manifest), undefined,
  "The actual test host " + runtime + " must satisfy this manifest");
console.log("compatibility passed: " + (accepted.length + rejected.length) +
  " version-gate cases; actual host " + runtime +
  ". Boundary cases do not certify runtime behavior on those versions.");
