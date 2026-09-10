// @fork-seam U2 — self-upgrading loop (safe, gated): typed contracts.
//
// Where U12 auto-upgrades the *fleet* (tracking newer upstream releases /
// capabilities / patterns), U2 closes the *self-review* loop on a single
// instance: capture local telemetry → scheduled self-review reads telemetry +
// feedback → propose ONE improvement → validate it in an ISOLATED STAGED COPY
// → apply only on success → ROLL BACK to last-good on failure → append to an
// improvement log. Fail-closed, reversible, and NEVER allowed to touch the
// money path, safety/policy files, or auth without human approval.
//
// ADDITIVE + OPT-IN: nothing here runs unless `fork.selfUpgrade` is enabled.
// Stock OpenClaw never imports this module.
import { z } from "zod";

/**
 * What kind of signal produced an improvement proposal. The loop proposes
 * exactly ONE improvement per review (ADR-U2-1: "one improvement at a time").
 */
export const IMPROVEMENT_KINDS = [
  "latency",
  "cost",
  "error",
  "tool_usage",
  "feedback",
  "prompt",
] as const;
export type ImprovementKind = (typeof IMPROVEMENT_KINDS)[number];
export const ImprovementKindSchema = z.enum(IMPROVEMENT_KINDS);

/** Lifecycle of a single proposed improvement. Persisted; append-only. */
export const IMPROVEMENT_STATES = [
  "proposed",
  "staged",
  "applied",
  "rolled_back",
  "rejected",
] as const;
export type ImprovementState = (typeof IMPROVEMENT_STATES)[number];

/**
 * One proposed improvement. The `diff` / `files` describe WHAT would change; the
 * loop validates it in a staged copy and only then applies it for real.
 */
export interface Improvement {
  /** Stable identity, e.g. `latency:2026-09-10T14:30:00.000Z`. */
  id: string;
  kind: ImprovementKind;
  /** One-line human summary of the proposed change. */
  summary: string;
  /**
   * The exact change to make (a unified patch / file list). Secret-free;
   * never logs credentials.
   */
  diff: string;
  /**
   * Files the change touches. Used by the guard to fence the money / safety /
   * auth path and by the stage step to know what to copy + validate.
   */
  files: string[];
  /** The measurable signal that motivated the proposal (e.g. "p95 latency > 2s"). */
  motivation: string;
  /** True when the change touches money, safety/policy, or auth (see guard). */
  touchesSensitive?: boolean;
  /**
   * The last-good marker the instance can roll back to (e.g. the current
   * self-upgrade "generation" or a file backup id).
   */
  lastGood: string | null;
}

/** Result of validating an improvement inside the isolated staged copy. */
export interface StageValidation {
  ok: boolean;
  /** Secret-free errors from the staged run (tests / lint / smoke). */
  errors: string[];
  /** Summary of what the staged run measured (cost / latency delta, etc.). */
  measured?: string;
}

/** A record persisted in the append-only improvement ledger. */
export interface ImprovementRecord {
  at: string;
  improvement: Improvement;
  state: ImprovementState;
  /** Free-form, secret-free detail (validation errors, rollback reason). */
  detail?: string;
  /** The last-good ref recorded before this candidate (rollback target). */
  lastGood: string | null;
}

/** Outcome of one run of the loop. */
export interface SelfUpgradeResult {
  ok: boolean;
  /** True when we fell back to last-good after an apply failure. */
  rolledBack: boolean;
  state: ImprovementState;
  error?: string;
}

/** Canonical on-disk state (the currently-in-effect improvement generation). */
export interface SelfUpgradeStateFile {
  /** The last improvement id proven good (rollback target). */
  lastGood: string | null;
  /** The improvement id currently in effect. */
  current: string | null;
  updatedAt: string;
}

/**
 * A single local telemetry sample (one turn / action). Captured locally-first
 * and privacy-preserving: no conversation text, no secrets, only aggregates.
 */
export interface TelemetrySample {
  /** ms epoch timestamp. */
  at: number;
  /** The node that produced the turn (agent / subagent / box). */
  node: string;
  /** Round-trip latency for the turn, ms. */
  latencyMs: number;
  /** Token counts for the turn. */
  tokens: { in: number; out: number };
  /** Estimated cost for the turn, in the account currency (minor units). */
  costMinor: number;
  /** Error class if the turn errored, else null. */
  errorClass: string | null;
  /** Tool names invoked during the turn (no arguments). */
  tools: string[];
}

/** Aggregate roll-up of recent telemetry the self-review reads. */
export interface TelemetrySummary {
  turns: number;
  /** p50 / p95 latency in ms. */
  latency: { p50: number; p95: number };
  /** Estimated total cost (minor units) and per-turn mean. */
  cost: { total: number; mean: number };
  /** Count of turns per error class. */
  errors: Record<string, number>;
  /** Count of invocations per tool name. */
  toolUsage: Record<string, number>;
  /** ISO window the summary covers (start). */
  windowStart: string;
}

/** A single piece of classified feedback (U7 classifier hand-off). */
export interface FeedbackSignal {
  kind: "interest" | "objection" | "praise" | "bug" | "opt_out";
  detail: string;
  at: string;
}

/** `zod` schema for an Improvement (validation on the way into persistence). */
export const ImprovementSchema = z.object({
  id: z.string().min(1),
  kind: ImprovementKindSchema,
  summary: z.string(),
  diff: z.string(),
  files: z.array(z.string()),
  motivation: z.string(),
  touchesSensitive: z.boolean().optional(),
  lastGood: z.string().nullable(),
});
