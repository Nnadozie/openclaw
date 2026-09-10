// @fork-seam U12 — auto-upgrade: version/currency detection.
//
// Detection is pure: it compares an observed "available" version against the
// version currently in effect and, when newer, emits a CurrencyCandidate. The
// caller supplies the observed version (from a release feed / capability probe)
// so this module stays testable and side-effect-free.
import type { CurrencyCandidate, CurrencyKind } from "./types.js";

/** Compare dotted numeric versions (semver-ish, no prerelease). >0 = a newer. */
export function compareVersions(a: string, b: string): number {
  const norm = (v: string): number[] =>
    v
      .trim()
      .replace(/^v/i, "")
      .split(/[.+-]/)
      .map((p) => Number.parseInt(p, 10))
      .map((n) => (Number.isFinite(n) ? n : 0));
  const av = norm(a);
  const bv = norm(b);
  const len = Math.max(av.length, bv.length);
  for (let i = 0; i < len; i += 1) {
    const d = (av[i] ?? 0) - (bv[i] ?? 0);
    if (d !== 0) {
      return d;
    }
  }
  return 0;
}

/** True when `available` is strictly newer than `current`. Equal is not newer. */
export function isNewer(available: string, current: string): boolean {
  return compareVersions(available, current) > 0;
}

/**
 * Detect whether a newer version is available and, if so, describe the update.
 * Returns null when nothing is newer (no candidate → no work).
 */
export function detectVersion(input: {
  kind: CurrencyKind;
  current: string;
  available: string;
  summary?: string;
  touchesMoneyOrAuth?: boolean;
}): CurrencyCandidate | null {
  if (!isNewer(input.available, input.current)) {
    return null;
  }
  return {
    kind: input.kind,
    id: `${input.kind}:${input.available}`,
    from: input.current,
    to: input.available,
    summary:
      input.summary ?? `${input.kind} ${input.available} available (current ${input.current})`,
    touchesMoneyOrAuth: input.touchesMoneyOrAuth,
  };
}
