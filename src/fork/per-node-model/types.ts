// @fork-seam U6 — per-node model selection: typed contracts.
//
// Additive seam. It NEVER replaces stock model config (`agents.defaults.model`,
// `agents.list[].model`) or the run-loop. It adds a per-node-kind default model
// (agent / subagent / box) with a cost-aware launch-time picker (ADR-U6-1/2/3).
//
// See design/06-per-node-model-selection.md.

/** The node kinds that carry a default model. */
export const NODE_KINDS = ["agent", "subagent", "box"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

/**
 * Optional peak surcharge window in UTC whole hours (start inclusive, end
 * exclusive; wrap-around supported when start > end). Advisory only.
 */
export interface CostWindow {
  startUtcH: number;
  endUtcH: number;
  multiplier: number;
}

/**
 * Additive `fork.nodes` config block. Every field is optional; an absent block
 * means the seam is not constructed (stock behaviour untouched).
 */
export interface ForkNodesConfig {
  /** Default model ref per node kind. */
  defaultModel?: Partial<Record<NodeKind, string>>;
  /** Ordered fallbacks per node kind (outage / peak). */
  fallbacks?: Partial<Record<NodeKind, string[]>>;
  /** Alias → canonical ref (never a silent guess; unknown alias throws). */
  aliases?: Record<string, string>;
  /** Per-model peak windows, used by the picker's advisory downgrade. */
  costWindows?: Record<string, CostWindow>;
}

/**
 * The stock-resolved selection passed in by the caller (from stock config):
 * `agents.defaults.model` and the per-agent override `agents.list[].model`.
 * The per-agent override stays authoritative for the `agent` node (ADR-U6-1).
 */
export interface NodeModelSelection {
  agent?: { primary?: string; fallbacks?: string[] };
  subagent?: { primary?: string; fallbacks?: string[] };
  box?: { primary?: string; fallbacks?: string[] };
  /** Stock per-agent model override — authoritative for the `agent` node. */
  agentOverride?: string;
}

/** A resolve/pick outcome. */
export interface ResolvedModel {
  node: NodeKind;
  /** The effective model ref (alias already normalised to canonical). */
  model: string;
  /** The layer that supplied the value (for logs/telemetry). */
  source: "override" | "agentOverride" | "nodeDefault" | "nodePrimary" | "fallback";
}

export interface PickOptions {
  /** Current time (ms epoch). */
  nowUtc: number;
  /**
   * Essential turns are never downgraded (ADR-U6-3 / ADR-U1-4): the picker only
   * advises; it never blocks.
   */
  essential?: boolean;
}

/** The design-contract result shape (plus resolver detail). */
export interface PickResult {
  model: string;
  advised: boolean;
  fallback?: string;
  node: NodeKind;
  reason: string;
}

/** Thrown when no layer yields a model — never a silent guess. */
export class ModelResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelResolutionError";
  }
}

/** The U6 seam surface (design §5) plus the resolver. */
export interface ForkNodeModelSeam {
  /** Per-node default model ref (post-alias), or null when unset. */
  defaultFor(node: NodeKind): string | null;
  /** Launch-time picker: per-node default → alias → cost-window advise. */
  pick(node: NodeKind, opts: PickOptions): PickResult;
  /** Resolve model for a node (explicit override wins; unknown ⇒ throw). */
  resolveModel(node: NodeKind, override?: string): ResolvedModel;
}
