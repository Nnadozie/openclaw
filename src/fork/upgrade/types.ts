// @fork-seam U12 — auto-upgrade / currency: typed contracts.
//
// The fork keeps itself "always on the latest agentic tech" by tracking three
// kinds of currency signal and adopting them through a rollback-safe, staged
// path. This file is types + schemas only (no I/O); the orchestrator lives in
// `pipeline.ts` and the production wiring in `index.ts`.
//
// ADDITIVE + OPT-IN: nothing here runs unless the config enables
// `fork.autoUpgrade`. Guarded: money/auth/credential paths are never upgraded
// without an explicit approval (see `guard.ts`).
import { z } from "zod";

/**
 * What kind of newness was detected.
 *  - upstream_release     — a newer upstream OpenClaw release exists
 *  - model_capability     — a new model/provider capability worth adopting (U1)
 *  - agent_pattern        — a newer agent pattern/technique to adopt
 */
export const CURRENCY_KINDS = ["upstream_release", "model_capability", "agent_pattern"] as const;
export type CurrencyKind = (typeof CURRENCY_KINDS)[number];
export const CurrencyKindSchema = z.enum(CURRENCY_KINDS);

/** Lifecycle of a candidate upgrade. Persisted; append-only history. */
export const UPGRADE_STATES = [
  "detected",
  "validated",
  "staged",
  "applied",
  "rolled_back",
  "rejected",
] as const;
export type UpgradeState = (typeof UPGRADE_STATES)[number];

/** A detected candidate upgrade (pre-validation). */
export interface CurrencyCandidate {
  kind: CurrencyKind;
  /** Stable identity, e.g. "openclaw@1.2.3" or "deepseek/deepseek-v5". */
  id: string;
  /** Current version/ref in effect (what we would be moving away from). */
  from: string;
  /** Candidate version/ref we would move to. */
  to: string;
  /** One-line human summary of the change. */
  summary: string;
  /**
   * True when adopting this touches the money or auth/credential path.
   * Such candidates are NEVER auto-applied; they require an explicit approval.
   */
  touchesMoneyOrAuth?: boolean;
}

/** Result of the validate step (same shape as U1's for consistency). */
export interface UpgradeValidation {
  ok: boolean;
  errors: string[];
}

/** A record persisted in the append-only upgrade ledger. */
export interface UpgradeRecord {
  at: string;
  candidate: CurrencyCandidate;
  state: UpgradeState;
  /** Free-form, secret-free detail (validation errors, canary result, reason). */
  detail?: string;
  /** The ref that was active before this candidate (for rollback). */
  lastGood: string | null;
}

export interface ApplyResult {
  ok: boolean;
  /** True when we fell back to the last-good ref (apply failed after staging). */
  rolledBack: boolean;
  state: UpgradeState;
  error?: string;
}

/** Minimal persistable state; the ledger is append-only NDJSON alongside it. */
export interface UpgradeStateFile {
  /** The ref currently in effect. */
  current: string | null;
  /** The last ref proven good (rollback target). */
  lastGood: string | null;
  updatedAt: string;
}

export const CurrencyCandidateSchema = z.object({
  kind: CurrencyKindSchema,
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  summary: z.string(),
  touchesMoneyOrAuth: z.boolean().optional(),
});
