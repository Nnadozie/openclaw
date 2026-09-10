// @fork-seam U1 — secret redaction for the provider seam.
//
// BYOK means a customer key can flow through error strings, logs and telemetry.
// This module is the single choke point that guarantees a raw key never leaks:
// keys are matched by shape (well-known provider prefixes) AND by explicit
// value when a live key is known to the process.
//
// It is intentionally dependency-free so it can be imported from any layer.

/** Marker that replaces a redacted secret. */
export const REDACTED = "[redacted]";

/**
 * Well-known API key shapes. Conservative: only match long, high-entropy tokens
 * with a recognisable provider prefix so we never over-redact normal prose.
 */
const KEY_SHAPE_PATTERNS: readonly RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, // Anthropic
  /\bsk-[A-Za-z0-9_-]{20,}\b/g, // OpenAI + OpenAI-compatible
  /\bgsk_[A-Za-z0-9_-]{16,}\b/g, // Groq
  /\bAIza[0-9A-Za-z_-]{30,}\b/g, // Google
  /\bxai-[A-Za-z0-9_-]{16,}\b/g, // xAI
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, // GitHub fine-grained
  /\bghp_[A-Za-z0-9]{20,}\b/g, // GitHub classic
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g, // Authorization headers
];

/**
 * Redact any known-shape secret and any explicitly supplied live values from a
 * free-form string. Never throws; a non-string returns an empty string.
 */
export function redactSecrets(input: string, liveValues: readonly string[] = []): string {
  if (typeof input !== "string" || input.length === 0) {
    return typeof input === "string" ? input : "";
  }
  let out = input;
  for (const value of liveValues) {
    if (typeof value === "string" && value.length >= 8) {
      out = out.split(value).join(REDACTED);
    }
  }
  for (const pattern of KEY_SHAPE_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/**
 * Redact every string value in a nested structure (headers, bodies, error
 * payloads). Returns a new structure; the input is not mutated.
 */
export function redactDeep<T>(value: T, liveValues: readonly string[] = []): T {
  if (typeof value === "string") {
    return redactSecrets(value, liveValues) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactDeep(entry, liveValues)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v, liveValues);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * True when a string still carries something that looks like a raw API key.
 * Used by the no-key-leak test and, in production, before persisting telemetry.
 */
export function containsSecretLike(input: string): boolean {
  if (typeof input !== "string") {
    return false;
  }
  return KEY_SHAPE_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(input);
  });
}
