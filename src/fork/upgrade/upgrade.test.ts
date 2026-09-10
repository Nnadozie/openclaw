import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { compareVersions, detectVersion, isNewer } from "./detect.js";
import { mayAutoApply, touchesCriticalPath } from "./guard.js";
import { createAutoUpgradeSeam, isAutoUpgradeEnabled } from "./index.js";
import { ForkUpgradePipeline } from "./pipeline.js";
import type { CurrencyCandidate, UpgradeValidation } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function stateDir(): string {
  return tempDirs.make("fork-upgrade-");
}

const RELEASE: CurrencyCandidate = {
  kind: "upstream_release",
  id: "upstream_release:1.5.0",
  from: "1.4.0",
  to: "1.5.0",
  summary: "upstream OpenClaw 1.5.0 available",
};

const ok: UpgradeValidation = { ok: true, errors: [] };
const fail = (msg: string): UpgradeValidation => ({ ok: false, errors: [msg] });

describe("U12 detect — version detection", () => {
  it("orders dotted versions", () => {
    expect(compareVersions("1.5.0", "1.4.9")).toBeGreaterThan(0);
    expect(compareVersions("v1.4.0", "1.4.0")).toBe(0);
    expect(compareVersions("1.4.0", "1.10.0")).toBeLessThan(0);
  });

  it("treats an equal version as NOT newer", () => {
    expect(isNewer("1.4.0", "1.4.0")).toBe(false);
  });

  it("emits a candidate only when the available version is newer", () => {
    const c = detectVersion({ kind: "upstream_release", current: "1.4.0", available: "1.5.0" });
    expect(c?.to).toBe("1.5.0");
    expect(
      detectVersion({ kind: "upstream_release", current: "1.5.0", available: "1.5.0" }),
    ).toBeNull();
    expect(
      detectVersion({ kind: "upstream_release", current: "1.5.0", available: "1.4.0" }),
    ).toBeNull();
  });
});

describe("U12 guard — money/auth fence (fail-closed)", () => {
  it("never auto-applies a candidate that touches the payment path without approval", () => {
    const sensitive: CurrencyCandidate = {
      kind: "model_capability",
      id: "stripe-billing-v2",
      from: "v1",
      to: "v2",
      summary: "new payment/checkout capability",
    };
    expect(touchesCriticalPath(sensitive)).toBe(true);
    expect(mayAutoApply(sensitive).allowed).toBe(false);
    expect(mayAutoApply(sensitive, { approved: true }).allowed).toBe(true);
  });

  it("allows a safe candidate through", () => {
    expect(mayAutoApply(RELEASE).allowed).toBe(true);
  });

  it("treats an explicit flag as sensitive even when the text looks safe", () => {
    const flagged: CurrencyCandidate = {
      kind: "agent_pattern",
      id: "pattern-42",
      from: "a",
      to: "b",
      summary: "a shiny new pattern",
      touchesMoneyOrAuth: true,
    };
    expect(mayAutoApply(flagged).allowed).toBe(false);
  });
});

describe("U12 pipeline — validate before apply", () => {
  it("does NOT apply when validation fails", async () => {
    const apply = vi.fn(async () => {});
    const pipeline = new ForkUpgradePipeline({
      stateDir: stateDir(),
      validate: async () => fail("unit tests failed"),
      canary: async () => ok,
      apply,
    });
    const result = await pipeline.run(RELEASE);
    expect(result.state).toBe("rejected");
    expect(apply).not.toHaveBeenCalled();
  });

  it("does NOT promote when no canary is available", async () => {
    const apply = vi.fn(async () => {});
    const pipeline = new ForkUpgradePipeline({
      stateDir: stateDir(),
      validate: async () => ok,
      apply,
    });
    const result = await pipeline.run(RELEASE);
    expect(result.state).toBe("rejected");
    expect(apply).not.toHaveBeenCalled();
  });

  it("applies when validate + canary are green", async () => {
    const apply = vi.fn(async () => {});
    const pipeline = new ForkUpgradePipeline({
      stateDir: stateDir(),
      validate: async () => ok,
      canary: async () => ok,
      apply,
    });
    const result = await pipeline.run(RELEASE);
    expect(result.ok).toBe(true);
    expect(result.state).toBe("applied");
    expect(apply).toHaveBeenCalledOnce();
    expect(pipeline.readState().current).toBe("1.5.0");
  });
});

describe("U12 pipeline — rollback path (snapshot-before + last-good)", () => {
  it("rolls back to last-good when apply throws, and preserves the snapshot", async () => {
    const dir = stateDir();
    const restore = vi.fn(async () => {});
    const pipeline = new ForkUpgradePipeline({
      stateDir: dir,
      validate: async () => ok,
      canary: async () => ok,
      apply: async () => {
        throw new Error("promotion exploded");
      },
      restore,
    });
    // Seed state so last-good exists (a prior successful apply).
    fs.mkdirSync(path.join(dir, "fork"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "fork", "upgrade-state.json"),
      JSON.stringify({ current: "1.4.0", lastGood: null, updatedAt: new Date().toISOString() }),
    );

    const result = await pipeline.run(RELEASE);
    expect(result.rolledBack).toBe(true);
    expect(result.state).toBe("rolled_back");
    expect(restore).toHaveBeenCalledWith("1.4.0");
    expect(pipeline.readState().current).toBe("1.4.0");
  });

  it("writes an append-only ledger across the lifecycle (no deletes)", async () => {
    const dir = stateDir();
    const pipeline = new ForkUpgradePipeline({
      stateDir: dir,
      validate: async () => ok,
      canary: async () => ok,
      apply: async () => {},
    });
    await pipeline.run(RELEASE);
    const ledger = fs.readFileSync(path.join(dir, "fork", "upgrade-ledger.ndjson"), "utf8");
    const states = ledger
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).state as string);
    expect(states).toEqual(["detected", "validated", "staged", "applied"]);
  });
});

describe("U12 wiring — opt-in config block", () => {
  it("stays off unless explicitly enabled", () => {
    expect(isAutoUpgradeEnabled(undefined)).toBe(false);
    expect(isAutoUpgradeEnabled({} as never)).toBe(false);
    const seam = createAutoUpgradeSeam({} as never, {
      validate: async () => ok,
      canary: async () => ok,
      apply: async () => {},
    });
    expect(seam).toBeNull();
  });

  it("consider() runs the guarded pipeline end-to-end when enabled", async () => {
    const dir = stateDir();
    const apply = vi.fn(async () => {});
    const seam = createAutoUpgradeSeam(
      {
        fork: {
          autoUpgrade: { enabled: true, current: "1.4.0", stateDir: dir },
        },
      } as never,
      { validate: async () => ok, canary: async () => ok, apply },
    );
    expect(seam).not.toBeNull();
    const outcome = await seam!.consider({ kind: "upstream_release", available: "1.5.0" });
    expect(outcome?.state).toBe("applied");
    expect(apply).toHaveBeenCalledOnce();
    // Nothing newer → no work.
    const nothing = await seam!.consider({ kind: "upstream_release", available: "1.4.0" });
    expect(nothing).toBeNull();
  });
});
