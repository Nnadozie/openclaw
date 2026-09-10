// @fork-seam U1 — BYOK resolution.
//
// Reuses the stock `<PROVIDER>_API_KEY` home (ADR-U1-2 / ADR-F-5). We resolve a
// key for a provider from the process env ONLY, and hand it back transiently.
// Nothing here writes a key to disk or to config. `redactSecrets` is the only
// way a key-derived string may leave this module.
import { redactSecrets } from "./redact.js";
import type { ByokInjection, ForkModelConfig, ProviderAuthKind } from "./types.js";

/** Env var candidates per provider, mirroring the documented `<PROVIDER>_API_KEY` home. */
const PROVIDER_KEY_ENV_VARS: Readonly<Record<string, readonly string[]>> = {
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"],
  openai: ["OPENAI_API_KEY", "CODEX_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  google: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
  xai: ["XAI_API_KEY"],
  groq: ["GROQ_API_KEY"],
  together: ["TOGETHER_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
};

/** Resolve candidate env var names for a provider id. */
export function providerKeyEnvVars(provider: string): readonly string[] {
  const explicit = PROVIDER_KEY_ENV_VARS[provider];
  if (explicit) {
    return explicit;
  }
  // Generic convention for OpenAI-compatible / self-host providers.
  return [`${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`];
}

export interface ResolvedByok {
  /** The live key, or undefined when the user has not supplied one. */
  key?: string;
  /** The env var name the key came from (safe to log). */
  source?: string;
  /** A BYOK record that carries no secret material. */
  injection: ByokInjection;
}

/** The BYOK injection for a provider (never contains the key). */
export function byokInjectionFor(provider: string): ByokInjection {
  const envVar = providerKeyEnvVars(provider)[0];
  return { provider, keyRef: `env:${envVar}`, neverLog: true, redactInTelemetry: true };
}

/**
 * Resolve the user's key for a config. `authKind: "none"` never needs a key.
 * A missing key is NOT an error here (validate/probe decide that) — this keeps
 * "no bundled creds" honest: with no key, nothing can be spent on our side.
 */
export function resolveByok(
  cfg: ForkModelConfig,
  env: Record<string, string | undefined> = process.env,
): ResolvedByok {
  const injection = byokInjectionFor(cfg.provider);
  if (cfg.authKind === "none") {
    return { injection };
  }
  for (const envVar of providerKeyEnvVars(cfg.provider)) {
    const value = env[envVar];
    if (typeof value === "string" && value.trim().length > 0) {
      return { key: value.trim(), source: envVar, injection };
    }
  }
  return { injection };
}

/** Auth kinds that require a user key. */
export function requiresUserKey(authKind: ProviderAuthKind): boolean {
  return authKind !== "none";
}

/** Redact a key from any string, for safe error/log surfaces. */
export function safeError(message: string, key?: string): string {
  return redactSecrets(message, key ? [key] : []);
}
