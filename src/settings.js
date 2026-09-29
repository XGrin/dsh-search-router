/**
 * Serializable, live plugin configuration for DSH 0.1.7-rc.2.
 * GUI edits and YAML now address the same nested Config. Secret roles let
 * DSH redact values while preserving path-level writes and presence flags.
 */
import z from "@deepseek-ai/schemastery";

/** The profile entry id used by the bundled configuration page. */
export const SETTINGS_NS = "search-router";

/**
 * Build a live root schema without changing the public YAML format.
 * Cross-field validation uses Cordis's Standard Schema entry point; the
 * serializable object schema stays readable by DSH's configuration forms.
 * @param {Record<string, object>} backends Provider descriptors.
 * @param {(raw: unknown) => object} parseConfig Router's complete validator.
 * @returns {object} Schemastery schema yielding one immutable live reference.
 */
export function createConfig(backends, parseConfig) {
  const providerId = () => z.union(Object.keys(backends).map(id => z.const(id)));
  const nonblank = () => z.string().pattern(/\S/);
  const providers = Object.fromEntries(Object.entries(backends).map(([id, backend]) => {
    const section = z.object({
      apiKey: nonblank().role("secret"),
      apiKeyEnv: nonblank().role("credential-ref"),
      baseURL: nonblank(),
      baseUrl: nonblank(),
      baseUrlEnv: nonblank(),
      ...(backend.defaultModel === undefined ? {} : { model: nonblank() }),
    }).default(undefined);
    section.meta = {
      ...section.meta,
      providerLabel: backend.meta?.label ?? id,
      providerKeyEnv: backend.defaultApiKeyEnv,
      providerBaseUrlEnv: backend.meta?.baseUrlEnv,
      providerNeedsBaseUrl: backend.defaultBaseURL === undefined && backend.meta?.keyless !== true,
    };
    return [id, section];
  }));
  const schema = z.object({
    provider: providerId(),
    order: z.array(providerId()).min(1).default(undefined),
    timeoutMs: z.number().step(1).min(100).default(10000),
    emptyResultsFallback: z.boolean().default(true),
    providers: z.object(providers),
  }).volatile();
  const standard = schema["~standard"];
  Object.defineProperty(schema, "~standard", {
    value: {
      ...standard,
      validate(raw) {
        try {
          parseConfig(raw);
          return standard.validate(raw);
        } catch (error) {
          return { issues: [{ message: error instanceof Error ? error.message : String(error) }] };
        }
      },
    },
  });
  return schema;
}
