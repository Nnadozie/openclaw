// U6 — the resolver: default per node + override + alias, never a silent guess.
import {
  ModelResolutionError,
  type ForkNodesConfig,
  type NodeKind,
  type NodeModelSelection,
  type ResolvedModel,
} from "./types.js";

/** A model ref must be `provider/model` (both non-empty). */
export function isModelRef(ref: string | undefined): ref is string {
  if (typeof ref !== "string") {
    return false;
  }
  const trimmed = ref.trim();
  const slash = trimmed.indexOf("/");
  return slash > 0 && slash < trimmed.length - 1;
}

/** Resolve an alias to its canonical ref. Unknown alias ⇒ throw (no guess). */
export function normalizeAlias(ref: string, aliases: Record<string, string> = {}): string {
  const seen = new Set<string>();
  let current = ref.trim();
  while (Object.prototype.hasOwnProperty.call(aliases, current)) {
    if (seen.has(current)) {
      throw new ModelResolutionError(`alias cycle detected at "${current}"`);
    }
    seen.add(current);
    const next = aliases[current];
    if (typeof next !== "string" || !next.trim()) {
      throw new ModelResolutionError(`alias "${current}" maps to an empty target`);
    }
    current = next.trim();
  }
  if (!isModelRef(current)) {
    throw new ModelResolutionError(`"${current}" is not a valid provider/model ref`);
  }
  return current;
}

function candidate(
  ref: string | undefined,
  source: ResolvedModel["source"],
  aliases: Record<string, string>,
): { model: string; source: ResolvedModel["source"] } | undefined {
  if (typeof ref !== "string" || !ref.trim()) {
    return undefined;
  }
  const trimmed = ref.trim();
  // An alias key may be a bare name (no slash); a non-alias must look like a ref.
  const isAlias = Object.prototype.hasOwnProperty.call(aliases, trimmed);
  if (!isAlias && !isModelRef(trimmed)) {
    return undefined;
  }
  return { model: normalizeAlias(trimmed, aliases), source };
}

/**
 * Resolve the effective model for `node`.
 *
 * Precedence (first hit wins) — the explicit override always wins:
 *   agent:    override → stock agentOverride → nodeDefault.agent → nodePrimary.agent
 *   subagent: override → nodeDefault.subagent → nodePrimary.subagent → nodePrimary.agent
 *   box:      override → nodeDefault.box → nodePrimary.box → nodePrimary.agent
 *
 * No layer ⇒ ModelResolutionError (never a silent guess).
 */
export function resolveModel(
  selection: NodeModelSelection,
  node: NodeKind,
  config: ForkNodesConfig,
  override?: string,
): ResolvedModel {
  const aliases = config.aliases ?? {};
  const defaults = config.defaultModel ?? {};

  const layers: Array<{ model?: string; source: ResolvedModel["source"] }> =
    node === "agent"
      ? [
          { model: override, source: "override" },
          { model: selection.agentOverride, source: "agentOverride" },
          { model: defaults.agent, source: "nodeDefault" },
          { model: selection.agent?.primary, source: "nodePrimary" },
        ]
      : [
          { model: override, source: "override" },
          { model: defaults[node], source: "nodeDefault" },
          { model: selection[node]?.primary, source: "nodePrimary" },
          { model: selection.agent?.primary, source: "fallback" },
        ];

  for (const layer of layers) {
    const hit = candidate(layer.model, layer.source, aliases);
    if (hit) {
      return { node, model: hit.model, source: hit.source };
    }
  }

  throw new ModelResolutionError(
    `no model resolves for node "${node}" — set fork.nodes.defaultModel.${node} or an explicit override`,
  );
}

/** Ordered fallback refs for a node (alias-normalised, invalid dropped). */
export function fallbacksFor(
  selection: NodeModelSelection,
  node: NodeKind,
  config: ForkNodesConfig,
): string[] {
  const aliases = config.aliases ?? {};
  const raw = [...(config.fallbacks?.[node] ?? []), ...(selection[node]?.fallbacks ?? [])];
  const out: string[] = [];
  for (const ref of raw) {
    if (!isModelRef(ref)) {
      continue;
    }
    const normalized = normalizeAlias(ref, aliases);
    if (!out.includes(normalized)) {
      out.push(normalized);
    }
  }
  return out;
}
