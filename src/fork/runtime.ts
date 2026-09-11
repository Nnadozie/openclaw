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
import type { AutonomySeam, AutonomyTicker } from "./autonomy/index.js";
import type { EthicsSeam } from "./ethics/index.js";
import type { DiscernmentDecision, GatedAction } from "./ethics/types.js";
import { createForkSeams, type ForkSeamOptions } from "./index.js";
import type { ForkProviderSeam } from "./provider/types.js";
import type { SelfUpgradeSeam } from "./self-upgrade/index.js";

export interface ForkRuntimeBinding {
  /** True when the additive `fork{}` block is present (opt-in). */
  configured: boolean;
  /** U1 — provider seam, or null when not configured. */
  provider: ForkProviderSeam | null;
  /** U11 — ethics seam, or null when not configured. */
  ethics: EthicsSeam | null;
  /** U2 — self-upgrading loop seam, or null when the block is off. */
  selfUpgrade: SelfUpgradeSeam | null;
  /**
   * U5 — anti-silence autonomy seam, or null when `fork.autonomy` is off.
   * Its ticker is STARTED on the config-commit path (the scheduled driver).
   */
  autonomy: AutonomySeam | null;
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
  opts: ForkSeamOptions = {},
): ForkRuntimeBinding {
  if (!hasForkConfig(config)) {
    stopAutonomyTicker();
    return {
      configured: false,
      provider: null,
      ethics: null,
      selfUpgrade: null,
      autonomy: null,
      gate: async () => ({
        verdict: "ASK",
        reason: "fork seams not configured; fail-closed to ASK",
      }),
    };
  }
  const seams = createForkSeams(config, opts);
  const discernment = seams.discernment;
  // U5: drive the anti-silence loop on a scheduled tick. Starting here (the
  // gateway config-commit path) is what makes the seam runtime-proven, not
  // merely constructed. Stop any prior ticker first so repeated commits never
  // leak overlapping timers.
  stopAutonomyTicker();
  if (seams.autonomy) {
    startAutonomyTicker(seams.autonomy);
  }
  return {
    configured: true,
    provider: seams.provider,
    ethics: seams.ethics,
    selfUpgrade: seams.selfUpgrade,
    autonomy: seams.autonomy,
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

/** The currently-running U5 ticker (started on the config-commit path). */
let activeTicker: AutonomyTicker | null = null;

/** Start the U5 scheduled driver; idempotent against an already-running ticker. */
function startAutonomyTicker(seam: AutonomySeam): void {
  activeTicker = seam.ticker;
  seam.ticker.start();
}

/** Stop any running U5 ticker (no-op when none). */
function stopAutonomyTicker(): void {
  activeTicker?.stop();
  activeTicker = null;
}

/** Publish the binding after an accepted config commit. */
export function setForkRuntimeBinding(next: ForkRuntimeBinding): void {
  binding = next;
}

/** The current binding, or null before any config commit. */
export function getForkRuntimeBinding(): ForkRuntimeBinding | null {
  return binding;
}

/** Test-only: reset the process-wide binding and stop any running ticker. */
export function resetForkRuntimeBindingForTest(): void {
  stopAutonomyTicker();
  binding = null;
}
