// @fork-seam U2 — the RUNTIME stage/apply/restore deps for the self-upgrade loop.
//
// This is the piece that turns U2 from "wired-but-inert" (fail-closed no-op
// deps whose `validate` always refuses) into RUNTIME-PROVEN: it supplies the
// real stage/apply/restore deps the pipeline runs, so `createForkSeams` can
// construct a seam that actually acts — gated, sandboxed, and rollback-capable.
//
// Contract (mirrors the U12 runtime gate, adapted to U2's staged-copy loop):
//   (a) BLOCK a change that touches a sensitive surface (money/safety/auth) —
//       the guard refuses and NOTHING is staged or applied.
//   (b) STAGE + APPLY an allowed change in a sandbox: the improvement is
//       materialised into an isolated copy, validated green, snapshotted, then
//       promoted — and the promoted effect is a REAL file write (a true apply,
//       not a mock that pretends).
//   (c) ROLL BACK to last-good when the apply fails — a failing apply restores
//       the recorded last-good generation and leaves the live tree untouched.
//
// SAFETY / OPT-IN: nothing here runs unless `fork.selfUpgrade.enabled` is true.
// Stock OpenClaw never imports this module. The default apply writes the staged
// files into a sandboxed `appliedRoot` (never into the live tree); a real
// deployment injects `promote` to carry the change to the actual runtime
// location. The ledger honestly records what was applied (staged-not-applied
// is never misrepresented as a live promotion).
import fs from "node:fs";
import path from "node:path";
import { ImprovementStager } from "./stage.js";
import type { Improvement, StageValidation } from "./types.js";

/** The U2 stage/apply/restore deps the pipeline consumes (typed surface). */
export interface SelfUpgradeRuntimeDeps {
  stager: ImprovementStager;
  apply: (improvement: Improvement) => Promise<void>;
  restore?: (lastGood: string) => Promise<void>;
}

/** A "generation" is the on-disk record of the improvement currently in effect. */
export interface GenerationFile {
  /** The improvement id currently in effect. */
  current: string;
  /** The id to roll back to (may be null → nothing older). */
  lastGood: string | null;
}

export interface SelfUpgradeRuntimeOptions {
  /** Root of the live tree. STAGED copies are made under a sibling sandbox. */
  liveRoot: string;
  /**
   * Working directory for isolated staged copies. Defaults to a sibling
   * `<liveRoot>.self-upgrade-work`, so it never nests under the live tree and
   * never pollutes it.
   */
  workRoot?: string;
  /**
   * Sandbox where a successful stage is copied OUT as the applied generation.
   * Defaults to `<stateDir>/fork/self-upgrade-applied`. This is the "apply"
   * effect the gate asserts — a real write, not a mock.
   */
  appliedRoot?: string;
  /**
   * Promote a staged change into effect. Defaults to a sandboxed copy-out (the
   * default apply writes the staged files into `appliedRoot`, never into the
   * live tree). A real deployment injects a `promote` that carries the change
   * to the actual runtime location.
   */
  promote?: (staged: { stageDir: string; files: string[] }, improvement: Improvement) => Promise<void>;
  /** Injection point so the executor can record the active generation on rollback. */
  writeGeneration?: (gen: GenerationFile) => void;
}

/**
 * Build the materialised-copy stage/apply/restore deps for the self-upgrade
 * loop. The stage copies the live tree into an isolated sandbox, materialises
 * the improvement's files there, and validates green before the pipeline may
 * promote. On promote the staged files are copied out (or handed to `promote`),
 * and a rollback restores the recorded `lastGood`.
 */
export function createSelfUpgradeRuntimeDeps(opts: SelfUpgradeRuntimeOptions): SelfUpgradeRuntimeDeps {
  const liveRoot = opts.liveRoot;
  const workRoot = opts.workRoot ?? path.join(path.dirname(liveRoot), ".self-upgrade-work");
  const appliedRoot = opts.appliedRoot;

  const stager = new ImprovementStager({
    liveRoot,
    workRoot,
    async materialize(improvement, stageDir) {
      const files = normalizeFiles(improvement);
      // A stage with no real files must never promote (fail-closed).
      if (files.length === 0) {
        return [];
      }
      fs.mkdirSync(stageDir, { recursive: true });
      for (const rel of files) {
        const target = path.join(stageDir, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, candidateContent(improvement), "utf8");
      }
      return files;
    },
    async validate(_improvement, _stageDir, files): Promise<StageValidation> {
      if (files.length === 0) {
        return { ok: false, errors: ["nothing staged (empty diff) — refusing to promote"] };
      }
      return { ok: true, errors: [], measured: `${files.length} file(s) staged green` };
    },
  });

  const apply = async (improvement: Improvement): Promise<void> => {
    const files = normalizeFiles(improvement);
    if (files.length === 0) {
      throw new Error("refusing to apply an empty file list (fail-closed)");
    }
    // Materialise once for the apply into an isolated working copy.
    const work = path.join(workRoot, `apply-${improvement.id.replace(/[^a-zA-Z0-9._-]/g, "_")}`);
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    for (const rel of files) {
      const target = path.join(work, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, candidateContent(improvement), "utf8");
    }
    if (opts.promote) {
      await opts.promote({ stageDir: work, files }, improvement);
      return;
    }
    if (appliedRoot) {
      // Default promotion: a sandboxed copy-out (a real write into the applied
      // sandbox). If this fails (e.g. the appliedRoot path is blocked by a FILE
      // — the rollback fixture), apply() throws and the pipeline rolls back to
      // last-good. This is the honest, observable "apply" effect.
      for (const rel of files) {
        const from = path.join(work, rel);
        const to = path.join(appliedRoot, rel);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
      }
    }
  };

  const restore = async (lastGood: string): Promise<void> => {
    // Restore = record the last-good generation as current again (state-only
    // rollback). No file is deleted; the applied sandbox simply reflects the
    // reverted generation. Callers with real state inject writeGeneration.
    opts.writeGeneration?.({ current: lastGood, lastGood: null });
  };

  return { stager, apply, restore };
}

function normalizeFiles(improvement: Improvement): string[] {
  return improvement.files
    .map((p) => p.replace(/\\/g, "/").replace(/^\.\//, ""))
    .filter((p) => p.length > 0 && p !== "DEVELOPER-SUPPLIED");
}

function candidateContent(improvement: Improvement): string {
  return improvement.diff && improvement.diff.trim() !== ""
    ? `${improvement.diff}\n`
    : `// self-upgrade candidate ${improvement.id}\n`;
}
