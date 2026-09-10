// @fork-seam U1 — production wiring for the provider seam.
//
// The seam is constructed from the additive `fork.models[]` / `fork.router{}`
// config block; when that block is absent nothing is constructed and stock
// behaviour is untouched (opt-in, additive — ADR-F-1 / ADR-U1-1).
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ForkProviderService, type ProviderSeamOptions } from "./service.js";
import type { ForkModelConfig } from "./types.js";

/** Minimal shape of the additive `fork` config block (kept permissive). */
interface ForkConfigLike {
  models?: {
    models?: ForkModelConfig[];
    router?: { autoDowngrade?: boolean; utilityRef?: string };
  };
  ethics?: unknown;
  devotions?: unknown;
  discernment?: unknown;
}

function readForkBlock(config: OpenClawConfig | undefined): ForkConfigLike | undefined {
  return (config as unknown as { fork?: ForkConfigLike } | undefined)?.fork;
}

/** Parse a "provider/model" ref into a ForkModelConfig seed. */
export function parseModelRef(ref: string): ForkModelConfig | undefined {
  const trimmed = ref.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    return undefined;
  }
  return {
    provider: trimmed.slice(0, slash),
    model: trimmed.slice(slash + 1),
    authKind: "bearer",
    costClass: "cheap",
  };
}

/**
 * The singleton used by production call-sites. Built lazily from config so an
 * unconfigured (stock) install never constructs the seam.
 */
let singleton: ForkProviderService | null = null;

export function createProviderSeam(
  config: OpenClawConfig | undefined,
  opts: Partial<ProviderSeamOptions> = {},
): ForkProviderService {
  const fork = readForkBlock(config);
  const statePath =
    opts.statePath ??
    path.join(process.env.OPENCLAW_STATE_DIR ?? ".", "fork", "provider-state.json");
  const utilityRef = fork?.models?.router?.utilityRef
    ? parseModelRef(fork.models.router.utilityRef)
    : undefined;
  const service = new ForkProviderService({
    statePath,
    models: fork?.models?.models,
    utilityRef,
    autoDowngrade: fork?.models?.router?.autoDowngrade ?? false,
    ...opts,
  });
  return service;
}

/** Lazily construct the process-wide provider seam from config. */
export function getProviderSeam(config: OpenClawConfig | undefined): ForkProviderService {
  if (!singleton) {
    singleton = createProviderSeam(config);
  }
  return singleton;
}

/** Test-only: reset the process-wide singleton. */
export function resetProviderSeamForTest(): void {
  singleton = null;
}
