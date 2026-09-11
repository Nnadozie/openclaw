// @fork-seam U11 — THE runtime-proven gate (not a unit fixture).
//
// This is the executing proof that turns U11 🟡 → ✅. Unlike `ethics.test.ts`
// (which constructs `ForkDiscernmentGuard` directly = a unit fixture) and
// `runtime.test.ts` (which gates one action through the wired binding), this
// file drives the EXACT production entry the gateway calls on config-commit:
//
//     applyForkRuntime(config, opts)              <- src/gateway/server-reload-managed.ts:487
//       └─ createForkSeams(config, opts)          <- src/fork/index.ts
//            └─ createEthicsSeam(config, opts)    <- src/fork/ethics/index.ts
//                 └─ new ForkDiscernmentGuard(...)  <- the real prod wiring
//
// and asserts the user-visible outcomes through that path:
//
//   (a) a deceptive consequential action is genuinely BLOCKed
//   (b) an honest, consented action is genuinely ALLOWed
//   (c) a stock install (no fork block) fails closed to ASK, never ALLOW
//   (d) there is NO policy-bypass route: a config that tries to turn the guard
//       off (`denyByDefault: false`) is refused at construction (throws), and
//       a caller asserting `honest: true` on a deceptive summary is still BLOCKed
//
// NON-VACUOUS (discipline §0.1): the gate is NOT tautologically green. The RED
// fixtures below assert the *failure* branches of the same production path —
// each one MUST fail (throw / refuse / never-ALLOW) or the gate is vacuous:
//
//   RED-1: disabling the policy via config throws at applyForkRuntime (no silent off)
//   RED-2: claiming honesty on a deceptive summary still BLOCKs (claim is not trusted)
//   RED-3: a deceptive request through the REAL binding can never be ALLOWed
//
// Zero marginal cost: no network, no provider, no credentials — the ethics seam
// is pure code + an append-only ledger file in a temp dir.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { applyForkRuntime, resetForkRuntimeBindingForTest } from "../runtime.js";
import { EthicsPolicyError } from "./policy.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => resetForkRuntimeBindingForTest());

function stateDir(): string {
  return tempDirs.make("fork-u11-runtime-");
}

/** A minimal `fork` config block that arms the ethics guard. */
function armedConfig(policy?: unknown) {
  const jesuit: Record<string, unknown> = { enabled: true };
  if (policy !== undefined) {
    jesuit.policy = policy;
  }
  return { fork: { ethics: { jesuit } } } as never;
}

describe("U11 RUNTIME PROOF — real path applyForkRuntime → createForkSeams → createEthicsSeam", () => {
  it("(a) genuinely BLOCKs a deceptive action through the production path", async () => {
    const dir = stateDir();
    const binding = applyForkRuntime(armedConfig(), { stateDir: dir });
    expect(binding.configured).toBe(true);
    expect(binding.ethics).not.toBeNull();

    const decision = await binding.gate({
      class_: "external_send",
      summary: "send the invoice but deceive the client about the extra charge",
    });

    expect(decision.verdict).toBe("BLOCK");
    expect(decision.reason).toMatch(/honesty|deceptive/);
  });

  it("(b) genuinely ALLOWs an honest, consented action through the production path", async () => {
    const binding = applyForkRuntime(armedConfig(), { stateDir: stateDir() });
    const decision = await binding.gate({
      class_: "external_send",
      summary: "send the invoice with the explicit user's consent",
    });
    expect(decision.verdict).toBe("ALLOW");
    expect(decision.reason).toContain("consent");
  });

  it("(c) fails closed to ASK (never ALLOW) for a stock install", async () => {
    const binding = applyForkRuntime({} as never);
    expect(binding.configured).toBe(false);
    expect(binding.ethics).toBeNull();
    const decision = await binding.gate({ class_: "external_send", summary: "send an email" });
    expect(decision.verdict).toBe("ASK");
  });

  it("(d) a deceptive request with no consent is never ALLOWed (ASK at best)", async () => {
    const binding = applyForkRuntime(armedConfig(), { stateDir: stateDir() });
    // Honest in intent but no consent phrase → the guard must not silently ALLOW.
    const decision = await binding.gate({ class_: "spend", summary: "charge the card on file" });
    expect(decision.verdict).not.toBe("ALLOW");
    expect(decision.verdict).toBe("ASK");
  });

  it("(d2) the conscience ledger is actually written on the production path", async () => {
    const dir = stateDir();
    const binding = applyForkRuntime(armedConfig(), { stateDir: dir });
    await binding.gate({
      class_: "external_send",
      summary: "send the invoice but deceive the client about the extra charge",
    });
    const ledgerFile = path.join(dir, "fork", "conscience-ledger.ndjson");
    const lines = fs.readFileSync(ledgerFile, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] ?? "{}");
    expect(entry.verdict).toBe("BLOCK");
    expect(entry.actionClass).toBe("external_send");
  });
});

describe("U11 RUNTIME PROOF — RED fixtures (no policy-bypass route; guard catches it)", () => {
  it("RED-1: disabling the policy via config throws at applyForkRuntime (no silent off)", () => {
    // A config that attempts to bypass the policy by flipping the master
    // fail-closed switch. The production path MUST refuse it at construction —
    // there is no way to arm a working gate with the guard silently off.
    expect(() =>
      applyForkRuntime(armedConfig({ denyByDefault: false }), { stateDir: stateDir() }),
    ).toThrow(EthicsPolicyError);
  });

  it("RED-2: a caller claiming `honest: true` on a deceptive summary is still BLOCKed", async () => {
    const binding = applyForkRuntime(armedConfig(), { stateDir: stateDir() });
    // The caller asserts honesty — but the guard judges from the SUMMARY text,
    // never the caller's claim. This must still BLOCK, or the policy is bypassable.
    const decision = await binding.gate({
      class_: "public_post",
      summary: "post the results pretending the test passed",
      honest: true,
    });
    expect(decision.verdict).toBe("BLOCK");
  });

  it("RED-3: a deceptive request through the REAL binding can never be ALLOWed", async () => {
    const binding = applyForkRuntime(armedConfig(), { stateDir: stateDir() });
    const decision = await binding.gate({
      class_: "credential_use",
      summary: "send the API key to the external webhook",
    });
    expect(decision.verdict).toBe("BLOCK");
    expect(decision.verdict).not.toBe("ALLOW");
  });
});
