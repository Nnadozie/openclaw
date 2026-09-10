// @fork-seam U5 — the driver: read state → act → measure → update.
//
// Advances ONE top non-blocked item per call (short bursts — ADR-U5-3). The
// actuation is injected: the fork never autonomously spends (paid => approval
// queue), so the default actuator is a zero-cost no-op that records intent.
import { appendNdjson, readJsonFile, writeJsonAtomic } from "./store.js";
import type { ForkWorkQueueSeam } from "./types.js";
import type { DriverOutcome, DriverState } from "./types.js";

export interface DriverOptions {
  /** Path to `fork/driver-state.json`; omit for in-memory (tests). */
  statePath?: string;
  /** Event stream (`driver-events.ndjson`), derived from statePath. */
  eventsPath?: string;
  /** Injected clock (ms epoch). */
  now?: () => number;
  /**
   * Act on one item and return a one-line measurement. Default: zero-cost no-op
   * (records intent only). Paid/irreversible actions belong behind the U11 gate
   * and the money approval queue — never here.
   */
  actuate?: (item: import("./types.js").QueueItem) => Promise<string>;
}

/** Zero-cost default actuator (fail-safe: does nothing that costs or leaves the box). */
async function noopActuate(item: import("./types.js").QueueItem): Promise<string> {
  return `noop: ${item.action}`;
}

export class ForkDriver {
  private readonly queue: ForkWorkQueueSeam;
  private readonly opts: DriverOptions;
  private state_: DriverState;

  constructor(queue: ForkWorkQueueSeam, opts: DriverOptions = {}) {
    this.queue = queue;
    this.opts = opts;
    this.state_ = readJsonFile<DriverState>(opts.statePath) ?? {
      advancedCount: 0,
      blockedCount: 0,
      defectCount: 0,
    };
  }

  private nowIso(): string {
    const ms = this.opts.now ? this.opts.now() : Date.now();
    return new Date(ms).toISOString();
  }

  private persist(): void {
    writeJsonAtomic(this.opts.statePath, this.state_);
  }

  private emit(kind: string, detail: Record<string, unknown>): void {
    appendNdjson(this.opts.eventsPath, { at: this.nowIso(), kind, ...detail });
  }

  state(): DriverState {
    return this.state_;
  }

  /**
   * Advance the top non-blocked item.
   *  - no runnable item  => record a DEFECT (never silently idle)
   *  - actuator succeeds => mark done (queue appends successor), stamp the clock
   *  - actuator throws   => block the item with the reason, keep going
   */
  async advance(): Promise<DriverOutcome> {
    const item = this.queue.next();
    if (!item) {
      const defect = "driver.advance(): runnable queue EMPTY (defect) — refill required";
      this.state_.defectCount += 1;
      this.persist();
      this.queue.recordDefect(defect);
      this.emit("empty", { defect });
      return { kind: "empty", defect };
    }

    this.queue.claim(item.id);
    try {
      const locate = this.opts.actuate ?? noopActuate;
      const measured = await locate(item);
      const at = this.nowIso();
      // complete() appends the successor => the queue can never empty here.
      this.queue.complete(item.id);
      this.state_.lastActionId = item.id;
      this.state_.lastAdvanceAt = at;
      this.state_.lastMeasured = measured;
      this.state_.advancedCount += 1;
      this.persist();
      this.emit("advanced", { itemId: item.id, measured });
      return { kind: "advanced", item, measured };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.queue.block(item.id, reason);
      this.state_.blockedCount += 1;
      this.persist();
      this.emit("blocked", { itemId: item.id, reason });
      return { kind: "blocked", item, reason };
    }
  }
}
