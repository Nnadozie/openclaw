// @fork-seam U6 — production wiring for per-node model selection.
//
// Built from the additive `fork.nodes` config block; when absent nothing is
// constructed and stock behaviour is untouched (opt-in, additive — ADR-F-1).
// The picker is invoked at launch (reusing stock model-picker semantics); stock
// OpenClaw never imports this module.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isPeak, peakMultiplier } from "./picker.js";
import { fallbacksFor, normalizeAlias, resolveModel } from "./resolve.js";
import {
  type ForkNodeModelSeam,
  type ForkNodesConfig,
  type NodeKind,
  type NodeModelSelection,
  type PickOptions,
  type PickResult,
  type ResolvedModel,
} from "./types.js";

/** Minimal shape of the additive `fork` config block (kept permissive). */
interface ForkConfigLike {
  nodes?: ForkNodesConfig;
}

function readForkBlock(config: OpenClawConfig | undefined): ForkConfigLike | undefined {
  return (config as unknown as { fork?: ForkConfigLike } | undefined)?.fork;
}

export class ForkNodeModelService implements ForkNodeModelSeam {
  private readonly config: ForkNodesConfig;
  private readonly selection: NodeModelSelection;

  constructor(config: ForkNodesConfig, selection: NodeModelSelection = {}) {
    this.config = config;
    this.selection = selection;
  }

  defaultFor(node: NodeKind): string | null {
    const ref = this.config.defaultModel?.[node];
    if (!ref) {
      return null;
    }
    return normalizeAlias(ref, this.config.aliases ?? {});
  }

  resolveModel(node: NodeKind, override?: string): ResolvedModel {
    return resolveModel(this.selection, node, this.config, override);
  }

  /**
   * Launch-time pick. Default: the per-node default (or override). When NOT an
   * essential turn and the chosen model is inside a peak surcharge window and a
   * fallback exists, advise the cheaper fallback. Essential turns are never
   * downgraded (ADR-U6-3).
   */
  pick(node: NodeKind, opts: PickOptions): PickResult {
    const primary = this.resolveModel(node);
    const fallbacks = fallbacksFor(this.selection, node, this.config);
    const fallback = fallbacks[0];

    if (opts.essential || !fallback) {
      return {
        model: primary.model,
        advised: false,
        fallback,
        node,
        reason: opts.essential
          ? "essential turn — no downgrade"
          : "no fallback configured for advisory downgrade",
      };
    }

    if (isPeak(primary.model, opts.nowUtc, this.config.costWindows)) {
      const mult = peakMultiplier(primary.model, opts.nowUtc, this.config.costWindows);
      return {
        model: fallback,
        advised: true,
        fallback: primary.model,
        node,
        reason: `peak window active (×${mult}) — advised cheaper fallback`,
      };
    }

    return {
      model: primary.model,
      advised: false,
      fallback,
      node,
      reason: "off-peak — primary model",
    };
  }
}

/**
 * Construct the U6 seam from config + the stock-resolved selection. Returns null
 * when the `fork.nodes` block is absent (stock install). A present-but-empty
 * block is still valid (defaults may come from the selection).
 */
export function createNodeModelSeam(
  config: OpenClawConfig | undefined,
  selection: NodeModelSelection = {},
): ForkNodeModelService | null {
  const nodes = readForkBlock(config)?.nodes;
  if (!nodes) {
    return null;
  }
  return new ForkNodeModelService(nodes, selection);
}

/** Process-wide singleton (lazy), keyed off the injected stock selection. */
let singleton: ForkNodeModelService | null | undefined;
let singletonSelection: NodeModelSelection | undefined;

export function getNodeModelSeam(
  config: OpenClawConfig | undefined,
  selection: NodeModelSelection = {},
): ForkNodeModelService | null {
  if (singleton === undefined || singletonSelection !== selection) {
    singleton = createNodeModelSeam(config, selection);
    singletonSelection = selection;
  }
  return singleton;
}

/** Test-only: reset the process-wide singleton. */
export function resetNodeModelSeamForTest(): void {
  singleton = undefined;
  singletonSelection = undefined;
}

export { isPeak, peakMultiplier } from "./picker.js";
export { fallbacksFor, isModelRef, normalizeAlias, resolveModel } from "./resolve.js";
export {
  ModelResolutionError,
  NODE_KINDS,
  type CostWindow,
  type ForkNodeModelSeam,
  type ForkNodesConfig,
  type NodeKind,
  type NodeModelSelection,
  type PickOptions,
  type PickResult,
  type ResolvedModel,
} from "./types.js";
