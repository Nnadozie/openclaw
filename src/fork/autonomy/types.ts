// @fork-seam U5 — anti-silence autonomy: typed contracts.
//
// Additive seam. It NEVER replaces stock cron/heartbeat (`src/cron/*`) or the
// run-loop. It adds a durable work-queue with a never-empty invariant, a driver
// that advances the top non-blocked item, and a watchdog that detects stalls and
// re-kicks. Stock OpenClaw never imports this module; the fork wires it from a
// heartbeat-task / cron when the additive `fork.autonomy` block is present
// (opt-in, fail-closed — ADR-U5-1/2/3/4).
//
// See design/05-anti-silence-autonomy.md.

/** Lifecycle of a queue item. */
export type QueueStatus = "todo" | "running" | "blocked" | "done";

/**
 * One unit of work. `successor` is the id of the item appended when this one
 * completes — the never-empty invariant (every finished action leaves a child).
 */
export interface QueueItem {
  id: string;
  status: QueueStatus;
  action: string;
  /** Id of the successor created on completion (never-empty invariant). */
  successor?: string;
  blockedReason?: string;
  unblockWhen?: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Append-only queue event (NO-DELETE). The log is rewritten with the state and
 * mirrored to a sibling `.events.ndjson`, but entries are never mutated/removed.
 */
export interface QueueEvent {
  at: string;
  kind: "add" | "claim" | "complete" | "block" | "unblock" | "defect";
  id?: string;
  detail?: string;
}

/** Canonical, on-disk queue state (`fork/work-queue.json`). */
export interface WorkQueueState {
  version: 1;
  items: QueueItem[];
  log: QueueEvent[];
}

export interface WorkQueueOptions {
  /** Path to `work-queue.json`; omit for a purely in-memory queue (tests). */
  statePath?: string;
  /**
   * Action text for the successor synthesised by `complete()` when the caller
   * supplies none. Absent => completing without a successor is a hard error
   * (never-empty invariant).
   */
  fallbackAction?: string;
  /** Injected clock (ms epoch) for deterministic tests. */
  now?: () => number;
}

/**
 * The U5 queue seam. `next()` never returns a blocked item; `complete()` always
 * leaves a successor, so the runnable set is only ever empty by defect.
 */
export interface ForkWorkQueueSeam {
  add(action: string, id?: string): QueueItem;
  next(): QueueItem | null;
  complete(id: string, successor?: Partial<QueueItem> & { id: string; action: string }): QueueItem;
  block(id: string, reason: string): void;
  unblock(id: string): void;
  assertNonEmpty(): void;
  /** Count of `todo` items (the runnable set). */
  runnableCount(): number;
  claim(id: string): QueueItem;
  recordDefect(detail: string): void;
  snapshot(): WorkQueueState;
}

/** Durable driver state (`fork/driver-state.json`). */
export interface DriverState {
  lastActionId?: string;
  /** ISO timestamp of the last successful advance — the watchdog's clock. */
  lastAdvanceAt?: string;
  lastMeasured?: string;
  advancedCount: number;
  blockedCount: number;
  defectCount: number;
}

export type DriverOutcome =
  | { kind: "advanced"; item: QueueItem; measured: string }
  | { kind: "blocked"; item: QueueItem; reason: string }
  | { kind: "empty"; defect: string };

/** The U5 driver seam: read state → act → measure → update state. */
export interface ForkDriverSeam {
  advance(): Promise<DriverOutcome>;
  state(): DriverState;
}

export interface WatchdogConfig {
  enabled: boolean;
  /** No advance within this window (ms) => stalled. */
  stallMs: number;
}

export type WatchdogStatus =
  | { kind: "ok"; detail: string }
  | { kind: "empty-queue"; detail: string }
  | { kind: "driver-disabled"; detail: string }
  | { kind: "stalled"; stalledForMs: number; itemId?: string; detail: string };

/** The U5 watchdog seam: stall / disabled-driver / empty-queue detection. */
export interface ForkWatchdogSeam {
  check(): WatchdogStatus;
}

/** One heartbeat initiative: what the re-pointed heartbeat task did this tick. */
export type HeartbeatTick =
  | { kind: "advanced"; itemId: string; measured: string }
  | { kind: "refilled"; defect: string }
  | { kind: "idle"; detail: string };

/** Additive `fork.autonomy` config block. */
export interface AutonomyConfig {
  /** Defaults to true when the block is present; set false to keep it dormant. */
  enabled?: boolean;
  queuePath?: string;
  driverStatePath?: string;
  /** Action text for the synthesised successor (never-empty invariant). */
  refillAction?: string;
  watchdog?: { enabled?: boolean; stallMs?: number };
}
