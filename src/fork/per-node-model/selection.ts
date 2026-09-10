import { resolveAgentConfig } from "../../agents/agent-scope.js";
import { normalizeModelSelection } from "../../agents/model-selection-shared.js";
import { resolveDefaultModelForAgent } from "../../agents/model-selection.js";
// @fork-seam U6 — the live call-site binding for per-node model selection.
//
// This module is the ONE place where the U6 seam meets the running embedded-agent
// run path. `applyRunNodeModelSelection` is invoked from the launch-time model
// resolution in `src/agents/embedded-agent-runner/run/model-setup.ts` — the same
// decision that selects provider/modelId for every turn.
//
// Opt-in and additive (ADR-F-1): with no `fork.nodes` block the seam is null and
// the caller's provider/modelId pass through byte-for-byte. An explicit per-run
// model, or a model changed by a `before_model_resolve` hook, always wins.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isSubagentSessionKey } from "../../routing/session-key.js";
import { createNodeModelSeam, ForkNodeModelService } from "./index.js";
import type { ForkNodesConfig, NodeKind, NodeModelSelection } from "./types.js";

/** Permissive read of the additive `fork.nodes` block (mirrors index.ts). */
function readForkNodes(config: OpenClawConfig | undefined): ForkNodesConfig | undefined {
  return (config as unknown as { fork?: { nodes?: ForkNodesConfig } } | undefined)?.fork?.nodes;
}

/**
 * Build the stock-derived `NodeModelSelection` the U6 resolver consumes, from the
 * SAME stock config the run already resolves against: `agents.defaults.model`,
 * the per-agent `agents.list[].model` (authoritative for the `agent` node), and
 * `agents.*.subagents.model`.
 */
export function buildNodeModelSelection(params: {
  config: OpenClawConfig | undefined;
  agentId?: string;
}): NodeModelSelection {
  const cfg = params.config ?? {};
  const agentDefault = resolveDefaultModelForAgent({ cfg, agentId: params.agentId });
  const agentPrimary = agentDefault.provider
    ? `${agentDefault.provider}/${agentDefault.model}`
    : undefined;
  const agentConfig = params.agentId ? resolveAgentConfig(cfg, params.agentId) : undefined;
  const subagentPrimary =
    normalizeModelSelection(agentConfig?.subagents?.model) ??
    normalizeModelSelection(cfg.agents?.defaults?.subagents?.model);
  return {
    ...(agentPrimary ? { agent: { primary: agentPrimary } } : {}),
    ...(subagentPrimary ? { subagent: { primary: subagentPrimary } } : {}),
  };
}

/**
 * Construct the U6 seam for a run, or null when `fork.nodes` is absent (stock).
 * Cheap by design: the stock selection is only derived when the block exists.
 */
export function createRunNodeModelSeam(params: {
  config: OpenClawConfig | undefined;
  agentId?: string;
}): ForkNodeModelService | null {
  if (!readForkNodes(params.config)) {
    return null;
  }
  return createNodeModelSeam(params.config, buildNodeModelSelection(params));
}

/**
 * Apply per-node model selection at launch. This is the production decision
 * called by the embedded-run model setup.
 *
 * Precedence: an explicit per-run model, or a hook-changed model, always wins.
 * Otherwise the override fires ONLY when `fork.nodes.defaultModel` pins a ref
 * for this node (`subagent` for subagent-shaped session keys, else `agent`);
 * with no pinned default the stock provider/modelId passes through untouched.
 * Fail-safe: any resolution error (invalid ref, alias cycle) falls back to the
 * stock model — a malformed `fork.nodes` block never breaks a run.
 */
export function applyRunNodeModelSelection(params: {
  config: OpenClawConfig | undefined;
  agentId?: string;
  sessionKey?: string;
  modelSelectionChangedByHook: boolean;
  explicitModel?: string;
  provider: string;
  modelId: string;
}): { provider: string; modelId: string; node?: NodeKind; applied: boolean } {
  if (params.modelSelectionChangedByHook || params.explicitModel) {
    return { provider: params.provider, modelId: params.modelId, applied: false };
  }
  const seam = createRunNodeModelSeam({ config: params.config, agentId: params.agentId });
  if (!seam) {
    return { provider: params.provider, modelId: params.modelId, applied: false };
  }
  try {
    const node: NodeKind = isSubagentSessionKey(params.sessionKey) ? "subagent" : "agent";
    // Only an explicitly pinned per-node default overrides the stock model.
    const pinned = seam.defaultFor(node);
    if (!pinned) {
      return { provider: params.provider, modelId: params.modelId, applied: false };
    }
    const slash = pinned.indexOf("/");
    if (slash <= 0) {
      return { provider: params.provider, modelId: params.modelId, applied: false };
    }
    return {
      provider: pinned.slice(0, slash),
      modelId: pinned.slice(slash + 1),
      node,
      applied: true,
    };
  } catch {
    // Never a silent guess: fail-safe back to the stock-resolved model.
    return { provider: params.provider, modelId: params.modelId, applied: false };
  }
}
