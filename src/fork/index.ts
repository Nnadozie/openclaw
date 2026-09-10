// @fork-seam U1,U11 — the fork's production entry point.
//
// One place where the P1 seams are constructed for a running gateway. Stock
// OpenClaw never imports this module; the fork wires it from the gateway when
// the additive `fork{}` config block is present (opt-in, fail-closed).
//
// It is intentionally dependency-light and side-effect-free: callers construct
// what they need, lazily.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ForkDiscernmentSeam } from "./ethics/discernment.js";
import { createEthicsSeam, type EthicsSeam } from "./ethics/index.js";
import { createProviderSeam } from "./provider/index.js";
import type { ForkProviderSeam } from "./provider/types.js";
import { createSelfUpgradeSeam, type SelfUpgradeSeam } from "./self-upgrade/index.js";
import { ImprovementStager } from "./self-upgrade/stage.js";

export interface ForkSeams {
  /** U1 — provider-agnostic LLM seam (BYOK + cost-aware routing). */
  provider: ForkProviderSeam;
  /** U11b — discernment guard surface (null when the ethics block is off). */
  discernment: ForkDiscernmentSeam | null;
  /** U11 — Jesuit ethics core (discernment guard + devotion scheduler). */
  ethics: EthicsSeam | null;
  /** U2 — self-upgrading loop (safe, gated). Null when the config block is off. */
  selfUpgrade: SelfUpgradeSeam | null;
}

/**
 * Construct every P1 fork seam from config. The provider seam is always
 * constructible (it is inert until models are registered); the ethics seam is
 * null unless the ethics/devotions block is enabled. A present-but-disabled
 * ethics policy throws (fail-closed, never a silent no-op).
 */
export function createForkSeams(
  config: OpenClawConfig | undefined,
  opts: { stateDir?: string } = {},
): ForkSeams {
  const ethics = createEthicsSeam(config, opts);
  return {
    provider: createProviderSeam(config, { statePath: providerStatePath(opts.stateDir) }),
    discernment: ethics?.discernment ?? null,
    ethics,
    // U2 self-upgrade is opt-in and inert until a caller supplies real stage/app
    // deps; constructing the seam here is the production call-site (Tier-2).
    selfUpgrade: createSelfUpgradeSeam(config, selfUpgradeDeps(opts.stateDir)),
  };
}

/**
 * U2 self-upgrade dependencies. The stage/apply behaviour is injected by the
 * gateway's runtime wiring; here we provide fail-closed no-op deps so the seam
 * is constructible (and inert) without a runtime backer. A real deployment
 * supplies materialize/validate/apply that operate on the fork tree.
 */
function selfUpgradeDeps(stateDir: string | undefined) {
  const base = stateDir ?? process.env.OPENCLAW_STATE_DIR ?? ".";
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

function providerStatePath(stateDir: string | undefined): string {
  const base = stateDir ?? process.env.OPENCLAW_STATE_DIR ?? ".";
  return `${base}/fork/provider-state.json`;
}
