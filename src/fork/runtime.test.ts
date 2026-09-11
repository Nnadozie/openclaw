// @fork-seam U1,U11,U12 — proves the seams are INVOKED on a real path.
//
// This is not a seam unit test: it exercises `applyForkRuntime` — the exact
// function the gateway config-commit path calls — and asserts that a real
// binding is constructed and that the discernment gate gates a consequential
// action. It also asserts stock installs stay inert (opt-in).
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createForkSeams } from "./index.js";
import {
  applyForkRuntime,
  getForkRuntimeBinding,
  hasForkConfig,
  resetForkRuntimeBindingForTest,
  setForkRuntimeBinding,
} from "./runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => resetForkRuntimeBindingForTest());

function stateDir(): string {
  return tempDirs.make("fork-runtime-");
}

describe("fork runtime — wired on the config-commit path", () => {
  it("is inert for a stock install (no fork block)", async () => {
    expect(hasForkConfig(undefined)).toBe(false);
    expect(hasForkConfig({} as never)).toBe(false);
    const binding = applyForkRuntime({} as never);
    expect(binding.configured).toBe(false);
    expect(binding.provider).toBeNull();
    // Fail-closed: no armed guard means ASK, never ALLOW.
    const decision = await binding.gate({ class_: "external_send", summary: "send an email" });
    expect(decision.verdict).toBe("ASK");
  });

  it("binds U1 + U11 when the fork block is present", () => {
    const binding = applyForkRuntime(
      {
        fork: {
          models: {
            models: [
              {
                provider: "deepseek",
                model: "deepseek-v4-flash",
                baseURL: "https://api.deepseek.com",
                authKind: "bearer",
                costClass: "cheap",
              },
            ],
          },
          ethics: { jesuit: { enabled: true } },
        },
      } as never,
      { stateDir: stateDir() },
    );
    expect(binding.configured).toBe(true);
    expect(binding.provider).not.toBeNull();
    expect(binding.ethics).not.toBeNull();
    // The provider seam really constructed the registry from config.
    expect(binding.provider!.list().map((m) => `${m.provider}/${m.model}`)).toContain(
      "deepseek/deepseek-v4-flash",
    );
  });

  it("gates a consequential action on the wired binding (real invocation)", async () => {
    const binding = applyForkRuntime(
      {
        fork: {
          ethics: { jesuit: { enabled: true } },
          discernment: { gateOn: ["external_send", "spend", "destructive", "irreversible"] },
        },
      } as never,
      { stateDir: stateDir() },
    );
    const blocked = await binding.gate({
      class_: "spend",
      summary: "pay the vendor but deceive the accountant about the amount",
    });
    expect(blocked.verdict).toBe("BLOCK");
  });

  it("publishes the binding for other call-sites (get after set)", () => {
    expect(getForkRuntimeBinding()).toBeNull();
    const binding = applyForkRuntime({} as never);
    setForkRuntimeBinding(binding);
    expect(getForkRuntimeBinding()).toBe(binding);
  });
});

describe("fork seams — all four live seams constructed on the config-commit path", () => {
  it("constructs the autonomy seam (U5) when fork.autonomy is enabled", () => {
    const seams = createForkSeams(
      {
        fork: {
          ethics: { jesuit: { enabled: true } },
          models: {},
          autonomy: { enabled: true, queuePath: `${stateDir()}queue.json` },
        },
      } as never,
      { stateDir: stateDir() },
    );
    expect(seams.autonomy).not.toBeNull();
    expect(seams.autonomy!.queue).toBeDefined();
    expect(seams.autonomy!.driver).toBeDefined();
    expect(seams.autonomy!.watchdog).toBeDefined();
    expect(seams.autonomy!.heartbeat).toBeDefined();
  });

  it("constructs the per-node model seam (U6) when fork.nodes is present", () => {
    const seams = createForkSeams(
      {
        fork: {
          models: {},
          nodes: { defaultModel: { agent: "deepseek/deepseek-v4-flash" } },
        },
      } as never,
      { stateDir: stateDir() },
    );
    expect(seams.nodeModel).not.toBeNull();
    expect(seams.nodeModel!.defaultFor("agent")).toBe("deepseek/deepseek-v4-flash");
  });

  it("does NOT construct the per-node model seam for a stock install", () => {
    const seams = createForkSeams({} as never, { stateDir: stateDir() });
    expect(seams.nodeModel).toBeNull();
  });

  it("constructs the auto-upgrade seam (U12) when fork.autoUpgrade is enabled", () => {
    const seams = createForkSeams(
      {
        fork: {
          models: {},
          autoUpgrade: { enabled: true, current: "1.0.0" },
        },
      } as never,
      { stateDir: stateDir() },
    );
    expect(seams.autoUpgrade).not.toBeNull();
    expect(seams.autoUpgrade!.pipeline).toBeDefined();
  });

  it("auto-upgrade is inert (no promotion) on its fail-closed no-op deps", async () => {
    const seams = createForkSeams(
      {
        fork: {
          models: {},
          autoUpgrade: { enabled: true, current: "1.0.0" },
        },
      } as never,
      { stateDir: stateDir() },
    );
    const result = await seams.autoUpgrade!.consider({
      kind: "upstream_release",
      available: "2.0.0",
      summary: "a newer upstream release",
    });
    // Fail-closed: the no-op validator refuses, so nothing ever promotes.
    expect(result?.ok ?? true).toBe(false);
  });
});
