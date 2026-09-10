import { maySelfApply } from "./guard.js";
import { ImprovementLedger } from "./ledger.js";
import { ImprovementStager } from "./stage.js";
// @fork-seam U2 — self-upgrading loop: the safe, gated orchestrator.
//
// One pass per review:
//   review → propose ONE improvement → guard (money/safety/auth fence)
//   → stage (isolated copy) → validate → snapshot last-good
//   → apply (only on green stage) → ROLL BACK to last-good on failure
//   → append to the improvement ledger.
//
// "Change the mechanism, never the behavior": an improvement only ever changes
// HOW a behavior is delivered — never the semantics — and every change is
// reversible. "Never go quiet": every outcome is ledgered, so an apply, a
// rollback, or a clean "no change" is always visible, never silent.
import type {
  Improvement,
  ImprovementRecord,
  ImprovementState,
  SelfUpgradeResult,
  SelfUpgradeStateFile,
  StageValidation,
} from "./types.js";

export interface SelfUpgradePipelineOptions {
  stateDir: string;
  /** Stage + validate the improvement in an isolated copy. */
  stager: ImprovementStager;
  /** Apply the improvement for real (writes the new generation into effect). */
  apply: (improvement: Improvement) => Promise<void>;
  /** Restore a generation (rollback). Optional: state-only rollback when absent. */
  restore?: (lastGood: string) => Promise<void>;
  /** Whether an explicit approval has been granted (sensitive-path fence). */
  approved?: boolean;
  /** Injected clock for deterministic tests. */
  now?: () => Date;
  /** Structured log sink (secret-free). */
  log?: (line: string) => void;
}

/**
 * The rollback-safe self-upgrade orchestrator. Small on purpose: it owns the
 * state machine, the snapshot-before-write discipline, and the rollback
 * guarantee. It never authors code — the caller supplies the improvement, the
 * stager validates it in isolation, and apply() promotes it only on success.
 */
export class SelfUpgradePipeline {
  private readonly opts: SelfUpgradePipelineOptions;
  private readonly ledger: ImprovementLedger;

  constructor(opts: SelfUpgradePipelineOptions) {
    this.opts = opts;
    this.ledger = new ImprovementLedger({ stateDir: opts.stateDir });
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  private state(): SelfUpgradeStateFile {
    return this.ledger.readState();
  }

  private record(improvement: Improvement, state: ImprovementState, detail?: string): void {
    const entry: ImprovementRecord = {
      at: this.now().toISOString(),
      improvement,
      state,
      detail,
      lastGood: improvement.lastGood,
    };
    this.ledger.append(entry);
  }

  /**
   * Run one proposed improvement through the pipeline.
   *
   * Order (first failure wins; nothing modifies the live tree unless every
   * gate passes):
   *   1. guard     — money/safety/auth fence (fail-closed without approval)
   *   2. stage     — materialise + validate in an isolated copy (empty→refuse)
   *   3. snapshot  — record last-good BEFORE any write
   *   4. apply     — promote; roll back to last-good on failure
   */
  async run(improvement: Improvement): Promise<SelfUpgradeResult> {
    this.record(improvement, "proposed");

    // 1. guard — the money/safety/auth fence.
    const fence = maySelfApply(improvement, { approved: this.opts.approved });
    if (!fence.allowed) {
      this.record(improvement, "rejected", fence.reason);
      this.log(`self-upgrade rejected (${improvement.id}): ${fence.reason}`);
      return { ok: false, rolledBack: false, state: "rejected", error: fence.reason };
    }

    // 2. stage — isolated copy; a failing or empty stage never promotes.
    let staged: StageValidation;
    try {
      const result = await this.opts.stager.stage(improvement);
      staged = result.validation;
    } catch (error) {
      staged = {
        ok: false,
        errors: [error instanceof Error ? error.message : String(error)],
      };
    }
    if (!staged.ok) {
      this.record(improvement, "rejected", `stage failed: ${staged.errors.join("; ")}`);
      this.log(`self-upgrade rejected (${improvement.id}): stage failed`);
      return {
        ok: false,
        rolledBack: false,
        state: "rejected",
        error: `stage failed: ${staged.errors.join("; ")}`,
      };
    }
    this.record(improvement, "staged", staged.measured ?? "stage green");

    // 3. snapshot-before — record last-good BEFORE any live write.
    const prior = this.state();
    const lastGood = prior.lastGood ?? prior.current ?? improvement.id;
    this.ledger.writeState({
      lastGood,
      current: prior.current,
      updatedAt: this.now().toISOString(),
    });
    improvement.lastGood = lastGood;

    // 4. apply — promote; roll back to last-good on failure.
    try {
      await this.opts.apply(improvement);
      this.ledger.writeState({
        lastGood,
        current: improvement.id,
        updatedAt: this.now().toISOString(),
      });
      this.record(improvement, "applied", "promoted");
      this.log(`self-upgrade applied -> ${improvement.id}`);
      return { ok: true, rolledBack: false, state: "applied" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const rolled = await this.rollbackToLastGood(`apply failed: ${message}`);
      if (!rolled.ok) {
        return { ok: false, rolledBack: false, state: "rolled_back", error: rolled.error };
      }
      return {
        ok: false,
        rolledBack: true,
        state: "rolled_back",
        error: `apply failed, rolled back to ${lastGood}: ${message}`,
      };
    }
  }

  /** Roll back to the last-good generation. Never throws; reports what happened. */
  async rollbackToLastGood(reason: string): Promise<SelfUpgradeResult> {
    const state = this.state();
    const target = state.lastGood;
    if (!target) {
      this.record(
        {
          id: "rollback",
          kind: "error",
          summary: reason,
          diff: "",
          files: [],
          motivation: reason,
          lastGood: null,
        },
        "rolled_back",
        `no last-good generation; kept current (${state.current ?? "none"})`,
      );
      return { ok: true, rolledBack: true, state: "rolled_back" };
    }
    try {
      if (this.opts.restore) {
        await this.opts.restore(target);
      }
      this.ledger.writeState({
        lastGood: null,
        current: target,
        updatedAt: this.now().toISOString(),
      });
      this.record(
        {
          id: "rollback",
          kind: "error",
          summary: reason,
          diff: "",
          files: [],
          motivation: reason,
          lastGood: null,
        },
        "rolled_back",
        reason,
      );
      this.log(`self-upgrade rollback -> ${target} (${reason})`);
      return { ok: true, rolledBack: true, state: "rolled_back" };
    } catch (error) {
      return {
        ok: false,
        rolledBack: false,
        state: "rolled_back",
        error: `rollback failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private log(line: string): void {
    try {
      this.opts.log?.(`[U2] ${line}`);
    } catch {
      // Logging must never change the outcome.
    }
  }
}
