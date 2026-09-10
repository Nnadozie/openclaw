// @fork-seam U12 — auto-upgrade: money/auth guard (never auto-touch the critical path).
//
// Auto-upgrade is powerful, so it is fenced: any candidate that touches the
// money or auth/credential path is REQUIRED to carry an explicit approval
// before it can move past `detected`. Fail-closed: absence of approval is a
// refusal, never an implicit yes.
import type { CurrencyCandidate } from "./types.js";

/** Path fragments that mark a candidate as touching the sensitive path. */
const SENSITIVE_MARKERS: readonly RegExp[] = [
  /\b(payment|stripe|billing|invoice|checkout|charge|refund)\b/i,
  /\b(auth|oauth|token|credential|password|secret|api[\s_-]?key|session[\s_-]?key)\b/i,
  /\b(signing|private[\s_-]?key|kms|vault)\b/i,
];

/**
 * True when the candidate is (or must be treated as) touching the money/auth
 * path. An explicit `touchesMoneyOrAuth` flag always wins; otherwise we scan
 * the human-readable fields, because a mis-labelled candidate must not slip
 * through as safe.
 */
export function touchesCriticalPath(
  candidate: Pick<CurrencyCandidate, "touchesMoneyOrAuth" | "id" | "summary">,
): boolean {
  if (candidate.touchesMoneyOrAuth === true) {
    return true;
  }
  const haystack = `${candidate.id} ${candidate.summary}`;
  return SENSITIVE_MARKERS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(haystack);
  });
}

/**
 * The fence. Given a candidate and whether an explicit approval was supplied,
 * returns whether it may proceed to validate/apply.
 *
 *  - safe candidate                -> allowed
 *  - sensitive + approval present  -> allowed
 *  - sensitive + no approval       -> refused (fail-closed), with a reason
 */
export function mayAutoApply(
  candidate: CurrencyCandidate,
  opts: { approved?: boolean } = {},
): { allowed: boolean; reason: string } {
  if (!touchesCriticalPath(candidate)) {
    return { allowed: true, reason: "safe candidate; auto-apply permitted" };
  }
  if (opts.approved === true) {
    return { allowed: true, reason: "sensitive candidate; explicit approval present" };
  }
  return {
    allowed: false,
    reason: "sensitive candidate (money/auth path) requires explicit approval",
  };
}
