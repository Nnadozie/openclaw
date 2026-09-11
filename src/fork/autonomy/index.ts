// @fork-seam U5 — production wiring for the anti-silence autonomy seam.
//
// Built from the additive `fork.autonomy` config block; when absent nothing is
// constructed and stock behaviour is untouched (opt-in, additive — ADR-F-1).
// Wired from a heartbeat-task / cron in the running gateway; stock OpenClaw never
// imports this module.
import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ForkDriver } from "./driver.js";
import { ForkHeartbeatInitiative } from "./heartbeat.js";
import { ForkWorkQueue } from "./queue.js";
import { createAutonomyTicker, type AutonomyTicker } from "./ticker.js";
import type { AutonomyConfig } from "./types.js";
import { ForkWatchdog } from "./watchdog.js";

/** Minimal shape of the additive `fork` config block (kept permissive). */
interface ForkConfigLike {
  autonomy?: AutonomyConfig;
}

function readForkBlock(config: OpenClawConfig | undefined): ForkConfigLike | undefined {
  return (config as unknown as { fork?: ForkConfigLike } | undefined)?.fork;
}

export interface AutonomySeam {
  queue: ForkWorkQueue;
  driver: ForkDriver;
  watchdog: ForkWatchdog;
  heartbeat: ForkHeartbeatInitiative;
  /** The scheduled driver: run watchdog.check() + heartbeat.tick() on a cadence. */
  ticker: AutonomyTicker;
}

export interface AutonomySeamOptions {
  /** State directory (defaults to `OPENCLAW_STATE_DIR`/`.`), queue under `fork/`. */
  stateDir?: string;
  /** Reuse an existing queue (tests / shared holder). */
  queue?: ForkWorkQueue;
}

/**
 * Construct the U5 autonomy seam from config. Returns null when the
 * `fork.autonomy` block is absent or explicitly disabled (stock install).
 */
export function createAutonomySeam(
  config: OpenClawConfig | undefined,
  opts: AutonomySeamOptions = {},
): AutonomySeam | null {
  const autonomy = readForkBlock(config)?.autonomy;
  if (!autonomy || autonomy.enabled === false) {
    return null;
  }

  const base = opts.stateDir ?? process.env.OPENCLAW_STATE_DIR ?? ".";
  const statePath = autonomy.queuePath ?? path.join(base, "fork", "work-queue.json");
  const driverStatePath = autonomy.driverStatePath ?? path.join(base, "fork", "driver-state.json");
  const refillAction =
    autonomy.refillAction ?? "review fork status surface and enqueue the next zero-cost action";

  const queue =
    opts.queue ??
    new ForkWorkQueue({
      statePath,
      fallbackAction: refillAction,
    });

  const driver = new ForkDriver(queue, {
    statePath: driverStatePath,
    eventsPath: driverStatePath.replace(/\.json$/, "-events.ndjson"),
  });

  const watchdog = new ForkWatchdog(queue, driver, {
    config: {
      enabled: autonomy.watchdog?.enabled ?? true,
      stallMs: autonomy.watchdog?.stallMs ?? 30 * 60 * 1000,
    },
  });

  const heartbeat = new ForkHeartbeatInitiative(queue, driver, { refillAction });

  const ticker = createAutonomyTicker({ queue, driver, watchdog, heartbeat }, {
    intervalMs: autonomy.tickIntervalMs,
  });

  return { queue, driver, watchdog, heartbeat, ticker };
}

/** Process-wide singleton (lazy). */
let singleton: AutonomySeam | null | undefined;

export function getAutonomySeam(config: OpenClawConfig | undefined): AutonomySeam | null {
  if (singleton === undefined) {
    singleton = createAutonomySeam(config);
  }
  return singleton;
}

/** Test-only: reset the process-wide singleton. */
export function resetAutonomySeamForTest(): void {
  singleton = undefined;
}

export { ForkDriver } from "./driver.js";
export { ForkHeartbeatInitiative } from "./heartbeat.js";
export { EmptyQueueError, ForkWorkQueue } from "./queue.js";
export { ForkAutonomyTicker, createAutonomyTicker } from "./ticker.js";
export type { AutonomyTicker, AutonomyTickerOptions, AutonomyTickResult, AutonomyTickSurface } from "./ticker.js";
export { ForkWatchdog } from "./watchdog.js";
export type { ForkWorkQueueSeam } from "./types.js";
export * from "./types.js";
