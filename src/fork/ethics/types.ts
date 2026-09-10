// @fork-seam U11 — ethics core: typed contracts (discernment guard + devotion scheduler).
//
// Additive seam. It never replaces stock admission/preflight or the cron/heartbeat
// services; it adds a fail-closed ethics gate in front of consequential actions and
// a scheduled-devotion peer. See design/11-spiritual-ethics-core.md.
import { z } from "zod";

/** The three discernment verdicts. */
export type DiscernmentVerdict = "ALLOW" | "ASK" | "BLOCK";

/** Action classes that are consequential enough to be gated. */
export const CONSEQUENTIAL_ACTION_CLASSES = [
  "external_send",
  "spend",
  "destructive",
  "irreversible",
  "public_post",
  "credential_use",
] as const;

export type ConsequentialActionClass = (typeof CONSEQUENTIAL_ACTION_CLASSES)[number];

export const ConsequentialActionClassSchema = z.enum(CONSEQUENTIAL_ACTION_CLASSES);

/** A consequential action presented to the gate. */
export interface GatedAction {
  class_: ConsequentialActionClass;
  /** One-line human summary of what will happen. */
  summary: string;
  /**
   * Set true only when the actor asserts the action is transparent and consensual
   * (no deception, no concealment). This is the *claim*; the guard checks it against
   * the policy, it does not trust it blindly.
   */
  honest?: boolean;
}

export interface DiscernmentDecision {
  verdict: DiscernmentVerdict;
  /** One-line reason, logged. Never null. */
  reason: string;
}

/** Append-only conscience ledger entry. */
export interface ConscienceEntry {
  at: string;
  actionClass: ConsequentialActionClass;
  verdict: DiscernmentVerdict;
  summary: string;
  worthy: boolean;
  reason: string;
}

/** Devotion kinds. Scheduled only — there are no per-message prayers. */
export const DEVOTION_KINDS = ["morningOffering", "examen", "preTaskAspiration"] as const;
export type DevotionKind = (typeof DEVOTION_KINDS)[number];

export interface CompanionConfig {
  enabled: boolean;
  inviteUser: boolean;
  /** Quiet hours as whole UTC hours [start, end); the invite is suppressed inside. */
  quietHours: [number, number];
  maxPerDay: number;
}

export interface DevotionConfig {
  /** "HH:MM" UTC for the Morning Offering, or undefined to disable. */
  morningOffering?: string;
  /** "HH:MM" UTC for the Evening Examen, or undefined to disable. */
  examen?: string;
  /** Emit a single pre-task aspiration per task (never per message). */
  preTaskAspiration?: boolean;
  companion?: CompanionConfig;
}

/** A scheduled devotion plan entry (no side effects; the caller fires it). */
export interface DevotionPlanEntry {
  kind: DevotionKind;
  /** "HH:MM" UTC, or null for event-driven (pre-task) devotions. */
  atUtc: string | null;
  cadence: "daily" | "per-task";
}

export const CompanionConfigSchema = z.strictObject({
  enabled: z.boolean(),
  inviteUser: z.boolean(),
  quietHours: z.tuple([z.number().int().min(0).max(23), z.number().int().min(1).max(24)]),
  maxPerDay: z.number().int().min(0),
});

const ClockSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM (UTC)");

export const DevotionConfigSchema = z.strictObject({
  morningOffering: ClockSchema.optional(),
  examen: ClockSchema.optional(),
  preTaskAspiration: z.boolean().optional(),
  companion: CompanionConfigSchema.optional(),
});
