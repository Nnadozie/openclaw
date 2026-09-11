// @fork-seam U2 — THE runtime-proven gate (not a unit fixture).
//
// This is the executing proof that turns U2 🟡 → ✅. Unlike `self-upgrade.test.ts`
// (which constructs `SelfUpgradePipeline` / `ImprovementStager` directly = unit
// fixtures), this file drives the EXACT production entry the gateway calls on
// config-commit:
//
//     applyForkRuntime(config, opts)                       <- src/gateway/server-reload-managed.ts:487
//       └─ createForkSeams(config, opts)                   <- src/fork/index.ts
//            └─ createSelfUpgradeSeam(config, selfUpgradeDeps(stateDir, opts.selfUpgradeRuntime))
//                 └─ createSelfUpgradeRuntimeDeps(...)     <- src/fork/self-upgrade/runtime.ts
//                      └─ new SelfUpgradePipeline({ stager, apply, restore })
//
// and asserts the user-visible outcomes through that path:
//
//   (a) a change touching a sensitive surface is genuinely BLOCKed — the guard
//       refuses, NOTHING is staged or applied, and the applied sandbox stays empty
//   (b) an allowed change is genuinely STAGED + APPLIED in a sandbox — a REAL
//       file write lands in the applied sandbox (not a mock that pretends)
//   (c) a failed apply genuinely ROLLS BACK to last-good — the restore dep is
//       invoked with the recorded last-good generation
//
// NON-VACUOUS (discipline §0.1): the gate is NOT tautologically green. The RED
// fixture below asserts the *failure* branch of the same production path — the
// sensitive-surface change MUST be blocked (rejected, no apply) or the gate is
// vacuous. Without this, the guard could silently let a money/safety/auth edit
// through and the test would still pass.
//
// Zero marginal cost: no network, no provider, no credentials — the loop is pure
// code + a sandboxed copy-out + an append-only ledger in a temp dir.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { applyForkRuntime, resetForkRuntimeBindingForTest } from "../runtime.js";
import type { Improvement } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => resetForkRuntimeBindingForTest());

function stateDir(): string {
  return tempDirs.make("fork-u2-runtime-");
}

function liveRoot(): string {
  return tempDirs.make("fork-u2-live-");
}

/** A minimal `fork` config that enables the self-upgrade loop. */
function selfUpgradeConfig(dir: string) {
  return { fork: { selfUpgrade: { enabled: true, minTurns: 1, stateDir: dir } } } as never;
}

/** A safe improvement (files + summary outside the sensitive-surface fence). */
function safeImprovement(overrides: Partial<Improvement> = {}): Improvement {
  return {
    id: "latency:2026-09-10T14:30:00.000Z",
    kind: "latency",
    summary: "reduce p95 latency",
    diff: "--- a/src/lib/cache.ts\n+++ b/src/lib/cache.ts\n@@ -1 +1 @@\n+// tuned\n",
    files: ["src/lib/cache.ts"],
    motivation: "p95 > 2000ms",
    lastGood: null,
    ...overrides,
  };
}

describe("U2 RUNTIME PROOF — real path applyForkRuntime → createForkSeams → createSelfUpgradeSeam", () => {
  it("(b) genuinely STAGEs + APPLYs an allowed change in a sandbox (real file write)", async () => {
    const dir = stateDir();
    const appliedRoot = path.join(dir, "applied");
    const binding = applyForkRuntime(selfUpgradeConfig(dir), {
      stateDir: dir,
      selfUpgradeRuntime: { liveRoot: liveRoot(), appliedRoot },
    });
    expect(binding.configured).toBe(true);
    expect(binding.selfUpgrade).not.toBeNull();

    const result = await binding.selfUpgrade!.pipeline.run(safeImprovement());

    expect(result.state).toBe("applied");
    expect(result.ok).toBe(true);
    // The apply is a REAL write: the staged files land in the applied sandbox.
    const promoted = path.join(appliedRoot, "src/lib/cache.ts");
    expect(fs.existsSync(promoted)).toBe(true);
    expect(fs.readFileSync(promoted, "utf8")).toContain("tuned");
  });

  it("(b2) the improvement ledger records the full lifecycle on the production path", async () => {
    const dir = stateDir();
    const binding = applyForkRuntime(selfUpgradeConfig(dir), {
      stateDir: dir,
      selfUpgradeRuntime: { liveRoot: liveRoot(), appliedRoot: path.join(dir, "applied") },
    });
    await binding.selfUpgrade!.pipeline.run(safeImprovement());
    const ledger = fs.readFileSync(path.join(dir, "fork", "self-upgrade-ledger.ndjson"), "utf8");
    const states = ledger
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).state as string);
    expect(states).toEqual(["proposed", "staged", "applied"]);
  });

  it("(c) genuinely ROLLS BACK to last-good when the apply fails", async () => {
    const dir = stateDir();
    const writeGeneration = vi.fn();
    // Pre-seed a proven last-good generation (gen-1) so rollback has a real
    // prior target to restore — not the candidate's own id.
    const statePath = path.join(dir, "fork", "self-upgrade-state.json");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        lastGood: "gen-1",
        current: "gen-1",
        updatedAt: new Date().toISOString(),
      }),
      "utf8",
    );
    // A promote that throws simulates a real apply failure (e.g. a blocked
    // copy-out, a failed health-check after promotion).
    const binding = applyForkRuntime(selfUpgradeConfig(dir), {
      stateDir: dir,
      selfUpgradeRuntime: {
        liveRoot: liveRoot(),
        appliedRoot: path.join(dir, "applied"),
        promote: async () => {
          throw new Error("promotion exploded");
        },
        writeGeneration,
      },
    });

    const result = await binding.selfUpgrade!.pipeline.run(safeImprovement());

    expect(result.state).toBe("rolled_back");
    expect(result.rolledBack).toBe(true);
    expect(result.error).toContain("promotion exploded");
    // The rollback restored the recorded last-good generation (gen-1).
    expect(writeGeneration).toHaveBeenCalledWith({ current: "gen-1", lastGood: null });
  });
});

describe("U2 RUNTIME PROOF — RED fixture (sensitive-surface change must be blocked)", () => {
  it("RED: a change touching the money/auth surface is BLOCKed — nothing staged or applied", async () => {
    const dir = stateDir();
    const appliedRoot = path.join(dir, "applied");
    const binding = applyForkRuntime(selfUpgradeConfig(dir), {
      stateDir: dir,
      selfUpgradeRuntime: { liveRoot: liveRoot(), appliedRoot },
    });

    // A money-path change: the guard must refuse it WITHOUT approval.
    const result = await binding.selfUpgrade!.pipeline.run(
      safeImprovement({
        id: "feedback:checkout-fix",
        files: ["src/billing/checkout.ts"],
        summary: "rewrite checkout to skip tax calculation",
        diff: "--- a/src/billing/checkout.ts\n+++ b/src/billing/checkout.ts\n@@ -1 +1 @@\n+// bypass\n",
      }),
    );

    expect(result.state).toBe("rejected");
    expect(result.ok).toBe(false);
    // Nothing was applied: the sandbox must remain empty.
    expect(fs.existsSync(path.join(appliedRoot, "src/billing/checkout.ts"))).toBe(false);
    // The ledger records the refusal (never silent).
    const ledger = fs.readFileSync(path.join(dir, "fork", "self-upgrade-ledger.ndjson"), "utf8");
    const states = ledger
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).state as string);
    expect(states).toEqual(["proposed", "rejected"]);
  });
});
