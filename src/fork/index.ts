// @fork-seam U1,U5,U6,U11,U12 — the fork's production entry point.
//
// One place where the P1 seams are constructed for a running gateway. Stock
// OpenClaw never imports this module; the fork wires it from the gateway when
// the additive `fork{}` config block is present (opt-in, fail-closed).
//
// It is intentionally dependency-light and side-effect-free: callers construct
// what they need, lazily.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createAutonomySeam, type AutonomySeam } from "./autonomy/index.js";
import type { ForkDiscernmentSeam } from "./ethics/discernment.js";
import { createEthicsSeam, type EthicsSeam } from "./ethics/index.js";
import { createNodeModelSeam, type ForkNodeModelService } from "./per-node-model/index.js";
import { buildNodeModelSelection } from "./per-node-model/selection.js";
import { createProviderSeam } from "./provider/index.js";
import type { ForkProviderSeam } from "./provider/types.js";
import { createSelfUpgradeSeam, type SelfUpgradeSeam } from "./self-upgrade/index.js";
import { ImprovementStager } from "./self-upgrade/stage.js";
import {
  createSelfUpgradeRuntimeDeps,
  type SelfUpgradeRuntimeOptions,
} from "./self-upgrade/runtime.js";
import { createAutoUpgradeSeam, type AutoUpgradeSeam } from "./upgrade/index.js";
import type { CurrencyCandidate, UpgradeValidation } from "./upgrade/types.js";

export interface ForkSeams {
  /** U1 — provider-agnostic LLM seam (BYOK + cost-aware routing). */
  provider: ForkProviderSeam;
  /** U11b — discernment guard surface (null when the ethics block is off). */
  discernment: ForkDiscernmentSeam | null;
  /** U11 — Jesuit ethics core (discernment guard + devotion scheduler). */
  ethics: EthicsSeam | null;
  /** U2 — self-upgrading loop (safe, gated). Null when the config block is off. */
  selfUpgrade: SelfUpgradeSeam | null;
  /**
   * U5 — anti-silence autonomy seam (work-queue + watchdog + driver + heartbeat).
   * Null when the `fork.autonomy` block is absent/disabled (stock install).
   */
  autonomy: AutonomySeam | null;
  /**
   * U6 — per-node model selection service (default-per-node + launch picker).
   * Null when the `fork.nodes` block is absent (stock install).
   */
  nodeModel: ForkNodeModelService | null;
  /**
   * U12 — auto-upgrade / currency seam (always-latest, rollback-safe).
   * Null when the `fork.autoUpgrade` block is absent/disabled (stock install).
   */
  autoUpgrade: AutoUpgradeSeam | null;
}

/**
 * Construct every P1 fork seam from config. The provider seam is always
 * constructible (it is inert until models are registered); the ethics seam is
 * null unless the ethics/devotions block is enabled. A present-but-disabled
 * ethics policy throws (fail-closed, never a silent no-op).
 */
export interface ForkSeamOptions {
  stateDir?: string;
  /**
   * U1 turn transport (real provider client in production; in-process mock in
   * the runtime gate). Forwarded to the provider seam's `transport` option.
   */
  providerTransport?: import("./provider/types.js").ForkTurnTransport;
  /**
   * U1 adapter registry override (e.g. a runtime gate registering a mock/ad-hoc
   * adapter). Forwarded to the provider seam's `adapters` option.
   */
  providerAdapters?: readonly import("./provider/types.js").ForkModelAdapter[];
  /**
   * U2 self-upgrade RUNTIME stage/apply deps. When provided, the self-upgrade
   * seam is constructed with real stage/apply/restore deps (gated, sandboxed,
   * rollback-capable) instead of the fail-closed no-op deps. This is what turns
   * U2 from inert to runtime-proven. Stock installs omit it (inert).
   */
  selfUpgradeRuntime?: SelfUpgradeRuntimeOptions;
}

export function createForkSeams(
  config: OpenClawConfig | undefined,
  opts: ForkSeamOptions = {},
): ForkSeams {
  const ethics = createEthicsSeam(config, opts);
  const stateDir = opts.stateDir;
  return {
    provider: createProviderSeam(config, {
      statePath: providerStatePath(stateDir),
      transport: opts.providerTransport,
      adapters: opts.providerAdapters,
    }),
    discernment: ethics?.discernment ?? null,
    ethics,
    // U2 self-upgrade is opt-in and inert until a caller supplies real stage/app
    // deps; constructing the seam here is the production call-site (Tier-2).
    selfUpgrade: createSelfUpgradeSeam(config, selfUpgradeDeps(stateDir, opts.selfUpgradeRuntime)),
    // U5 autonomy: constructed when the `fork.autonomy` block is present; the
    // queue/driver/watchdog/heartbeat are the live anti-silence surface.
    autonomy: createAutonomySeam(config, { stateDir }),
    // U6 per-node model: the stock-derived selection is fed to the seam so a
    // configured `fork.nodes` block drives the launch picker (same selection the
    // run already resolves against). Per-run overrides still win (selection.ts).
    nodeModel: nodeModelSeam(config),
    // U12 auto-upgrade: opt-in and inert until a caller supplies real validate/
    // apply deps; constructing it here is the production call-site.
    autoUpgrade: createAutoUpgradeSeam(config, autoUpgradeDeps(stateDir)),
  };
}

/** U6 per-node model seam, lazily derived only when `fork.nodes` is present. */
function nodeModelSeam(config: OpenClawConfig | undefined): ForkNodeModelService | null {
  const nodes = (config as unknown as { fork?: { nodes?: unknown } } | undefined)?.fork?.nodes;
  if (!nodes) {
    return null;
  }
  return createNodeModelSeam(config, buildNodeModelSelection({ config }));
}

/**
 * U2 self-upgrade dependencies. The stage/apply behaviour is injected by the
 * gateway's runtime wiring; here we provide fail-closed no-op deps so the seam
 * is constructible (and inert) without a runtime backer. When the caller
 * supplies `selfUpgradeRuntime` (the runtime gate / a real deployment), we
 * build the real stage/apply/restore deps so the seam can actually act.
 */
function selfUpgradeDeps(
  stateDir: string | undefined,
  runtime: SelfUpgradeRuntimeOptions | undefined,
) {
  const base = stateDir ?? process.env.OPENCLAW_STATE_DIR ?? ".";
  if (runtime) {
    // Real deps: the loop stages, validates, applies and rolls back for real.
    return createSelfUpgradeRuntimeDeps({
      ...runtime,
      appliedRoot: runtime.appliedRoot ?? `${base}/fork/self-upgrade-applied`,
    });
  }
  // Fail-closed defaults: the seam is constructible from config but inert until
  // the gateway runtime supplies real materialize/validate/apply. The validate
  // default returns a refusal so nothing ever promotes on these no-op deps.
  const stager = new ImprovementStager({
    liveRoot: base,
    workRoot: `${base}/fork/stage`,
    materialize: async () => [],
    validate: async () => ({ ok: false, errors: ["no runtime validator wired"] }),
  });
  return { stager, apply: async () => {} };
}

/**
 * U12 auto-upgrade dependencies. Fail-closed defaults so the seam is
 * constructible from config but inert until the gateway runtime supplies real
 * validate/canary/apply. The validate default returns a refusal, so nothing
 * ever promotes on these no-op deps (mirrors U2 self-upgrade). The state
 * directory is resolved inside `createAutoUpgradeSeam` from the config block,
 * so it is not threaded here.
 */
function autoUpgradeDeps(_stateDir: string | undefined) {
  return {
    validate: async (_candidate: CurrencyCandidate): Promise<UpgradeValidation> => ({
      ok: false,
      errors: ["no runtime validator wired"],
    }),
    apply: async (_candidate: CurrencyCandidate): Promise<void> => {
      // Fail-closed no-op: promotion is impossible without a real apply dep.
    },
  };
}

function providerStatePath(stateDir: string | undefined): string {
  const base = stateDir ?? process.env.OPENCLAW_STATE_DIR ?? ".";
  return `${base}/fork/provider-state.json`;
}
