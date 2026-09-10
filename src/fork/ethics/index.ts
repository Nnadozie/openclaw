// @fork-seam U11 — production wiring for the ethics core.
//
// Built from the additive `fork.ethics` / `fork.devotions` / `fork.discernment`
// config block; when absent nothing is constructed and stock behaviour is
// untouched (opt-in, additive — ADR-U11-1/2/3/4).
//
// Fail-closed: if a policy is supplied but cannot be armed, construction throws.
// There is no "disabled" policy — the guard is either armed or absent.
import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ForkDevotionScheduler } from "./devotion.js";
import { ForkDiscernmentGuard } from "./discernment.js";
import { DEFAULT_ETHICS_POLICY, type EthicsPolicy } from "./policy.js";
import type { DevotionConfig } from "./types.js";

/** Minimal shape of the additive `fork` config block (kept permissive). */
interface ForkConfigLike {
  ethics?: {
    jesuit?: { enabled?: boolean; policy?: unknown };
  };
  devotions?: DevotionConfig;
  discernment?: {
    gateOn?: string[];
    mode?: "ask" | "block";
  };
}

function readForkBlock(config: OpenClawConfig | undefined): ForkConfigLike | undefined {
  return (config as unknown as { fork?: ForkConfigLike } | undefined)?.fork;
}

/** Parse + arm the ethics policy. Throws when the policy cannot be armed. */
function resolvePolicy(fork: ForkConfigLike | undefined): EthicsPolicy {
  const candidate = fork?.ethics?.jesuit?.policy;
  if (candidate === undefined) {
    return DEFAULT_ETHICS_POLICY;
  }
  // Never accept a silent disable: assertPolicyArmed (via the guard/policy
  // constructor) throws on `denyByDefault: false` or malformed shapes.
  return candidate as EthicsPolicy;
}

/**
 * The conscience ledger: append-only NDJSON under the fork state dir. NO-DELETE —
 * the file is only ever opened with the append flag.
 */
export function createLedgerSink(stateDir: string): (entry: Record<string, unknown>) => void {
  const file = path.join(stateDir, "fork", "conscience-ledger.ndjson");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return (entry) => {
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`;
    fs.appendFileSync(file, line, { encoding: "utf8", mode: 0o600 });
  };
}

export interface EthicsSeam {
  discernment: ForkDiscernmentGuard;
  devotions: ForkDevotionScheduler | null;
}

/**
 * Construct the ethics seam from config. Returns null when the fork ethics block
 * is absent (stock install). A present-but-invalid policy throws — fail-closed.
 */
export function createEthicsSeam(
  config: OpenClawConfig | undefined,
  opts: { stateDir?: string } = {},
): EthicsSeam | null {
  const fork = readForkBlock(config);
  const ethicsEnabled = fork?.ethics?.jesuit?.enabled === true;
  const hasDevotions = Boolean(fork?.devotions);
  if (!fork || (!ethicsEnabled && !hasDevotions)) {
    return null;
  }

  const stateDir = opts.stateDir ?? path.join(process.env.OPENCLAW_STATE_DIR ?? ".", "fork");
  const ledger = createLedgerSink(stateDir);

  const discernment = new ForkDiscernmentGuard({
    policy: resolvePolicy(fork),
    ledger: (entry) =>
      ledger({
        actionClass: entry.actionClass,
        verdict: entry.verdict,
        summary: entry.summary,
        worthy: entry.worthy,
        reason: entry.reason,
      }),
  });

  const devotions = hasDevotions ? new ForkDevotionScheduler({ config: fork.devotions! }) : null;
  return { discernment, devotions };
}

/** Process-wide singleton (lazy). */
let singleton: EthicsSeam | null | undefined;

export function getEthicsSeam(config: OpenClawConfig | undefined): EthicsSeam | null {
  if (singleton === undefined) {
    singleton = createEthicsSeam(config);
  }
  return singleton;
}

/** Test-only: reset the process-wide singleton. */
export function resetEthicsSeamForTest(): void {
  singleton = undefined;
}

export { ForkDiscernmentGuard, ForkDevotionScheduler, DEFAULT_ETHICS_POLICY };
export * from "./types.js";
export {
  ETHICS_PRINCIPLES,
  ETHICS_VERSION,
  EthicsPolicyError,
  EthicsPolicySchema,
  ForkEthicsPolicy,
  assertPolicyArmed,
  type CapabilityRule,
  type EthicsPolicy,
  type EthicsPrinciple,
} from "./policy.js";
