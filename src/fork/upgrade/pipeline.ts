// @fork-seam U12 — auto-upgrade: rollback-safe, staged apply pipeline.
//
// One pass per detected candidate:
//   detect → guard → validate (tests) → stage (canary) → apply
// with SNAPSHOT-BEFORE + ROLLBACK-TO-LAST-GOOD on any stage/apply failure.
//
// Non-negotiable: user state is never destroyed. The only files this touches
// are the fork's own state JSON + append-only ledger under the fork state dir.
// Money/auth candidates are fenced by `guard.ts` and require explicit approval.
import fs from "node:fs";
import path from "node:path";
import { mayAutoApply } from "./guard.js";
import type {
  ApplyResult,
  CurrencyCandidate,
  UpgradeRecord,
  UpgradeStateFile,
  UpgradeValidation,
} from "./types.js";

export interface UpgradePipelineOptions {
  /** Directory for the fork's upgrade state + ledger. */
  stateDir: string;
  /**
   * Validate the candidate before it is allowed to stage. MUST return
   * `{ ok: false }` when tests fail — a failing candidate never stages.
   */
  validate: (candidate: CurrencyCandidate) => Promise<UpgradeValidation>;
  /**
   * Canary: run the candidate on a small slice and report whether it is safe
   * to promote. Absent means "no canary available" → refuse to auto-apply
   * (we never promote an unproven upgrade in one shot).
   */
  canary?: (candidate: CurrencyCandidate) => Promise<UpgradeValidation>;
  /** Apply the candidate for real (writes the new ref into effect). */
  apply: (candidate: CurrencyCandidate) => Promise<void>;
  /** Restore a ref (rollback). Optional: state-only rollback when absent. */
  restore?: (ref: string) => Promise<void>;
  /** Whether an explicit approval has been granted (dangerous-path fence). */
  approved?: boolean;
  /** Clock injection for deterministic tests. */
  now?: () => Date;
  /** Structured log sink (secret-free). */
  log?: (line: string) => void;
}

/**
 * The rollback-safe upgrade orchestrator. Small on purpose: it owns the state
 * machine, the snapshot-before-write discipline, and the rollback guarantee.
 */
export class ForkUpgradePipeline {
  private readonly opts: UpgradePipelineOptions;

  constructor(opts: UpgradePipelineOptions) {
    this.opts = opts;
  }

  private stateFile(): string {
    return path.join(this.opts.stateDir, "fork", "upgrade-state.json");
  }

  private ledgerFile(): string {
    return path.join(this.opts.stateDir, "fork", "upgrade-ledger.ndjson");
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  /** Read persisted state; missing/corrupt reads as an empty (null) state. */
  readState(): UpgradeStateFile {
    try {
      const raw = fs.readFileSync(this.stateFile(), "utf8");
      const parsed = JSON.parse(raw) as Partial<UpgradeStateFile>;
      return {
        current: parsed.current ?? null,
        lastGood: parsed.lastGood ?? null,
        updatedAt: parsed.updatedAt ?? this.now().toISOString(),
      };
    } catch {
      return { current: null, lastGood: null, updatedAt: this.now().toISOString() };
    }
  }

  /** Snapshot-before: the last-good ref we can always roll back to. */
  snapshot(): string | null {
    const state = this.readState();
    return state.lastGood ?? state.current;
  }

  /** Roll back to the last-good ref. Never throws; returns what happened. */
  async rollbackToLastGood(reason: string): Promise<ApplyResult> {
    const state = this.readState();
    const target = state.lastGood;
    if (!target) {
      // Nothing proven-good yet: keep the current ref, but record the intent.
      this.record({
        at: this.now().toISOString(),
        candidate: {
          kind: "upstream_release",
          id: "rollback",
          from: state.current ?? "unknown",
          to: state.current ?? "unknown",
          summary: reason,
        },
        state: "rolled_back",
        detail: `no last-good ref; kept current (${state.current ?? "none"})`,
        lastGood: null,
      });
      return { ok: true, rolledBack: true, state: "rolled_back" };
    }
    try {
      if (this.opts.restore) {
        await this.opts.restore(target);
      }
      this.writeState({ current: target, lastGood: null, updatedAt: this.now().toISOString() });
      this.record({
        at: this.now().toISOString(),
        candidate: {
          kind: "upstream_release",
          id: "rollback",
          from: state.current ?? "unknown",
          to: target,
          summary: reason,
        },
        state: "rolled_back",
        detail: reason,
        lastGood: null,
      });
      this.log(`upgrade rollback -> ${target} (${reason})`);
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

  /**
   * Run one candidate through the pipeline. Returns the terminal state.
   *
   * Order (first failure wins; nothing is applied unless every gate passes):
   *   1. guard       — money/auth fence (fail-closed without approval)
   *   2. validate    — tests for the candidate
   *   3. canary      — staged slice; absent canary refuses promotion
   *   4. snapshot    — record last-good BEFORE any write
   *   5. apply       — promote; rollback to last-good on failure
   */
  async run(candidate: CurrencyCandidate): Promise<ApplyResult> {
    const isNew = this.isNew(candidate);
    this.record({
      at: this.now().toISOString(),
      candidate,
      state: "detected",
      lastGood: this.readState().lastGood,
    });
    if (!isNew) {
      this.record({
        at: this.now().toISOString(),
        candidate,
        state: "rejected",
        detail: "not newer than the ref in effect",
        lastGood: this.readState().lastGood,
      });
      return { ok: false, rolledBack: false, state: "rejected", error: "not newer" };
    }

    const fence = mayAutoApply(candidate, { approved: this.opts.approved });
    if (!fence.allowed) {
      this.record({
        at: this.now().toISOString(),
        candidate,
        state: "rejected",
        detail: fence.reason,
        lastGood: this.readState().lastGood,
      });
      this.log(`upgrade rejected (${candidate.id}): ${fence.reason}`);
      return { ok: false, rolledBack: false, state: "rejected", error: fence.reason };
    }

    // 2. validate (tests) — a failing candidate never stages.
    let validation: UpgradeValidation;
    try {
      validation = await this.opts.validate(candidate);
    } catch (error) {
      validation = { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
    }
    if (!validation.ok) {
      this.record({
        at: this.now().toISOString(),
        candidate,
        state: "rejected",
        detail: `validation failed: ${validation.errors.join("; ")}`,
        lastGood: this.readState().lastGood,
      });
      this.log(`upgrade rejected (${candidate.id}): validation failed`);
      return {
        ok: false,
        rolledBack: false,
        state: "rejected",
        error: `validation failed: ${validation.errors.join("; ")}`,
      };
    }
    this.record({
      at: this.now().toISOString(),
      candidate,
      state: "validated",
      detail: "tests green",
      lastGood: this.readState().lastGood,
    });

    // 3. canary (stage) — no canary means we refuse to promote unproven.
    if (!this.opts.canary) {
      this.record({
        at: this.now().toISOString(),
        candidate,
        state: "rejected",
        detail: "no canary available; refusing to promote unproven upgrade",
        lastGood: this.readState().lastGood,
      });
      return {
        ok: false,
        rolledBack: false,
        state: "rejected",
        error: "no canary available",
      };
    }
    let canary: UpgradeValidation;
    try {
      canary = await this.opts.canary(candidate);
    } catch (error) {
      canary = { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
    }
    if (!canary.ok) {
      this.record({
        at: this.now().toISOString(),
        candidate,
        state: "rejected",
        detail: `canary failed: ${canary.errors.join("; ")}`,
        lastGood: this.readState().lastGood,
      });
      this.log(`upgrade staged but canary failed (${candidate.id}); not applied`);
      return {
        ok: false,
        rolledBack: false,
        state: "rejected",
        error: `canary failed: ${canary.errors.join("; ")}`,
      };
    }
    this.record({
      at: this.now().toISOString(),
      candidate,
      state: "staged",
      detail: "canary green",
      lastGood: this.readState().lastGood,
    });

    // 4. snapshot-before — record last-good BEFORE writing anything.
    const state = this.readState();
    const lastGood = state.current ?? candidate.from;
    this.writeState({ current: state.current, lastGood, updatedAt: this.now().toISOString() });

    // 5. apply — promote; roll back to last-good on any failure.
    try {
      await this.opts.apply(candidate);
      this.writeState({ current: candidate.to, lastGood, updatedAt: this.now().toISOString() });
      this.record({
        at: this.now().toISOString(),
        candidate,
        state: "applied",
        detail: "promoted",
        lastGood,
      });
      this.log(`upgrade applied -> ${candidate.to}`);
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

  private isNew(candidate: CurrencyCandidate): boolean {
    const current = candidate.kind === "upstream_release" ? this.readState().current : undefined;
    // For non-release currencies the caller has already established novelty
    // (a capability/pattern is either offered or not); only releases are
    // monotonically versioned, so only those are re-checked here.
    if (current && candidate.kind === "upstream_release") {
      return candidate.from === current || candidate.to !== current;
    }
    return candidate.to !== candidate.from;
  }

  private writeState(state: UpgradeStateFile): void {
    const target = this.stateFile();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, target);
  }

  /** Append-only ledger: the file is only ever opened with the append flag. */
  private record(entry: UpgradeRecord): void {
    const file = this.ledgerFile();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    } catch {
      // The ledger is best-effort; a sink failure never changes the outcome.
    }
  }

  private log(line: string): void {
    try {
      this.opts.log?.(`[U12] ${line}`);
    } catch {
      // Logging must never change the outcome.
    }
  }
}
