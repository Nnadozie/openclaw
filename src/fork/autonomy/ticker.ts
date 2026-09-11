// @fork-seam U5 — the autonomy scheduler: drives the seam on a scheduled tick.
//
// ADR-U5-1/3: the heartbeat is re-pointed to pull the queue head instead of an
// idle ping, and detect (watchdog) vs advance (driver) are kept separate so the
// loop can never mask its own stall. This module is the production call-site
// that makes U5 runtime-proven: every tick executes `watchdog.check()` (detect)
// AND `heartbeat.tick()` (initiative), which together
//   - advance a real work item (driver.advance → queue.complete appends a
//     successor, never-empty invariant holds),
//   - refill + record a DEFECT when the queue is starved (never a silent idle),
//   - surface a stall when the driver clock has not advanced past `stallMs`.
//
// Zero-cost and fail-closed: the actuator is a no-op intent recorder; nothing
// paid or irreversible happens here (that belongs behind the U11 gate).
import type { ForkDriver } from "./driver.js";
import type { ForkHeartbeatInitiative } from "./heartbeat.js";
import type { ForkWorkQueue } from "./queue.js";
import type { ForkWatchdog } from "./watchdog.js";
import type { HeartbeatTick, WatchdogStatus } from "./types.js";

/** The autonomy surface a ticker drives (watchdog + heartbeat over a queue/driver). */
export interface AutonomyTickSurface {
  queue: ForkWorkQueue;
  driver: ForkDriver;
  watchdog: ForkWatchdog;
  heartbeat: ForkHeartbeatInitiative;
}

/** Result of one anti-silence tick (detection + initiative). */
export interface AutonomyTickResult {
  watchdog: WatchdogStatus;
  heartbeat: HeartbeatTick;
  /** Monotonic tick ordinal — proves the scheduler really fired. */
  tickCount: number;
}

export interface AutonomyTickerOptions {
  /** Interval between scheduled ticks (ms). Defaults to 5 minutes. */
  intervalMs?: number;
}

/** Default scheduled cadence: 5 minutes (a heartbeat-class anti-silence loop). */
export const DEFAULT_AUTONOMY_TICK_MS = 5 * 60 * 1000;

export interface AutonomyTicker {
  /** Run one tick now (awaitable). Advances a real item or refills on defect. */
  tick(): Promise<AutonomyTickResult>;
  /** Start the scheduled interval (idempotent). Unref'd: never holds the process open. */
  start(): void;
  /** Stop the scheduled interval (idempotent). */
  stop(): void;
  /** Number of ticks executed so far (scheduled or manual). */
  readonly tickCount: number;
  readonly running: boolean;
}

export class ForkAutonomyTicker implements AutonomyTicker {
  private readonly seam: AutonomyTickSurface;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private count = 0;
  private inFlight = false;
  private last: AutonomyTickResult | null = null;

  constructor(seam: AutonomyTickSurface, opts: AutonomyTickerOptions = {}) {
    this.seam = seam;
    this.intervalMs = opts.intervalMs ?? DEFAULT_AUTONOMY_TICK_MS;
  }

  get tickCount(): number {
    return this.count;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  async tick(): Promise<AutonomyTickResult> {
    // Re-entrancy guard: a slow tick must never overlap the next scheduled one.
    if (this.inFlight) {
      return (
        this.last ?? {
          watchdog: { kind: "ok", detail: "tick overlap skipped" },
          heartbeat: { kind: "idle", detail: "tick overlap skipped" },
          tickCount: this.count,
        }
      );
    }
    this.inFlight = true;
    try {
      const watchdog = this.seam.watchdog.check();
      const heartbeat = await this.seam.heartbeat.tick();
      this.count += 1;
      const result: AutonomyTickResult = { watchdog, heartbeat, tickCount: this.count };
      this.last = result;
      return result;
    } finally {
      this.inFlight = false;
    }
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    // Never hold the gateway process open for the anti-silence loop alone.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/** Construct the U5 ticker around an already-built autonomy surface. */
export function createAutonomyTicker(
  seam: AutonomyTickSurface,
  opts: AutonomyTickerOptions = {},
): AutonomyTicker {
  return new ForkAutonomyTicker(seam, opts);
}
