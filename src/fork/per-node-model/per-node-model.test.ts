import { describe, expect, it } from "vitest";
import { ForkNodeModelService, createNodeModelSeam } from "./index.js";
import { isPeak, peakMultiplier } from "./picker.js";
import { ModelResolutionError, type NodeModelSelection } from "./types.js";

const utc = (h: number) => Date.UTC(2026, 0, 1, h, 0, 0);

describe("U6 resolver — default per node", () => {
  it("resolves the configured per-node default", () => {
    const svc = new ForkNodeModelService({ defaultModel: { subagent: "deepseek/deepseek-v4" } });
    expect(svc.resolveModel("subagent").model).toBe("deepseek/deepseek-v4");
    expect(svc.resolveModel("subagent").source).toBe("nodeDefault");
  });

  it("falls back to the stock primary for the node when no fork default is set", () => {
    const selection: NodeModelSelection = { subagent: { primary: "openai/gpt-5" } };
    const svc = new ForkNodeModelService({}, selection);
    expect(svc.resolveModel("subagent").model).toBe("openai/gpt-5");
    expect(svc.resolveModel("subagent").source).toBe("nodePrimary");
  });

  it("box falls back to the agent primary when the box has none", () => {
    const selection: NodeModelSelection = { agent: { primary: "anthropic/claude-4" } };
    const svc = new ForkNodeModelService({}, selection);
    expect(svc.resolveModel("box").model).toBe("anthropic/claude-4");
    expect(svc.resolveModel("box").source).toBe("fallback");
  });

  it("defaultFor returns null when unset, the alias-normalised ref when set", () => {
    const svc = new ForkNodeModelService({
      defaultModel: { agent: "fast" },
      aliases: { fast: "deepseek/deepseek-v4-flash" },
    });
    expect(svc.defaultFor("agent")).toBe("deepseek/deepseek-v4-flash");
    expect(svc.defaultFor("subagent")).toBeNull();
  });
});

describe("U6 resolver — override wins", () => {
  it("an explicit override beats every default layer", () => {
    const svc = new ForkNodeModelService(
      { defaultModel: { agent: "deepseek/deepseek-v4" } },
      { agentOverride: "openai/gpt-5" },
    );
    const resolved = svc.resolveModel("agent", "anthropic/claude-4-opus");
    expect(resolved.model).toBe("anthropic/claude-4-opus");
    expect(resolved.source).toBe("override");
  });

  it("the stock per-agent override beats the fork node default (ADR-U6-1)", () => {
    const svc = new ForkNodeModelService(
      { defaultModel: { agent: "deepseek/deepseek-v4" } },
      { agentOverride: "openai/gpt-5" },
    );
    expect(svc.resolveModel("agent").source).toBe("agentOverride");
    expect(svc.resolveModel("agent").model).toBe("openai/gpt-5");
  });

  it("aliases resolve for overrides too", () => {
    const svc = new ForkNodeModelService({ aliases: { smart: "anthropic/claude-4-opus" } });
    expect(svc.resolveModel("agent", "smart").model).toBe("anthropic/claude-4-opus");
  });
});

describe("U6 resolver — unknown is an error, never a silent guess", () => {
  it("throws when nothing resolves for a node", () => {
    const svc = new ForkNodeModelService({});
    expect(() => svc.resolveModel("subagent")).toThrow(ModelResolutionError);
  });

  it("throws on an unknown alias (no silent passthrough) rather than guessing", () => {
    const svc = new ForkNodeModelService({ aliases: { known: "a/b" } });
    // An unknown alias is treated as a literal ref, which is valid only if it is
    // a well-formed provider/model string; here it is not, so it must throw.
    expect(() => svc.resolveModel("agent", "not-a-ref")).toThrow(ModelResolutionError);
  });

  it("throws on a malformed default ref", () => {
    const svc = new ForkNodeModelService({ defaultModel: { agent: "noSlashHere" } });
    expect(() => svc.resolveModel("agent")).toThrow(ModelResolutionError);
  });

  it("throws on an alias cycle", () => {
    const svc = new ForkNodeModelService({ aliases: { a: "b", b: "a" } });
    expect(() => svc.resolveModel("agent", "a")).toThrow(ModelResolutionError);
  });
});

describe("U6 picker — cost-window aware, advisory only", () => {
  const config = {
    defaultModel: { agent: "deepseek/deepseek-v4" },
    fallbacks: { agent: ["deepseek/deepseek-v4-flash"] },
    costWindows: { "deepseek/deepseek-v4": { startUtcH: 1, endUtcH: 8, multiplier: 2 } },
  };

  it("returns the primary off-peak", () => {
    const svc = new ForkNodeModelService(config);
    const pick = svc.pick("agent", { nowUtc: utc(12) });
    expect(pick.model).toBe("deepseek/deepseek-v4");
    expect(pick.advised).toBe(false);
  });

  it("advises the cheaper fallback during the peak window", () => {
    const svc = new ForkNodeModelService(config);
    const pick = svc.pick("agent", { nowUtc: utc(3) });
    expect(pick.model).toBe("deepseek/deepseek-v4-flash");
    expect(pick.advised).toBe(true);
    expect(pick.fallback).toBe("deepseek/deepseek-v4");
  });

  it("NEVER downgrades an essential turn (even at peak)", () => {
    const svc = new ForkNodeModelService(config);
    const pick = svc.pick("agent", { nowUtc: utc(3), essential: true });
    expect(pick.model).toBe("deepseek/deepseek-v4");
    expect(pick.advised).toBe(false);
  });

  it("isPeak/peakMultiplier handle a wrap-around window", () => {
    const win = { "x/y": { startUtcH: 22, endUtcH: 6, multiplier: 1.5 } };
    expect(isPeak("x/y", utc(23), win)).toBe(true);
    expect(isPeak("x/y", utc(2), win)).toBe(true);
    expect(isPeak("x/y", utc(12), win)).toBe(false);
    expect(peakMultiplier("x/y", utc(23), win)).toBe(1.5);
    expect(peakMultiplier("x/y", utc(12), win)).toBe(1);
  });
});

describe("U6 index — opt-in construction", () => {
  it("constructs nothing when fork.nodes is absent (stock)", () => {
    expect(createNodeModelSeam({} as never)).toBeNull();
  });

  it("constructs the seam when fork.nodes is present", () => {
    const config = { fork: { nodes: { defaultModel: { box: "deepseek/deepseek-v4" } } } };
    const seam = createNodeModelSeam(config as never);
    expect(seam).not.toBeNull();
    expect(seam!.resolveModel("box").model).toBe("deepseek/deepseek-v4");
  });
});
