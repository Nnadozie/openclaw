// @fork-seam U6 — focused UAT for the per-node model-selection CALL-SITE.
//
// Two proofs:
//  1. Behaviour of `applyRunNodeModelSelection` (the decision the call-site runs).
//  2. REAL EXECUTION of `resolveEmbeddedRunModelSetup` — the production launch-time
//     model resolution — with its heavy collaborators mocked, asserting that a
//     `fork.nodes` block actually changes the resolved provider/modelId that the
//     run will use. This is a call-site proof, not a module-island test.
import { describe, expect, it, vi } from "vitest";

const hookSelection = { value: { provider: "openai", modelId: "gpt-5" } };
const tiered = {
  value: {
    provider: "openai",
    resolution: { model: { id: "gpt-5" }, authStorage: {}, modelRegistry: {} },
  },
};

vi.mock("../../../plugins/runtime.js", () => ({ requireActivePluginRegistry: () => ({}) }));
vi.mock("../../failover-error.js", () => ({ FailoverError: class extends Error {} }));
vi.mock("../../harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: async () => {},
}));
vi.mock("../../harness/selection.js", () => ({
  selectAgentHarness: () => ({ id: "openclaw" }),
}));
vi.mock("../../openai-routing.js", () => ({
  resolveSelectedOpenAIRuntimeProvider: ({ provider }: { provider: string }) => provider,
}));
vi.mock("../model-resolution.js", () => ({
  resolveTieredModel: async (p: { provider: string; modelId: string }) => ({
    provider: p.provider,
    resolution: {
      model: { id: p.modelId, provider: p.provider },
      authStorage: {},
      modelRegistry: {},
    },
  }),
}));
vi.mock("./setup.js", () => ({
  buildBeforeModelResolveAttachments: () => [],
  createNativeModelOwnedRuntimeModel: () => ({ id: "native" }),
  resolveHookModelSelection: async () => hookSelection.value,
  resolveNativeModelOwnedHarnessId: () => undefined,
}));

import {
  applyRunNodeModelSelection,
  buildNodeModelSelection,
} from "../../../fork/per-node-model/selection.js";
import { resolveEmbeddedRunModelSetup } from "./model-setup.js";

const FORK_SUBAGENT = {
  fork: { nodes: { defaultModel: { subagent: "deepseek/deepseek-v4-flash" } } },
} as never;

describe("U6 — applyRunNodeModelSelection (the decision the call-site runs)", () => {
  it("is inert for a stock install (no fork.nodes block)", () => {
    const out = applyRunNodeModelSelection({
      config: {} as never,
      sessionKey: "agent:main:subagent:x",
      modelSelectionChangedByHook: false,
      provider: "openai",
      modelId: "gpt-5",
    });
    expect(out).toEqual({ provider: "openai", modelId: "gpt-5", applied: false });
  });

  it("applies the per-node default for a subagent session key", () => {
    const out = applyRunNodeModelSelection({
      config: FORK_SUBAGENT,
      sessionKey: "agent:main:subagent:x",
      modelSelectionChangedByHook: false,
      provider: "openai",
      modelId: "gpt-5",
    });
    expect(out.applied).toBe(true);
    expect(out.node).toBe("subagent");
    expect(out.provider).toBe("deepseek");
    expect(out.modelId).toBe("deepseek-v4-flash");
  });

  it("treats a non-subagent session as the agent node", () => {
    const out = applyRunNodeModelSelection({
      config: { fork: { nodes: { defaultModel: { agent: "anthropic/claude-4" } } } } as never,
      sessionKey: "agent:main:main",
      modelSelectionChangedByHook: false,
      provider: "openai",
      modelId: "gpt-5",
    });
    expect(out.applied).toBe(true);
    expect(out).toMatchObject({ provider: "anthropic", modelId: "claude-4", node: "agent" });
  });

  it("never overrides an explicit per-run model or a hook-changed model", () => {
    expect(
      applyRunNodeModelSelection({
        config: FORK_SUBAGENT,
        sessionKey: "agent:main:subagent:x",
        modelSelectionChangedByHook: false,
        explicitModel: "openai/gpt-5-mini",
        provider: "openai",
        modelId: "gpt-5-mini",
      }).applied,
    ).toBe(false);
    expect(
      applyRunNodeModelSelection({
        config: FORK_SUBAGENT,
        sessionKey: "agent:main:subagent:x",
        modelSelectionChangedByHook: true,
        provider: "openai",
        modelId: "gpt-5",
      }).applied,
    ).toBe(false);
  });

  it("fails safe (stock model) when the fork block is malformed", () => {
    const out = applyRunNodeModelSelection({
      config: { fork: { nodes: { defaultModel: { subagent: "not-a-ref" } } } } as never,
      sessionKey: "agent:main:subagent:x",
      modelSelectionChangedByHook: false,
      provider: "openai",
      modelId: "gpt-5",
    });
    expect(out).toEqual({ provider: "openai", modelId: "gpt-5", applied: false });
  });

  it("derives the stock selection from agents.*.subagents.model", () => {
    const selection = buildNodeModelSelection({
      config: { agents: { defaults: { subagents: { model: "deepseek/deepseek-v4" } } } } as never,
      agentId: "main",
    });
    expect(selection.subagent).toEqual({ primary: "deepseek/deepseek-v4" });
  });
});

describe("U6 — call-site executes in the production launch path", () => {
  const baseParams = (config: unknown) => ({
    runParams: {
      config,
      agentId: "main",
      sessionKey: "agent:main:subagent:worker-1",
      sessionId: "session-1",
    } as never,
    provider: "openai",
    modelId: "gpt-5",
    agentDir: "/tmp/agent",
    workspaceDir: "/tmp/ws",
    globalLane: "global:main",
    hookRunner: {} as never,
    hookContext: {} as never,
    onHooksResolved: () => {},
  });

  it("resolves the fork per-node model through the real model-setup body", async () => {
    hookSelection.value = { provider: "openai", modelId: "gpt-5" };
    tiered.value = {
      provider: "openai",
      resolution: { model: { id: "gpt-5" }, authStorage: {}, modelRegistry: {} },
    };
    const setup = await resolveEmbeddedRunModelSetup(baseParams(FORK_SUBAGENT));
    // The call-site turned the stock openai/gpt-5 into the fork subagent default.
    expect(setup.provider).toBe("deepseek");
    expect(setup.modelId).toBe("deepseek-v4-flash");
  });

  it("passes the stock model through untouched when fork.nodes is absent", async () => {
    hookSelection.value = { provider: "openai", modelId: "gpt-5" };
    tiered.value = {
      provider: "openai",
      resolution: { model: { id: "gpt-5" }, authStorage: {}, modelRegistry: {} },
    };
    const setup = await resolveEmbeddedRunModelSetup(baseParams({}));
    expect(setup.provider).toBe("openai");
    expect(setup.modelId).toBe("gpt-5");
  });
});
