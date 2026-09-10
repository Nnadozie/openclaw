import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { maySelfApply, touchesSensitiveSurface } from "./guard.js";
import { createSelfUpgradeSeam, isSelfUpgradeEnabled } from "./index.js";
import { ImprovementLedger } from "./ledger.js";
import { SelfUpgradePipeline } from "./pipeline.js";
import { SelfReviewer } from "./review.js";
import { ImprovementStager } from "./stage.js";
import { TelemetryCapture } from "./telemetry.js";
import type { Improvement, StageValidation, TelemetrySummary } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function stateDir(): string {
  return tempDirs.make("fork-self-upgrade-");
}

const good: StageValidation = { ok: true, errors: [] };

function stagerWith(validation: () => Promise<StageValidation>) {
  const dir = stateDir();
  return new ImprovementStager({
    liveRoot: dir, // unused by the stage step itself; present for shape.
    workRoot: path.join(dir, "work"),
    materialize: async (_improvement, stageDir) => {
      fs.writeFileSync(path.join(stageDir, "changed.txt"), "patched");
      return ["changed.txt"];
    },
    validate: async (_improvement, _stageDir, _files) => validation(),
  });
}

const IMPROVEMENT: Improvement = {
  id: "latency:2026-09-10T14:30:00.000Z",
  kind: "latency",
  summary: "reduce p95 latency",
  diff: "--- a/path b/path\n...",
  files: ["src/fork/self-upgrade/../dummy.ts"],
  motivation: "p95 > 2000ms",
  lastGood: null,
};

describe("U2 telemetry — local-first capture", () => {
  it("captures dimensions, never conversation text", () => {
    const t = new TelemetryCapture();
    t.capture({
      node: "subagent",
      latencyMs: 120,
      tokens: { in: 10, out: 20 },
      costMinor: 3,
      errorClass: null,
      tools: ["read", "edit"],
    });
    const summary = t.summarize();
    expect(summary.turns).toBe(1);
    expect(summary.latency.p50).toBe(120);
    expect(summary.cost.total).toBe(3);
    expect(summary.toolUsage.read).toBe(1);
    expect(summary.errors).toEqual({});
  });

  it("rolls errors and tool usage up into counts", () => {
    const t = new TelemetryCapture();
    t.capture({
      node: "agent",
      latencyMs: 10,
      tokens: { in: 1, out: 1 },
      costMinor: 1,
      errorClass: "timeout",
      tools: ["exec"],
    });
    t.capture({
      node: "agent",
      latencyMs: 20,
      tokens: { in: 1, out: 1 },
      costMinor: 1,
      errorClass: "timeout",
      tools: ["exec"],
    });
    t.capture({
      node: "agent",
      latencyMs: 30,
      tokens: { in: 1, out: 1 },
      costMinor: 1,
      errorClass: null,
      tools: ["exec", "read"],
    });
    const s = t.summarize();
    expect(s.errors.timeout).toBe(2);
    expect(s.toolUsage.exec).toBe(3);
    expect(s.toolUsage.read).toBe(1);
  });
});

describe("U2 review — propose ONE improvement or none", () => {
  const base: TelemetrySummary = {
    turns: 0,
    latency: { p50: 0, p95: 0 },
    cost: { total: 0, mean: 0 },
    errors: {},
    toolUsage: {},
    windowStart: "2026-09-10T00:00:00.000Z",
  };

  it("stays quiet on an empty / too-small sample", () => {
    const r = new SelfReviewer({ minTurns: 5 });
    expect(r.review({ telemetry: base })).toBeNull();
  });

  it("proposes a bug fix first when feedback has a bug", () => {
    const r = new SelfReviewer({ minTurns: 1 });
    const out = r.review({
      telemetry: { ...base, turns: 5, latency: { p50: 100, p95: 2100 } },
      feedback: [{ kind: "bug", detail: "checkout 500s", at: "x" }],
    });
    expect(out?.kind).toBe("feedback");
    expect(out?.summary).toContain("checkout 500s");
  });

  it("proposes a latency improvement when p95 clears the threshold", () => {
    const r = new SelfReviewer({ minTurns: 1 });
    const out = r.review({
      telemetry: { ...base, turns: 5, latency: { p50: 100, p95: 2100 } },
    });
    expect(out?.kind).toBe("latency");
  });
});

describe("U2 guard — sensitive-surface fence (fail-closed)", () => {
  it("refuses a change touching the money/auth path without approval", () => {
    const imp: Improvement = { ...IMPROVEMENT, files: ["src/billing/checkout.ts"] };
    expect(touchesSensitiveSurface(imp)).toBe(true);
    expect(maySelfApply(imp).allowed).toBe(false);
    expect(maySelfApply(imp, { approved: true }).allowed).toBe(true);
  });

  it("refuses an edit to the fork's own self-protection surface", () => {
    const imp: Improvement = { ...IMPROVEMENT, files: ["src/fork/self-upgrade/pipeline.ts"] };
    expect(touchesSensitiveSurface(imp)).toBe(true);
  });

  it("allows a safe change through", () => {
    expect(maySelfApply(IMPROVEMENT).allowed).toBe(true);
  });

  it("treats an explicit flag as sensitive even when text looks safe", () => {
    const imp: Improvement = { ...IMPROVEMENT, touchesSensitive: true };
    expect(maySelfApply(imp).allowed).toBe(false);
  });
});

describe("U2 pipeline — validate in isolation before apply", () => {
  it("does NOT apply when the staged run fails", async () => {
    const apply = vi.fn(async () => {});
    const pipeline = new SelfUpgradePipeline({
      stateDir: stateDir(),
      stager: stagerWith(async () => ({ ok: false, errors: ["tests failed"] })),
      apply,
    });
    const result = await pipeline.run(IMPROVEMENT);
    expect(result.state).toBe("rejected");
    expect(apply).not.toHaveBeenCalled();
  });

  it("refuses to promote an empty stage (no files materialised)", async () => {
    const dir = stateDir();
    const apply = vi.fn(async () => {});
    const stager = new ImprovementStager({
      liveRoot: dir,
      workRoot: path.join(dir, "work"),
      materialize: async () => [],
      validate: async () => good,
    });
    const pipeline = new SelfUpgradePipeline({ stateDir: dir, stager, apply });
    const result = await pipeline.run(IMPROVEMENT);
    expect(result.state).toBe("rejected");
    expect(apply).not.toHaveBeenCalled();
  });

  it("applies when the staged run is green", async () => {
    const apply = vi.fn(async () => {});
    const pipeline = new SelfUpgradePipeline({
      stateDir: stateDir(),
      stager: stagerWith(async () => good),
      apply,
    });
    const result = await pipeline.run(IMPROVEMENT);
    expect(result.ok).toBe(true);
    expect(result.state).toBe("applied");
    expect(apply).toHaveBeenCalledOnce();
  });
});

describe("U2 pipeline — rollback path (snapshot-before + last-good)", () => {
  it("rolls back to last-good when apply throws", async () => {
    const dir = stateDir();
    const restore = vi.fn(async () => {});
    const ledger = new ImprovementLedger({ stateDir: dir });
    ledger.writeState({ lastGood: "gen-1", current: "gen-1", updatedAt: new Date().toISOString() });
    const pipeline = new SelfUpgradePipeline({
      stateDir: dir,
      stager: stagerWith(async () => good),
      apply: async () => {
        throw new Error("promotion exploded");
      },
      restore,
    });
    const result = await pipeline.run(IMPROVEMENT);
    expect(result.rolledBack).toBe(true);
    expect(result.state).toBe("rolled_back");
    expect(restore).toHaveBeenCalledWith("gen-1");
  });

  it("writes an append-only ledger across the lifecycle", async () => {
    const dir = stateDir();
    const apply = vi.fn(async () => {});
    const pipeline = new SelfUpgradePipeline({
      stateDir: dir,
      stager: stagerWith(async () => good),
      apply,
    });
    await pipeline.run(IMPROVEMENT);
    const ledger = fs.readFileSync(path.join(dir, "fork", "self-upgrade-ledger.ndjson"), "utf8");
    const states = ledger
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).state as string);
    expect(states).toEqual(["proposed", "staged", "applied"]);
  });
});

describe("U2 wiring — opt-in config block", () => {
  it("stays off unless explicitly enabled", () => {
    expect(isSelfUpgradeEnabled(undefined)).toBe(false);
    expect(isSelfUpgradeEnabled({} as never)).toBe(false);
    const seam = createSelfUpgradeSeam({} as never, {
      stager: stagerWith(async () => good),
      apply: async () => {},
    });
    expect(seam).toBeNull();
  });

  it("reviewOnce() runs the guarded pipeline end-to-end when enabled", async () => {
    const dir = stateDir();
    const apply = vi.fn(async () => {});
    const seam = createSelfUpgradeSeam(
      { fork: { selfUpgrade: { enabled: true, stateDir: dir, minTurns: 1 } } } as never,
      { stager: stagerWith(async () => good), apply },
    );
    expect(seam).not.toBeNull();
    const outcome = await seam!.reviewOnce({
      telemetry: {
        turns: 5,
        latency: { p50: 100, p95: 2100 },
        cost: { total: 0, mean: 0 },
        errors: {},
        toolUsage: {},
        windowStart: "x",
      },
    });
    expect(outcome?.state).toBe("applied");
    expect(apply).toHaveBeenCalledOnce();
  });
});
