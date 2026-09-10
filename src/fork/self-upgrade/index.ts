// @fork-seam U2 — production wiring for the self-upgrading loop.
//
// Built from the additive `fork.selfUpgrade{}` config block; when absent nothing
// is constructed and stock behaviour is untouched (opt-in, additive, fail-closed).
// The loop is scheduled by the caller (cron / heartbeat task) — this module only
// constructs the seam that runs ONE pass: review → propose → stage → apply/rollback.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { SelfUpgradePipeline } from "./pipeline.js";
import { SelfReviewer } from "./review.js";
import { ImprovementStager } from "./stage.js";
import type { Improvement, SelfUpgradeResult } from "./types.js";

/** Minimal shape of the additive `fork.selfUpgrade` config block. */
export interface SelfUpgradeConfig {
  /** Master switch. Off unless explicitly true (opt-in). */
  enabled?: boolean;
  /** minimum turns before the reviewer will propose (keeps the loop quiet). */
  minTurns?: number;
  /** Where the self-upgrade state + ledger live (defaults under the fork state dir). */
  stateDir?: string;
}

interface ForkConfigLike {
  selfUpgrade?: SelfUpgradeConfig;
}

function readForkBlock(config: OpenClawConfig | undefined): ForkConfigLike | undefined {
  return (config as unknown as { fork?: ForkConfigLike } | undefined)?.fork;
}

/** True when the self-upgrading loop is explicitly enabled (opt-in). */
export function isSelfUpgradeEnabled(config: OpenClawConfig | undefined): boolean {
  return readForkBlock(config)?.selfUpgrade?.enabled === true;
}

export interface SelfUpgradeSeam {
  pipeline: SelfUpgradePipeline;
  /** Re-export the reviewer so a caller can drive review→propose explicitly. */
  reviewer: SelfReviewer;
  /**
   * Run ONE self-review pass: capture nothing itself (the caller owns
   * telemetry), read the supplied summary + feedback, propose one improvement,
   * and run it through the guarded pipeline. Returns null when the reviewer
   * has nothing to change (an honest "no change", never a fabrication).
   */
  reviewOnce(input: Parameters<SelfReviewer["review"]>[0]): Promise<SelfUpgradeResult | null>;
}

/**
 * Construct the self-upgrade seam from config + injectable stage/apply deps.
 * Returns null when the block is absent or disabled — stock instances never
 * construct it.
 */
export function createSelfUpgradeSeam(
  config: OpenClawConfig | undefined,
  deps: {
    stager: ImprovementStager;
    apply: (improvement: Improvement) => Promise<void>;
    restore?: (lastGood: string) => Promise<void>;
  },
): SelfUpgradeSeam | null {
  const block = readForkBlock(config)?.selfUpgrade;
  if (!block || block.enabled !== true) {
    return null;
  }
  const stateDir = block.stateDir ?? process.env.OPENCLAW_STATE_DIR ?? ".";
  const reviewer = new SelfReviewer({ minTurns: block.minTurns });
  const pipeline = new SelfUpgradePipeline({
    stateDir,
    stager: deps.stager,
    apply: deps.apply,
    restore: deps.restore,
  });

  return {
    pipeline,
    reviewer,
    async reviewOnce(input) {
      const improvement = reviewer.review(input);
      if (!improvement) {
        return null;
      }
      return pipeline.run(improvement);
    },
  };
}

export { SelfUpgradePipeline } from "./pipeline.js";
export { SelfReviewer } from "./review.js";
export { ImprovementStager } from "./stage.js";
export { ImprovementLedger } from "./ledger.js";
export { maySelfApply, touchesSensitiveSurface } from "./guard.js";
export { TelemetryCapture } from "./telemetry.js";
export * from "./types.js";
