// @fork-seam U1,U11,U12 — the fork's live runtime binding.
//
// This is the single call-site where the P1 seams meet a real running gateway.
// It is INVOKED from the gateway config-commit path (`onConfigApplied`) so the
// seams are constructed and *used* on an actual production path — not merely
// present. Stock OpenClaw never calls this module: the fork entry
// (`src/fork/index.ts`) is opt-in, and this binding is inert (returns
// `configured: false`) unless the additive `fork{}` block is present.
//
// Fail-closed: a present-but-invalid ethics policy throws at construction, and
// a consequential action with no armed guard returns ASK, never ALLOW.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { EthicsSeam } from "./ethics/index.js";
import type { DiscernmentDecision, GatedAction } from "./ethics/types.js";
import { createForkSeams } from "./index.js";
import type { ForkProviderSeam } from "./provider/types.js";

export interface ForkRuntimeBinding {
  /** True when the additive `fork{}` block is present (opt-in). */
  configured: boolean;
  /** U1 — provider seam, or null when not configured. */
  provider: ForkProviderSeam | null;
  /** U11 — ethics seam, or null when not configured. */
  ethics: EthicsSeam | null;
  /**
   * U11b — gate a consequential action through the discernment guard.
   * Fail-closed: with no armed guard the verdict is ASK (never ALLOW).
   */
  gate(action: GatedAction): Promise<DiscernmentDecision>;
}

/** True when a `fork` block is present in config (permissive check). */
export function hasForkConfig(config: OpenClawConfig | undefined): boolean {
  const fork = (config as unknown as { fork?: unknown } | undefined)?.fork;
  return Boolean(fork && typeof fork === "object");
}

/**
 * Apply an accepted config to the live fork seams. Returns what was bound.
 *
 * Called from the gateway config-commit path. When the `fork{}` block is
 * absent this is a cheap no-op (stock behaviour untouched). When present it
 * constructs U1 + U11 and returns a binding whose `gate()` is the real
 * admission check call-sites use.
 */
export function applyForkRuntime(
  config: OpenClawConfig | undefined,
  opts: { stateDir?: string } = {},
): ForkRuntimeBinding {
  if (!hasForkConfig(config)) {
    return {
      configured: false,
      provider: null,
      ethics: null,
      gate: async () => ({
        verdict: "ASK",
        reason: "fork seams not configured; fail-closed to ASK",
      }),
    };
  }
  const seams = createForkSeams(config, opts);
  const discernment = seams.discernment;
  return {
    configured: true,
    provider: seams.provider,
    ethics: seams.ethics,
    gate: async (action: GatedAction): Promise<DiscernmentDecision> => {
      if (!discernment) {
        // Fork config present but the ethics block is off: never ALLOW.
        return { verdict: "ASK", reason: "no armed discernment guard; fail-closed to ASK" };
      }
      return discernment.gate(action);
    },
  };
}

/** Process-wide binding, set by the config-commit path. */
let binding: ForkRuntimeBinding | null = null;

/** Publish the binding after an accepted config commit. */
export function setForkRuntimeBinding(next: ForkRuntimeBinding): void {
  binding = next;
}

/** The current binding, or null before any config commit. */
export function getForkRuntimeBinding(): ForkRuntimeBinding | null {
  return binding;
}

/** Test-only: reset the process-wide binding. */
export function resetForkRuntimeBindingForTest(): void {
  binding = null;
}
