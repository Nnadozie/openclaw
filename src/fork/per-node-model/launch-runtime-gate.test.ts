// @fork-seam U6 — EXECUTING runtime gate for the live launch path.
//
// This is NOT a module-island unit test. It drives `applyRunNodeModelSelection`
// — the exact decision function the production launch path calls at
// `src/agents/embedded-agent-runner/run/model-setup.ts:51` — with REAL
// OpenClawConfig shapes (stock `agents.*` model config + the additive
// `fork.nodes` block). It proves, by execution, the four U6 runtime contracts:
//
//   (a) a per-node default OVERRIDES the stock model at launch;
//   (b) an explicit per-run model ALWAYS wins over the per-node default;
//   (c) a malformed `fork.nodes` block FALLS BACK safely (never breaks a run);
//   (d) different nodes (agent vs subagent) resolve INDEPENDENTLY.
//
// Non-vacuity (RED fixture): the malformed-config test below would THROW
// `ModelResolutionError` if the fail-safe `try/catch` in
// `applyRunNodeModelSelection` were removed (because `defaultFor` → `normalizeAlias`
// rejects `"not-a-ref"` and alias cycles). The gate asserts the catch is live —
// a malformed block must NOT break the run, it must resolve to the stock model.
import { describe, expect, it } from "vitest";
import { applyRunNodeModelSelection, buildNodeModelSelection } from "./selection.js";

// A realistic stock install PLUS the additive fork block: stock agent model is
// openai/gpt-5, stock subagent model is openai/gpt-5-mini, and fork pins a
// DIFFERENT model per node kind.
const stockWithFork = {
  agents: {
    defaults: {
      model: "openai/gpt-5",
      subagents: { model: "openai/gpt-5-mini" },
    },
  },
  fork: {
    nodes: {
      defaultModel: {
        agent: "anthropic/claude-4",
        subagent: "deepseek/deepseek-v4-flash",
      },
    },
  },
} as never;

describe("U6 launch runtime gate — per-node default overrides stock at launch", () => {
  it("(a) swaps the stock subagent model for the pinned per-node default", () => {
    const out = applyRunNodeModelSelection({
      config: stockWithFork,
      agentId: "main",
      sessionKey: "agent:main:subagent:worker-1",
      modelSelectionChangedByHook: false,
      provider: "openai", // stock-resolved provider/modelId the run would use
      modelId: "gpt-5-mini",
    });
    expect(out.applied).toBe(true);
    expect(out.node).toBe("subagent");
    // The launch decision turned the stock openai/gpt-5-mini into the fork default.
    expect(out.provider).toBe("deepseek");
    expect(out.modelId).toBe("deepseek-v4-flash");
  });

  it("(a) swaps the stock agent model for the pinned per-node default", () => {
    const out = applyRunNodeModelSelection({
      config: stockWithFork,
      agentId: "main",
      sessionKey: "agent:main:main",
      modelSelectionChangedByHook: false,
      provider: "openai",
      modelId: "gpt-5",
    });
    expect(out.applied).toBe(true);
    expect(out.node).toBe("agent");
    expect(out.provider).toBe("anthropic");
    expect(out.modelId).toBe("claude-4");
  });
});

describe("U6 launch runtime gate — explicit per-run model always wins", () => {
  it("(b) an explicit per-run model is untouched by the per-node default", () => {
    const out = applyRunNodeModelSelection({
      config: stockWithFork,
      agentId: "main",
      sessionKey: "agent:main:subagent:worker-1",
      modelSelectionChangedByHook: false,
      explicitModel: "openai/gpt-5-mini",
      provider: "openai",
      modelId: "gpt-5-mini",
    });
    expect(out).toEqual({ provider: "openai", modelId: "gpt-5-mini", applied: false });
  });

  it("(b) a hook-changed model is untouched by the per-node default", () => {
    const out = applyRunNodeModelSelection({
      config: stockWithFork,
      agentId: "main",
      sessionKey: "agent:main:subagent:worker-1",
      modelSelectionChangedByHook: true,
      provider: "anthropic",
      modelId: "claude-4-opus",
    });
    expect(out).toEqual({ provider: "anthropic", modelId: "claude-4-opus", applied: false });
  });
});

describe("U6 launch runtime gate — malformed block falls back safely (RED fixture)", () => {
  it("(c) a malformed default ref does NOT break the run — stock model passthrough", () => {
    // Non-vacuity: `defaultFor("subagent")` → `normalizeAlias("not-a-ref")` THROWS
    // (no slash → not a valid ref). The fail-safe catch must swallow it and keep
    // the stock resolution. Remove the try/catch and this test fails (throws).
    expect(() =>
      applyRunNodeModelSelection({
        config: {
          fork: { nodes: { defaultModel: { subagent: "not-a-ref" } } },
        } as never,
        sessionKey: "agent:main:subagent:worker-1",
        modelSelectionChangedByHook: false,
        provider: "openai",
        modelId: "gpt-5",
      }),
    ).not.toThrow();
    const out = applyRunNodeModelSelection({
      config: {
        fork: { nodes: { defaultModel: { subagent: "not-a-ref" } } },
      } as never,
      sessionKey: "agent:main:subagent:worker-1",
      modelSelectionChangedByHook: false,
      provider: "openai",
      modelId: "gpt-5",
    });
    expect(out).toEqual({ provider: "openai", modelId: "gpt-5", applied: false });
  });

  it("(c) an alias cycle does NOT break the run — stock model passthrough", () => {
    const out = applyRunNodeModelSelection({
      config: {
        fork: {
          nodes: {
            defaultModel: { subagent: "cycleA" },
            aliases: { cycleA: "cycleB", cycleB: "cycleA" },
          },
        },
      } as never,
      sessionKey: "agent:main:subagent:worker-1",
      modelSelectionChangedByHook: false,
      provider: "openai",
      modelId: "gpt-5",
    });
    expect(out).toEqual({ provider: "openai", modelId: "gpt-5", applied: false });
  });

  it("a present-but-empty nodes block is inert (no default → no swap)", () => {
    const out = applyRunNodeModelSelection({
      config: { fork: { nodes: {} } } as never,
      sessionKey: "agent:main:subagent:worker-1",
      modelSelectionChangedByHook: false,
      provider: "openai",
      modelId: "gpt-5",
    });
    expect(out).toEqual({ provider: "openai", modelId: "gpt-5", applied: false });
  });
});

describe("U6 launch runtime gate — nodes resolve independently", () => {
  it("(d) agent and subagent session keys resolve to DIFFERENT defaults", () => {
    const asAgent = applyRunNodeModelSelection({
      config: stockWithFork,
      agentId: "main",
      sessionKey: "agent:main:main",
      modelSelectionChangedByHook: false,
      provider: "openai",
      modelId: "gpt-5",
    });
    const asSubagent = applyRunNodeModelSelection({
      config: stockWithFork,
      agentId: "main",
      sessionKey: "agent:main:subagent:worker-1",
      modelSelectionChangedByHook: false,
      provider: "openai",
      modelId: "gpt-5-mini",
    });
    expect(asAgent).toMatchObject({ node: "agent", provider: "anthropic", modelId: "claude-4" });
    expect(asSubagent).toMatchObject({
      node: "subagent",
      provider: "deepseek",
      modelId: "deepseek-v4-flash",
    });
    // Independence: the two nodes must NOT collapse to the same model.
    expect(`${asAgent.provider}/${asAgent.modelId}`).not.toBe(
      `${asSubagent.provider}/${asSubagent.modelId}`,
    );
  });

  it("derives the stock subagent primary from agents.defaults.subagents.model", () => {
    const selection = buildNodeModelSelection({
      config: stockWithFork,
      agentId: "main",
    });
    expect(selection.subagent).toEqual({ primary: "openai/gpt-5-mini" });
  });
});
