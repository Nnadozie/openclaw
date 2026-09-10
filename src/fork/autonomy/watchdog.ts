// @fork-seam U5 — the watchdog: detect stall / disabled-driver / empty-queue.
//
// Pure detection; the re-kick is the caller's (a cron) job (ADR-U5-3: detect and
// advance are separate so the loop cannot mask its own stall). Clock is injected.
import type { ForkDriverSeam, ForkWorkQueueSeam, WatchdogConfig, WatchdogStatus } from "./types.js";

export interface WatchdogOptions {
  config: WatchdogConfig;
  /** Injected clock (ms epoch). */
  now?: () => number;
}

export class ForkWatchdog {
  private readonly queue: ForkWorkQueueSeam;
  private readonly driver: ForkDriverSeam;
  private readonly opts: WatchdogOptions;

  constructor(queue: ForkWorkQueueSeam, driver: ForkDriverSeam, opts: WatchdogOptions) {
    this.queue = queue;
    this.driver = driver;
    this.opts = opts;
  }

  check(): WatchdogStatus {
    if (!this.opts.config.enabled) {
      return { kind: "driver-disabled", detail: "watchdog disabled by config" };
    }

    if (this.queue.runnableCount() === 0) {
      return {
        kind: "empty-queue",
        detail: "runnable queue is EMPTY (defect) — next run must refill a successor",
      };
    }

    const state = this.driver.state();
    const last = state.lastAdvanceAt;
    if (!last) {
      // Driver has never advanced but there is runnable work => kick it.
      return {
        kind: "stalled",
        stalledForMs: Number.POSITIVE_INFINITY,
        detail: "driver has never advanced while runnable work exists — re-kick",
      };
    }

    const nowMs = this.opts.now ? this.opts.now() : Date.now();
    const stalledForMs = nowMs - Date.parse(last);
    if (stalledForMs > this.opts.config.stallMs) {
      const item = this.queue.next();
      return {
        kind: "stalled",
        stalledForMs,
        itemId: item?.id,
        detail: `no advance for ${stalledForMs}ms > ${this.opts.config.stallMs}ms — re-kick driver`,
      };
    }

    return { kind: "ok", detail: `last advance ${stalledForMs}ms ago` };
  }
}
