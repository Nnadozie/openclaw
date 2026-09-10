// @fork-seam U12 — production wiring for auto-upgrade.
//
// Built from the additive `fork.autoUpgrade{}` config block; when absent nothing
// is constructed and stock behaviour is untouched (opt-in, additive). Guarded
// by default: `allowUnattended` is required before the pipeline will promote a
// candidate without a canary, and money/auth candidates always need approval.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { detectVersion } from "./detect.js";
import { ForkUpgradePipeline } from "./pipeline.js";
import type { ApplyResult, CurrencyCandidate, UpgradeValidation } from "./types.js";

/** Minimal shape of the additive `fork.autoUpgrade` config block. */
export interface AutoUpgradeConfig {
  /** Master switch. Off unless explicitly true (opt-in). */
  enabled?: boolean;
  /** Track newer upstream OpenClaw releases. */
  track?: {
    upstream?: boolean;
    models?: boolean;
    patterns?: boolean;
  };
  /** The ref currently in effect (e.g. the installed OpenClaw version). */
  current?: string;
  /** Where the upgrade state + ledger live (defaults under the fork state dir). */
  stateDir?: string;
}

interface ForkConfigLike {
  autoUpgrade?: AutoUpgradeConfig;
}

function readForkBlock(config: OpenClawConfig | undefined): ForkConfigLike | undefined {
  return (config as unknown as { fork?: ForkConfigLike } | undefined)?.fork;
}

/** True when auto-upgrade is explicitly enabled in config (opt-in). */
export function isAutoUpgradeEnabled(config: OpenClawConfig | undefined): boolean {
  return readForkBlock(config)?.autoUpgrade?.enabled === true;
}

export interface AutoUpgradeSeam {
  pipeline: ForkUpgradePipeline;
  /**
   * Evaluate an observed "available" version against the current ref and, when
   * newer, run it through the guarded pipeline. Returns null when nothing new.
   */
  consider(observed: {
    kind: CurrencyCandidate["kind"];
    available: string;
    summary?: string;
    touchesMoneyOrAuth?: boolean;
  }): Promise<ApplyResult | null>;
}

/**
 * Construct the auto-upgrade seam from config. Returns null when the block is
 * absent or disabled — stock installs never construct it.
 */
export function createAutoUpgradeSeam(
  config: OpenClawConfig | undefined,
  deps: {
    validate: (candidate: CurrencyCandidate) => Promise<UpgradeValidation>;
    canary?: (candidate: CurrencyCandidate) => Promise<UpgradeValidation>;
    apply: (candidate: CurrencyCandidate) => Promise<void>;
  },
): AutoUpgradeSeam | null {
  const block = readForkBlock(config)?.autoUpgrade;
  if (!block || block.enabled !== true) {
    return null;
  }
  const stateDir = block.stateDir ?? process.env.OPENCLAW_STATE_DIR ?? ".";
  const current = block.current ?? "0.0.0";

  const pipeline = new ForkUpgradePipeline({
    stateDir,
    validate: deps.validate,
    canary: deps.canary,
    apply: deps.apply,
  });

  return {
    pipeline,
    async consider(observed) {
      const candidate = detectVersion({
        kind: observed.kind,
        current,
        available: observed.available,
        summary: observed.summary,
        touchesMoneyOrAuth: observed.touchesMoneyOrAuth,
      });
      if (!candidate) {
        return null;
      }
      return pipeline.run(candidate);
    },
  };
}

export { ForkUpgradePipeline } from "./pipeline.js";
export { compareVersions, detectVersion, isNewer } from "./detect.js";
export { mayAutoApply, touchesCriticalPath } from "./guard.js";
export * from "./types.js";
