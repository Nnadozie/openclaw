// @fork-seam U2 — self-upgrading loop: sensitive-path guard.
//
// The self-review loop may NEVER modify the money path, safety/policy files, or
// auth without human approval. This guard is the fence: any proposed improvement
// whose files touch a sensitive marker is refused (fail-closed) unless an
// explicit approval is present. Mirrors U12's `guard.ts` philosophy — a
// mis-labelled change must not slip through as safe.
import path from "node:path";
import type { Improvement } from "./types.js";

/**
 * Path fragments that mark a file as part of the walled-off surface: money,
 * safety/policy, auth/credential, and the fork's own guardrails. Changes to
 * these are NEVER auto-applied without explicit approval.
 */
const SENSITIVE_PATHS: readonly RegExp[] = [
  /\b(payment|stripe|billing|invoice|checkout|charge|refund)\b/i,
  /\b(auth|oauth|token|credential|password|secret|api[\s_-]?key|session[\s_-]?key)\b/i,
  /\b(signing|private[\s_-]?key|kms|vault)\b/i,
  /\b(safety|policy|guardrail|discernment|ethics|money)\b/i,
  // The fork turns red on edits to its own self-protection surface.
  /\bsrc\/fork\/self-upgrade\//i,
  /\bsrc\/fork\/ethics\//i,
];

/**
 * True when a proposed improvement touches the walled-off surface. An explicit
 * `touchesSensitive` flag always wins; otherwise we scan the file list AND the
 * summary (a mis-labelled change must never slip through).
 */
/**
 * Normalize a path for fence matching: unify separators and resolve `.`/`..`
 * segments, so a path that only *looks* sensitive (or only resolves into the
 * walled surface after traversal) cannot slip through either way. Without this,
 * `src/fork/self-upgrade/../dummy.ts` (which resolves OUT of the walled surface)
 * false-positives as `src/fork/self-upgrade/`, wrongly blocking a safe change.
 */
function normalizeForMatch(p: string): string {
  return path.posix.normalize(p.replace(/\\/g, "/"));
}

function matchesSensitive(fragment: string): boolean {
  return SENSITIVE_PATHS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(fragment);
  });
}

export function touchesSensitiveSurface(
  improvement: Pick<Improvement, "touchesSensitive" | "files" | "summary">,
): boolean {
  if (improvement.touchesSensitive === true) {
    return true;
  }
  if (improvement.files.map(normalizeForMatch).some(matchesSensitive)) {
    return true;
  }
  // The summary is free text (not a path) — scan it as-is so a mis-labelled
  // change that merely *mentions* a sensitive area still trips the fence.
  return matchesSensitive(improvement.summary);
}

/**
 * The fence. Returns whether the improvement may proceed past `proposed`.
 * Fail-closed: absence of approval is a refusal, never an implicit yes.
 */
export function maySelfApply(
  improvement: Improvement,
  opts: { approved?: boolean } = {},
): { allowed: boolean; reason: string } {
  if (!touchesSensitiveSurface(improvement)) {
    return { allowed: true, reason: "safe improvement; auto-apply permitted" };
  }
  if (opts.approved === true) {
    return { allowed: true, reason: "sensitive improvement; explicit approval present" };
  }
  return {
    allowed: false,
    reason: "sensitive path (money/safety/auth) requires explicit approval",
  };
}
