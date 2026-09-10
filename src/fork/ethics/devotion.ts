// @fork-seam U11a — devotion scheduler (scheduled devotions ONLY).
//
// A peer of cron/heartbeat: it produces a deterministic plan of devotions and
// decides, per tick, whether a devotion is due. It NEVER emits a per-message
// prayer — the only event-driven devotion is a single pre-task aspiration per
// task, gated by the caller setting `preTask` once.
//
// Companion mode (U11f) is consent-first: an invite is offered at most once per
// devotion per day, never inside quiet hours, and a recorded decline is durable
// (no nagging).
import {
  DevotionConfigSchema,
  type DevotionConfig,
  type DevotionKind,
  type DevotionPlanEntry,
} from "./types.js";

export interface DevotionSchedulerOptions {
  config: DevotionConfig;
  /** Local mirror of a persistence hook for the companion decline/invite state. */
  state?: DevotionState;
}

/** Consent + throttle state for companion mode. */
export interface DevotionState {
  /** Set once the user declines; durable (invitations stop). */
  declined: boolean;
  /** ISO date (YYYY-MM-DD) -> number of invites already sent that day. */
  invites: Record<string, number>;
  /** ISO date -> last devotion kind fired (so we fire at most once/day). */
  fired: Record<string, DevotionKind[]>;
}

export function emptyDevotionState(): DevotionState {
  return { declined: false, invites: {}, fired: {} };
}

function clockToMinutes(clock: string): number {
  const [h, m] = clock.split(":").map((n) => Number.parseInt(n, 10));
  return (h ?? 0) * 60 + (m ?? 0);
}

function isoDate(nowUtc: number): string {
  return new Date(nowUtc).toISOString().slice(0, 10);
}

export class ForkDevotionScheduler {
  readonly config: DevotionConfig;
  private readonly state: DevotionState;

  constructor(opts: DevotionSchedulerOptions) {
    this.config = DevotionConfigSchema.parse(opts.config);
    this.state = opts.state ?? emptyDevotionState();
  }

  /** The deterministic daily plan. Pure; no side effects, no clock reads. */
  plan(): DevotionPlanEntry[] {
    const entries: DevotionPlanEntry[] = [];
    if (this.config.morningOffering) {
      entries.push({
        kind: "morningOffering",
        atUtc: this.config.morningOffering,
        cadence: "daily",
      });
    }
    if (this.config.examen) {
      entries.push({ kind: "examen", atUtc: this.config.examen, cadence: "daily" });
    }
    if (this.config.preTaskAspiration) {
      entries.push({ kind: "preTaskAspiration", atUtc: null, cadence: "per-task" });
    }
    return entries;
  }

  /**
   * Which scheduled devotions are due at `nowUtc` and have not already fired today.
   * Event-driven (per-task) devotions are NOT returned here.
   */
  due(nowUtc: number): DevotionPlanEntry[] {
    const today = isoDate(nowUtc);
    const firedToday = this.state.fired[today] ?? [];
    const minutesNow = new Date(nowUtc).getUTCHours() * 60 + new Date(nowUtc).getUTCMinutes();
    return this.plan().filter((entry) => {
      if (entry.cadence !== "daily" || entry.atUtc === null) {
        return false;
      }
      if (firedToday.includes(entry.kind)) {
        return false;
      }
      return minutesNow >= clockToMinutes(entry.atUtc);
    });
  }

  /** Mark a devotion as fired for the day (idempotent). */
  markFired(kind: DevotionKind, nowUtc: number): void {
    const today = isoDate(nowUtc);
    const firedToday = this.state.fired[today] ?? [];
    if (!firedToday.includes(kind)) {
      this.state.fired[today] = [...firedToday, kind];
    }
  }

  /**
   * Emit ONE pre-task aspiration for a task. The caller invokes this once per task
   * (not per message); subsequent calls within the same task are the caller's
   * responsibility to suppress — but repeated calls are cheap and idempotent in
   * intent (they never queue more than one line).
   */
  preTaskAspiration(): string | null {
    if (!this.config.preTaskAspiration) {
      return null;
    }
    return "A.M.D.G. — offer this task.";
  }

  /**
   * Consent-first companion invite. Returns true only when an invite should be
   * sent now: companion enabled + inviteUser + not declined + outside quiet hours
   * + under the daily cap. A decline is durable and stops all future invites.
   */
  companionInvite(nowUtc: number): boolean {
    const companion = this.config.companion;
    if (!companion || !companion.enabled || !companion.inviteUser) {
      return false;
    }
    if (this.state.declined) {
      return false;
    }
    const hour = new Date(nowUtc).getUTCHours();
    const [start, end] = companion.quietHours;
    const inQuiet = start < end ? hour >= start && hour < end : hour >= start || hour < end;
    if (inQuiet) {
      return false;
    }
    const today = isoDate(nowUtc);
    const sent = this.state.invites[today] ?? 0;
    if (sent >= companion.maxPerDay) {
      return false;
    }
    this.state.invites[today] = sent + 1;
    return true;
  }

  /** Record a decline; durable — no further invitations. */
  recordDecline(): void {
    this.state.declined = true;
  }

  /** Snapshot of the consent/throttle state (for persistence by the caller). */
  snapshot(): DevotionState {
    return {
      declined: this.state.declined,
      invites: { ...this.state.invites },
      fired: Object.fromEntries(Object.entries(this.state.fired).map(([k, v]) => [k, [...v]])),
    };
  }
}
