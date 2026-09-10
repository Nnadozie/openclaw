// @fork-seam U5 — the durable work-queue with a never-empty invariant.
//
// Invariant (ADR-U5-2): the queue can only become empty by DEFECT. Every
// `complete()` appends a successor, so a finished action always leaves the next
// one. Nothing is ever deleted — completion and defect records are appended.
import { appendNdjson, readJsonFile, writeJsonAtomic, writeTextAtomic } from "./store.js";
import type { QueueEvent, QueueItem, WorkQueueOptions, WorkQueueState } from "./types.js";

/** Thrown when the never-empty invariant is violated (not silently swallowed). */
export class EmptyQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmptyQueueError";
  }
}

export class ForkWorkQueue {
  private readonly opts: WorkQueueOptions;
  private state: WorkQueueState;

  constructor(opts: WorkQueueOptions = {}) {
    this.opts = opts;
    const loaded = readJsonFile<WorkQueueState>(opts.statePath);
    this.state =
      loaded && loaded.version === 1 && Array.isArray(loaded.items)
        ? loaded
        : { version: 1, items: [], log: [] };
  }

  private nowIso(): string {
    const ms = this.opts.now ? this.opts.now() : Date.now();
    return new Date(ms).toISOString();
  }

  private eventsPath(): string | undefined {
    return this.opts.statePath?.replace(/\.json$/, ".events.ndjson");
  }

  private mirrorPath(): string | undefined {
    return this.opts.statePath?.replace(/\.json$/, ".md");
  }

  private persist(event: QueueEvent): void {
    this.state.log.push(event);
    writeJsonAtomic(this.opts.statePath, this.state);
    appendNdjson(this.eventsPath(), event);
    this.writeMirror();
  }

  /** Human-readable mirror (like money/WORK-QUEUE.md). Rewritten, never deleted. */
  private writeMirror(): void {
    const file = this.mirrorPath();
    if (!file) {
      return;
    }
    const rows = this.state.items
      .map((it) => {
        const extra = it.blockedReason ? ` — blocked: ${it.blockedReason}` : "";
        const succ = it.successor ? ` → ${it.successor}` : "";
        return `- [${it.status}] ${it.id}: ${it.action}${succ}${extra}`;
      })
      .join("\n");
    const body =
      `<!-- @fork-seam U5 — generated mirror, do not edit by hand (source: work-queue.json) -->\n` +
      `# fork work-queue (never empty — every done item leaves a successor)\n\n${rows}\n`;
    writeTextAtomic(file, body);
  }

  private nextId(): string {
    return `wi-${this.state.items.length + 1}`;
  }

  add(action: string, id?: string): QueueItem {
    if (id && this.state.items.some((it) => it.id === id)) {
      throw new Error(`duplicate queue item id: ${id}`);
    }
    const at = this.nowIso();
    const item: QueueItem = {
      id: id ?? this.nextId(),
      status: "todo",
      action,
      createdAt: at,
      updatedAt: at,
    };
    this.state.items.push(item);
    this.persist({ at, kind: "add", id: item.id, detail: action });
    return item;
  }

  /** Top non-blocked, not-done item. Skips (never returns) blocked items. */
  next(): QueueItem | null {
    return this.state.items.find((it) => it.status === "todo") ?? null;
  }

  runnableCount(): number {
    return this.state.items.filter((it) => it.status === "todo").length;
  }

  claim(id: string): QueueItem {
    const item = this.require(id);
    item.status = "running";
    item.updatedAt = this.nowIso();
    this.persist({ at: item.updatedAt, kind: "claim", id });
    return item;
  }

  /**
   * Finish `id` and append its successor. The never-empty invariant: when no
   * successor is supplied one is synthesised from `fallbackAction`; with neither,
   * completion is refused (throw) rather than emptying the queue.
   */
  complete(id: string, successor?: QueueItem): QueueItem {
    const item = this.require(id);
    if (!successor && !this.opts.fallbackAction) {
      throw new EmptyQueueError(
        `complete(${id}) without a successor and no fallbackAction configured — refusing to empty the queue`,
      );
    }
    const at = this.nowIso();
    item.status = "done";
    item.updatedAt = at;

    const succ: QueueItem = successor
      ? { createdAt: at, updatedAt: at, status: "todo", ...successor }
      : {
          id: this.nextId(),
          status: "todo",
          action: this.opts.fallbackAction as string,
          createdAt: at,
          updatedAt: at,
        };
    if (this.state.items.some((it) => it.id === succ.id)) {
      throw new Error(`duplicate queue item id: ${succ.id}`);
    }
    item.successor = succ.id;
    this.state.items.push(succ);
    this.persist({ at, kind: "complete", id, detail: `successor=${succ.id}` });
    return succ;
  }

  block(id: string, reason: string): void {
    const item = this.require(id);
    item.status = "blocked";
    item.blockedReason = reason;
    item.updatedAt = this.nowIso();
    this.persist({ at: item.updatedAt, kind: "block", id, detail: reason });
  }

  unblock(id: string): void {
    const item = this.require(id);
    item.status = "todo";
    item.blockedReason = undefined;
    item.updatedAt = this.nowIso();
    this.persist({ at: item.updatedAt, kind: "unblock", id });
  }

  recordDefect(detail: string): void {
    this.persist({ at: this.nowIso(), kind: "defect", detail });
  }

  /** Fail-closed: an empty runnable set is a defect, recorded AND thrown. */
  assertNonEmpty(): void {
    if (this.runnableCount() === 0) {
      const detail = "runnable queue is EMPTY (defect) — next run must refill a successor";
      this.recordDefect(detail);
      throw new EmptyQueueError(detail);
    }
  }

  snapshot(): WorkQueueState {
    return this.state;
  }

  private require(id: string): QueueItem {
    const item = this.state.items.find((it) => it.id === id);
    if (!item) {
      throw new Error(`unknown queue item: ${id}`);
    }
    return item;
  }
}
