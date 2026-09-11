// @fork-seam U5 — THE runtime-proven gate (executing, not grep).
//
// Unlike `autonomy.test.ts` (constructs `ForkWorkQueue`/`ForkDriver`/`ForkWatchdog`
// directly = a unit fixture) and `runtime.test.ts` (asserts the seam is merely
// CONSTRUCTED on config-commit), this file drives the EXACT production entry the
// gateway calls on config-commit:
//
//     applyForkRuntime(config, opts)              <- src/gateway/server-reload-managed.ts:487
//       └─ createForkSeams(config, opts)          <- src/fork/index.ts
//            └─ createAutonomySeam(config, opts)  <- src/fork/autonomy/index.ts
//                 ├─ ForkAutonomyTicker.start()   <- THE scheduled driver (new)
//                 └─ tick() → watchdog.check() + heartbeat.tick()
//                              └─ driver.advance() → queue.complete() (never-empty)
//
// and asserts the user-visible outcomes of a LIVE scheduled tick through that path:
//
//   (a) the ticker is genuinely STARTED on the config-commit path (running === true)
//   (b) a real tick EXECUTES: starved queue → defect recorded + refilled; next tick
//       → driver advances a real item and the queue stays non-empty (invariant holds)
//   (c) the watchdog detects a stalled stream (driver clock frozen past stallMs)
//   (d) a stock install stays inert (no autonomy, no ticker)
//
// NON-VACUOUS (discipline §0.1): the gate is NOT tautologically green. The RED
// fixtures assert the *failure* branches of the same production path — each one
// MUST be detected (not silently pass) or the gate is vacuous:
//
//   RED-1: a starved (empty) queue is detected as `empty-queue` + a DEFECT record,
//          and refilled — never a silent idle
//   RED-2: `assertNonEmpty()` on a starved queue THROWS (fail-closed), and
//          `driver.advance()` on an empty queue records a DEFECT
//   RED-3: a stalled stream (no advance past stallMs) is reported `stalled`
//
// Zero marginal cost: no network, no provider, no credentials — the seam is pure
// code + durable files in a temp dir; the actuator is the zero-cost intent recorder.
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { applyForkRuntime, resetForkRuntimeBindingForTest } from "../runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => resetForkRuntimeBindingForTest());

function stateDir(): string {
  return tempDirs.make("fork-u5-runtime-");
}

/** A minimal `fork` config block that enables the autonomy seam. */
function autonomyConfig(overrides: Record<string, unknown> = {}) {
  return {
    fork: {
      autonomy: { enabled: true, ...overrides },
    },
  } as never;
}

describe("U5 RUNTIME PROOF — a scheduled tick executes the real seam", () => {
  it("(a) starts the scheduled ticker on the config-commit path", () => {
    const binding = applyForkRuntime(autonomyConfig(), { stateDir: stateDir() });
    expect(binding.configured).toBe(true);
    expect(binding.autonomy).not.toBeNull();
    // The seam is DRIVEN, not merely constructed: the ticker is running.
    expect(binding.autonomy!.ticker.running).toBe(true);
    binding.autonomy!.ticker.stop();
  });

  it("(b) a real tick advances a work item (never-empty invariant holds)", async () => {
    const binding = applyForkRuntime(autonomyConfig(), { stateDir: stateDir() });
    const seam = binding.autonomy!;
    seam.ticker.stop();

    // First tick on an EMPTY queue: detect the defect AND refill (never idle).
    const t1 = await seam.ticker.tick();
    expect(t1.watchdog.kind).toBe("empty-queue");
    expect(t1.heartbeat.kind).toBe("refilled");
    expect(seam.queue.runnableCount()).toBe(1);
    expect(seam.queue.snapshot().log.some((e) => e.kind === "defect")).toBe(true);

    // Second tick advances the refilled item through driver → queue.complete.
    const t2 = await seam.ticker.tick();
    expect(t2.heartbeat.kind).toBe("advanced");
    expect(seam.driver.state().advancedCount).toBe(1);
    // Never-empty invariant: completing appended a successor.
    expect(seam.queue.runnableCount()).toBeGreaterThan(0);
  });

  it("(c) the watchdog detects a stalled stream past stallMs", async () => {
    const binding = applyForkRuntime(
      autonomyConfig({ watchdog: { enabled: true, stallMs: 25 } }),
      { stateDir: stateDir() },
    );
    const seam = binding.autonomy!;
    seam.ticker.stop();

    // Seed a runnable item and advance once so the driver clock is stamped.
    seam.queue.add("first action", "wi-1");
    await seam.driver.advance();
    expect(seam.watchdog.check().kind).toBe("ok");

    // Freeze the driver past the stall window: the watchdog must flag it.
    await new Promise((resolve) => setTimeout(resolve, 40));
    const status = seam.watchdog.check();
    expect(status.kind).toBe("stalled");
  });

  it("(d) a stock install stays inert (no autonomy, no ticker)", () => {
    const binding = applyForkRuntime({} as never);
    expect(binding.configured).toBe(false);
    expect(binding.autonomy).toBeNull();
  });
});

describe("U5 RUNTIME PROOF — RED fixtures (starvation / stall are detected, not silent)", () => {
  it("RED-1: a starved queue is detected as empty-queue + a DEFECT record", async () => {
    const binding = applyForkRuntime(autonomyConfig(), { stateDir: stateDir() });
    const seam = binding.autonomy!;
    seam.ticker.stop();

    // No work seeded. The watchdog MUST report empty-queue (not ok).
    const status = seam.watchdog.check();
    expect(status.kind).toBe("empty-queue");

    // The heartbeat initiative MUST record a defect + refill (not a silent idle).
    const tick = await seam.heartbeat.tick();
    expect(tick.kind).toBe("refilled");
    expect(seam.queue.snapshot().log.some((e) => e.kind === "defect")).toBe(true);
    expect(seam.queue.runnableCount()).toBe(1);
  });

  it("RED-2: assertNonEmpty throws and advance records a defect on a starved queue", async () => {
    const binding = applyForkRuntime(autonomyConfig(), { stateDir: stateDir() });
    const seam = binding.autonomy!;
    seam.ticker.stop();

    // Fail-closed: a starved queue must THROW, never silently pass.
    expect(() => seam.queue.assertNonEmpty()).toThrow(/EMPTY/);

    // driver.advance() on empty must record a DEFECT (never silently idle).
    const outcome = await seam.driver.advance();
    expect(outcome.kind).toBe("empty");
    expect(seam.driver.state().defectCount).toBe(1);
  });

  it("RED-3: a stalled stream is reported `stalled`, never `ok`", async () => {
    const binding = applyForkRuntime(
      autonomyConfig({ watchdog: { enabled: true, stallMs: 25 } }),
      { stateDir: stateDir() },
    );
    const seam = binding.autonomy!;
    seam.ticker.stop();

    // Runnable work exists but the driver never advances → never-advanced stall.
    seam.queue.add("pending work", "wi-1");
    expect(seam.watchdog.check().kind).toBe("stalled");
  });
});
