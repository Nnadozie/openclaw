// @fork-seam U5 — heartbeat initiative: the heartbeat task pulls the queue head
// instead of pinging idle (ADR-U5-1: mechanism change, behaviour preserved).
import type { ForkDriverSeam, ForkWorkQueueSeam, HeartbeatTick } from "./types.js";

export interface HeartbeatInitiativeOptions {
  /** Action text used to refill when the queue is empty (never-empty invariant). */
  refillAction: string;
}

export class ForkHeartbeatInitiative {
  private readonly queue: ForkWorkQueueSeam;
  private readonly driver: ForkDriverSeam;
  private readonly opts: HeartbeatInitiativeOptions;

  constructor(queue: ForkWorkQueueSeam, driver: ForkDriverSeam, opts: HeartbeatInitiativeOptions) {
    this.queue = queue;
    this.driver = driver;
    this.opts = opts;
  }

  /**
   * Take initiative for one heartbeat tick:
   *  - runnable work exists  => advance one item (real work, not an idle ping)
   *  - queue empty (defect)  => record the defect AND refill a successor
   */
  async tick(): Promise<HeartbeatTick> {
    if (this.queue.runnableCount() === 0) {
      const defect = "heartbeat found an EMPTY runnable queue (defect)";
      this.queue.recordDefect(defect);
      if (!this.opts.refillAction) {
        return { kind: "idle", detail: defect };
      }
      this.queue.add(this.opts.refillAction);
      return { kind: "refilled", defect };
    }

    const outcome = await this.driver.advance();
    if (outcome.kind === "advanced") {
      return { kind: "advanced", itemId: outcome.item.id, measured: outcome.measured };
    }
    if (outcome.kind === "blocked") {
      return { kind: "advanced", itemId: outcome.item.id, measured: `blocked: ${outcome.reason}` };
    }
    return { kind: "idle", detail: outcome.defect };
  }
}
