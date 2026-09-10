// @fork-seam U2 — self-upgrading loop: isolated staged-copy validation.
//
// An improvement is NEVER applied in place. It is first materialised into an
// isolated staged copy; the validator runs against THAT copy (tests / lint /
// smoke / a measure of cost or latency). Only a green staged run may be
// promoted. The stage owns the copy lifecycle so the caller never writes into
// the live tree.
import fs from "node:fs";
import path from "node:path";
import type { Improvement, StageValidation } from "./types.js";

export interface StagingOptions {
  /** Root directory for the live tree (read-only during a stage). */
  liveRoot: string;
  /** Working directory where the isolated staged copy is created. */
  workRoot: string;
  /**
   * Materialise the candidate change into the staged copy at `stageDir`.
   * Returns the path(s) written (for the validator to run against). An
   * implementation that returns an empty list means "nothing was staged" →
   * the improvement does not apply (fail-closed).
   */
  materialize: (improvement: Improvement, stageDir: string) => Promise<string[]>;
  /**
   * Run the validation suite against the staged copy. MUST return
   * `{ ok: false }` when the staged run fails — a failing stage never promotes.
   */
  validate: (
    improvement: Improvement,
    stageDir: string,
    files: string[],
  ) => Promise<StageValidation>;
  /** Injected clock for deterministic names. */
  now?: () => Date;
}

export interface StageResult {
  ok: boolean;
  stageDir: string;
  files: string[];
  validation: StageValidation;
}

/**
 * The staging seam. Copies nothing sensitive into the stage (it is the
 * caller's `materialize` that writes the candidate files); owns the copy
 * directory creation and teardown so a failed stage never pollutes the live tree.
 */
export class ImprovementStager {
  private readonly opts: StagingOptions;

  constructor(opts: StagingOptions) {
    this.opts = opts;
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  private stagePath(id: string): string {
    const safe = id.replace(/[^a-zA-Z0-9._-]/g, "_");
    return path.join(this.opts.workRoot, `stage-${safe}-${this.now().getTime()}`);
  }

  /** Stage + validate an improvement in isolation; never touches the live tree. */
  async stage(improvement: Improvement): Promise<StageResult> {
    const stageDir = this.stagePath(improvement.id);
    fs.mkdirSync(stageDir, { recursive: true });
    let files: string[] = [];
    try {
      files = await this.opts.materialize(improvement, stageDir);
      if (files.length === 0) {
        return {
          ok: false,
          stageDir,
          files,
          validation: { ok: false, errors: ["nothing staged (empty diff) — refusing to promote"] },
        };
      }
      const validation = await this.opts.validate(improvement, stageDir, files);
      return { ok: validation.ok, stageDir, files, validation };
    } finally {
      // NO-DELETE applies to durable state; a throwaway working copy is
      // cleaned after the run so a stale stage never masquerades as applied.
      try {
        fs.rmSync(stageDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; never changes the outcome.
      }
    }
  }
}
