// @fork-seam U4 — hardening defaults (secret-scan · fail-closed allow · NO-DELETE · headers).
//
// A small, pure, typed seam. Stock installs that omit the `fork.hardening` block get the
// DEFAULT (on) policy; a config block can only make it stricter (never disable the guards).
// Everything here is pure — no I/O, no clock — so the runtime gate executes the real logic.

export interface SecretFinding {
  /** The kind of credential detected (for an honest message, not a value). */
  kind: string;
  /** The offending text with the secret MASKED — never the raw secret itself. */
  masked: string;
}

export interface SecretScanResult {
  clean: boolean;
  findings: SecretFinding[];
}

/** Redact a matched secret to a stable, non-reversible form. */
function mask(secret: string): string {
  const s = String(secret);
  if (s.length <= 8) return "[redacted]";
  return `${s.slice(0, 4)}…${s.slice(-2)}[redacted]`;
}

/** Known credential shapes. Conservative: a false positive is a masked finding, never a leak. */
const SECRET_PATTERNS: ReadonlyArray<{ kind: string; re: RegExp }> = [
  { kind: "openai-key", re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { kind: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { kind: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { kind: "aws-access-key", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { kind: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "bearer-token", re: /\bBearer\s+[A-Za-z0-9._-]{24,}\b/g },
];

/** The hardening response headers (a restrictive, modern default set). */
export const HARDENING_HEADERS: Readonly<Record<string, string>> = {
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'self'; object-src 'none'; base-uri 'self'",
};

/** Operations that must NEVER run (NO-DELETE). Matched case-insensitively on a word boundary. */
const DESTRUCTIVE = /\b(delete|destroy|purge|drop|truncate|rm|rmdir|wipe|unlink)\b/i;

export interface HardeningSeam {
  /** Scan text for leaked credentials; find them MASKED, never raw. */
  scanForSecrets(text: string): SecretScanResult;
  /** The hardening header set to apply to owned surfaces. */
  requiredHeaders(): Record<string, string>;
  /** Fail-closed: throw unless `action` is explicitly allow-listed. */
  assertAllowed(action: string, allow: readonly string[]): void;
  /** NO-DELETE guard: throw on any destructive op name. */
  assertNoDelete(op: string): void;
}

export interface HardeningSeamOptions {
  /** Extra allow-listed actions (a config may only ADD; it can never remove the guards). */
  allow?: readonly string[];
}

export function createHardeningSeam(_config?: unknown, opts: HardeningSeamOptions = {}): HardeningSeam {
  const allow = new Set((opts.allow ?? []).map((s) => s.trim()).filter(Boolean));
  return {
    scanForSecrets(text: string): SecretScanResult {
      const s = String(text ?? "");
      const findings: SecretFinding[] = [];
      for (const { kind, re } of SECRET_PATTERNS) {
        const matches = s.match(re);
        if (matches) {
          for (const m of matches) findings.push({ kind, masked: mask(m.replace(/^Bearer\s+/i, "")) });
        }
      }
      return { clean: findings.length === 0, findings };
    },
    requiredHeaders(): Record<string, string> {
      return { ...HARDENING_HEADERS };
    },
    assertAllowed(action: string, extraAllow: readonly string[] = []): void {
      const a = String(action ?? "").trim();
      if (!a) throw new Error("hardening: empty action refused (fail-closed)");
      if (allow.has(a) || extraAllow.map((x) => String(x).trim()).includes(a)) return;
      throw new Error(`hardening: action "${a}" is not allow-listed (fail-closed)`);
    },
    assertNoDelete(op: string): void {
      const o = String(op ?? "");
      if (DESTRUCTIVE.test(o)) {
        throw new Error(`hardening: destructive op "${o}" refused (NO-DELETE)`);
      }
    },
  };
}
