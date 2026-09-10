import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ForkDriver } from "./driver.js";
import { ForkHeartbeatInitiative } from "./heartbeat.js";
import { EmptyQueueError, ForkWorkQueue, createAutonomySeam } from "./index.js";
import { ForkWatchdog } from "./watchdog.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fork-u5-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const queuePath = () => path.join(dir, "work-queue.json");
const driverPath = () => path.join(dir, "driver-state.json");

function makeQueue(fallbackAction = "keep going"): ForkWorkQueue {
  return new ForkWorkQueue({ statePath: queuePath(), fallbackAction });
}

describe("U5 work-queue — never-empty invariant", () => {
  it("completing an item ALWAYS leaves a successor", () => {
    const q = makeQueue();
    q.add("first", "wi-1");
    for (let i = 0; i < 3; i++) {
      const head = q.next();
      expect(head).not.toBeNull();
      const succ = q.complete(head!.id);
      expect(succ.status).toBe("todo");
      expect(q.runnableCount()).toBeGreaterThan(0);
    }
    // After N completions the queue is still non-empty (successor chain).
    expect(() => q.assertNonEmpty()).not.toThrow();
    expect(q.runnableCount()).toBe(1);
    expect(q.snapshot().items.filter((it) => it.status === "done")).toHaveLength(3);
  });

  it("REFUSES to complete without a successor when no fallback is configured", () => {
    const q = new ForkWorkQueue({ statePath: queuePath() });
    q.add("only", "wi-1");
    expect(() => q.complete("wi-1")).toThrow(EmptyQueueError);
    // The item is untouched — refusing rather than emptying the queue.
    expect(q.next()?.id).toBe("wi-1");
  });

  it("cannot be emptied: assertNonEmpty throws + records a defect", () => {
    const q = makeQueue(); // no items
    expect(() => q.assertNonEmpty()).toThrow(EmptyQueueError);
    const defects = q.snapshot().log.filter((e) => e.kind === "defect");
    expect(defects).toHaveLength(1);
  });

  it("appends a successor supplied by the caller, keeping ids unique", () => {
    const q = makeQueue();
    q.add("first", "wi-1");
    const succ = q.complete("wi-1", { id: "wi-next", action: "second" });
    expect(succ.id).toBe("wi-next");
    expect(q.next()?.id).toBe("wi-next");
  });

  it("is durable: reload from disk keeps items + log intact (NO-DELETE)", () => {
    const q = makeQueue();
    q.add("persisted", "wi-1");
    q.claim("wi-1");
    const reloaded = new ForkWorkQueue({ statePath: queuePath(), fallbackAction: "x" });
    expect(reloaded.snapshot().items).toHaveLength(1);
    expect(reloaded.snapshot().items[0].status).toBe("running");
    expect(reloaded.snapshot().log.length).toBeGreaterThan(0);
  });
});

describe("U5 driver — advances the top non-blocked item", () => {
  it("picks the top non-blocked item, skipping a blocked head", async () => {
    const q = makeQueue();
    q.add("blocked-head", "wi-1");
    q.add("runnable", "wi-2");
    q.block("wi-1", "waiting on Dozie");
    const driver = new ForkDriver(q, { statePath: driverPath() });
    const outcome = await driver.advance();
    expect(outcome.kind).toBe("advanced");
    if (outcome.kind === "advanced") {
      expect(outcome.item.id).toBe("wi-2");
    }
    // head stayed blocked, never returned by next()
    expect(q.snapshot().items.find((i) => i.id === "wi-1")?.status).toBe("blocked");
  });

  it("stamps the clock and increments the counter on a real advance", async () => {
    const q = makeQueue();
    q.add("do it", "wi-1");
    let t = 1_000_000;
    const driver = new ForkDriver(q, { statePath: driverPath(), now: () => t });
    const outcome = await driver.advance();
    expect(outcome.kind).toBe("advanced");
    expect(driver.state().advancedCount).toBe(1);
    expect(driver.state().lastAdvanceAt).toBe(new Date(t).toISOString());
  });

  it("records a defect (never silently idles) when nothing is runnable", async () => {
    const q = new ForkWorkQueue({ statePath: queuePath() });
    const driver = new ForkDriver(q, { statePath: driverPath() });
    const outcome = await driver.advance();
    expect(outcome.kind).toBe("empty");
    expect(driver.state().defectCount).toBe(1);
    expect(q.snapshot().log.some((e) => e.kind === "defect")).toBe(true);
  });

  it("blocks an item whose actuator throws, and keeps the queue runnable", async () => {
    const q = makeQueue();
    q.add("fragile", "wi-1");
    const driver = new ForkDriver(q, {
      statePath: driverPath(),
      actuate: async () => {
        throw new Error("upstream 503");
      },
    });
    const outcome = await driver.advance();
    expect(outcome.kind).toBe("blocked");
    expect(q.snapshot().items.find((i) => i.id === "wi-1")?.blockedReason).toBe("upstream 503");
    expect(q.runnableCount()).toBe(0); // blocked is not runnable
  });
});

describe("U5 watchdog — detects stall / disabled-driver / empty-queue", () => {
  function build(nowRef: { t: number }, stallMs = 30 * 60 * 1000) {
    const q = makeQueue();
    const driver = new ForkDriver(q, { statePath: driverPath(), now: () => nowRef.t });
    const watchdog = new ForkWatchdog(q, driver, {
      config: { enabled: true, stallMs },
      now: () => nowRef.t,
    });
    return { q, driver, watchdog };
  }

  it("reports stalled when the driver has never advanced despite runnable work", () => {
    const nowRef = { t: 10_000 };
    const { q, watchdog } = build(nowRef);
    q.add("work", "wi-1");
    const status = watchdog.check();
    expect(status.kind).toBe("stalled");
  });

  it("detects a stall after the clock freezes past stallMs", async () => {
    const nowRef = { t: 1_000_000 };
    const { q, driver, watchdog } = build(nowRef, 60_000);
    q.add("first", "wi-1");
    await driver.advance(); // stamps lastAdvanceAt = now
    expect(watchdog.check().kind).toBe("ok");
    nowRef.t += 61_000; // freeze the driver, pass the window
    const status = watchdog.check();
    expect(status.kind).toBe("stalled");
    if (status.kind === "stalled") {
      expect(status.stalledForMs).toBe(61_000);
      expect(status.itemId).toBeDefined();
    }
  });

  it("reports empty-queue as a defect (not a silent idle)", () => {
    const nowRef = { t: 1 };
    const { watchdog } = build(nowRef);
    expect(watchdog.check().kind).toBe("empty-queue");
  });

  it("reports driver-disabled / watchdog-off honestly", () => {
    const nowRef = { t: 1 };
    const q = makeQueue();
    const driver = new ForkDriver(q, { statePath: driverPath() });
    const watchdog = new ForkWatchdog(q, driver, {
      config: { enabled: false, stallMs: 1 },
    });
    expect(watchdog.check().kind).toBe("driver-disabled");
  });
});

describe("U5 heartbeat — takes initiative from the queue", () => {
  it("advances a real item when the queue is non-empty (never an idle ping)", async () => {
    const q = makeQueue();
    q.add("real work", "wi-1");
    const driver = new ForkDriver(q, { statePath: driverPath() });
    const hb = new ForkHeartbeatInitiative(q, driver, { refillAction: "refill" });
    const tick = await hb.tick();
    expect(tick.kind).toBe("advanced");
    expect(driver.state().advancedCount).toBe(1);
  });

  it("records the defect AND refills when the queue is empty", async () => {
    const q = makeQueue();
    const driver = new ForkDriver(q, { statePath: driverPath() });
    const hb = new ForkHeartbeatInitiative(q, driver, { refillAction: "refill-me" });
    const tick = await hb.tick();
    expect(tick.kind).toBe("refilled");
    expect(q.runnableCount()).toBe(1);
    expect(q.snapshot().log.some((e) => e.kind === "defect")).toBe(true);
  });
});

describe("U5 index — opt-in construction", () => {
  it("constructs nothing when fork.autonomy is absent (stock)", () => {
    expect(createAutonomySeam({} as never, { stateDir: dir })).toBeNull();
  });

  it("constructs nothing when fork.autonomy.enabled is false", () => {
    const config = { fork: { autonomy: { enabled: false } } };
    expect(createAutonomySeam(config as never, { stateDir: dir })).toBeNull();
  });

  it("constructs the seam (queue/driver/watchdog/heartbeat) when enabled", () => {
    const config = { fork: { autonomy: { enabled: true } } };
    const seam = createAutonomySeam(config as never, { stateDir: dir });
    expect(seam).not.toBeNull();
    expect(seam!.queue).toBeInstanceOf(ForkWorkQueue);
    expect(seam!.driver).toBeInstanceOf(ForkDriver);
    expect(seam!.watchdog).toBeInstanceOf(ForkWatchdog);
    expect(seam!.heartbeat).toBeInstanceOf(ForkHeartbeatInitiative);
  });
});
