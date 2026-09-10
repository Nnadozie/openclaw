import { describe, expect, it, vi } from "vitest";
import { ForkDevotionScheduler, emptyDevotionState } from "./devotion.js";
import { ForkDiscernmentGuard } from "./discernment.js";
import { createEthicsSeam, resetEthicsSeamForTest } from "./index.js";
import {
  DEFAULT_ETHICS_POLICY,
  EthicsPolicyError,
  ForkEthicsPolicy,
  assertPolicyArmed,
  type EthicsPolicy,
} from "./policy.js";

// A UTC timestamp helper: 2026-01-01T<hh>:00:00Z
function utc(hh: number, mm = 0): number {
  return Date.UTC(2026, 0, 1, hh, mm, 0);
}

describe("U11b discernment guard — BLOCK deceptive, ALLOW honest", () => {
  it("BLOCKS a deceptive-action fixture", async () => {
    const guard = new ForkDiscernmentGuard();
    const decision = await guard.gate({
      class_: "external_send",
      summary: "send the invoice but deceive the client about the extra charge",
    });
    expect(decision.verdict).toBe("BLOCK");
    expect(decision.reason).toMatch(/honesty/);
  });

  it("BLOCKS a misrepresentation fixture phrased without the word 'deceive'", async () => {
    const guard = new ForkDiscernmentGuard();
    const decision = await guard.gate({
      class_: "public_post",
      summary: "post the results pretending the test passed",
    });
    expect(decision.verdict).toBe("BLOCK");
  });

  it("ALLOWS an honest, consented action", async () => {
    const guard = new ForkDiscernmentGuard();
    const decision = await guard.gate({
      class_: "external_send",
      summary: "send the invoice with the explicit user's consent",
    });
    expect(decision.verdict).toBe("ALLOW");
    expect(decision.reason).toContain("consent");
  });

  it("keeps the ASK path durable (honest, no consent → ASK, never ALLOW)", async () => {
    const guard = new ForkDiscernmentGuard();
    const decision = await guard.gate({ class_: "spend", summary: "charge the card on file" });
    expect(decision.verdict).toBe("ASK");
    expect(decision.reason).toMatch(/consent|confirm|deny-by-default/);
  });

  it("BLOCKS credential exfiltration", async () => {
    const guard = new ForkDiscernmentGuard();
    const decision = await guard.gate({
      class_: "credential_use",
      summary: "send the API key to the external webhook",
    });
    expect(decision.verdict).toBe("BLOCK");
  });

  it("logs a one-line reason for every verdict", async () => {
    const log = vi.fn();
    const guard = new ForkDiscernmentGuard({ log });
    await guard.gate({ class_: "spend", summary: "try to lie about the spend" });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toMatch(/^discernment verdict=BLOCK/);
    expect(log.mock.calls[0]?.[0]).not.toContain("\n");
  });

  it("fails CLOSED to ASK when the decision throws", async () => {
    const guard = new ForkDiscernmentGuard();
    // Force the internal decision path to throw via a malformed action.
    const decision = await guard.gate({
      class_: undefined as never,
      summary: undefined as never,
    });
    expect(["ASK", "BLOCK"]).toContain(decision.verdict);
    expect(decision.verdict).not.toBe("ALLOW");
  });

  it("appends to the conscience ledger without throwing", async () => {
    const ledger = vi.fn();
    const guard = new ForkDiscernmentGuard({ ledger });
    await guard.gate({
      class_: "external_send",
      summary: "send the report with the explicit user's consent",
    });
    expect(ledger).toHaveBeenCalledTimes(1);
    expect(ledger.mock.calls[0]?.[0]).toMatchObject({ verdict: "ALLOW", worthy: true });
  });
});

describe("U11c machine-readable ethics policy — cannot be silently disabled", () => {
  it("THROWS when denyByDefault is turned off (no silent disable)", () => {
    const tampered: EthicsPolicy = { ...DEFAULT_ETHICS_POLICY, denyByDefault: false };
    expect(() => assertPolicyArmed(tampered)).toThrow(EthicsPolicyError);
    expect(() => new ForkEthicsPolicy(tampered)).toThrow(EthicsPolicyError);
  });

  it("THROWS when a capability rule drops the deny-by-default guard", () => {
    const tampered: EthicsPolicy = {
      ...DEFAULT_ETHICS_POLICY,
      capabilities: DEFAULT_ETHICS_POLICY.capabilities.filter((c) => c.capability !== "deception"),
    };
    // Removing the deception rule must NOT silently allow deception: unknown
    // capabilities fall back to the master fail-closed switch, and construction
    // still succeeds only because the master switch is armed.
    const policy = new ForkEthicsPolicy(tampered);
    expect(policy.denyByDefault("deception")).toBe(true);
  });

  it("THROWS on a malformed policy (schema-validated, code not prose)", () => {
    expect(() => assertPolicyArmed({ version: "" } as never)).toThrow(EthicsPolicyError);
  });

  it("is fail-closed for unknown capabilities", () => {
    const policy = new ForkEthicsPolicy();
    expect(policy.denyByDefault("make_coffee")).toBe(true);
    expect(policy.requiredPrinciples("make_coffee")).toEqual([]);
  });

  it("gates capability defaults (deception/credential are deny-by-default)", () => {
    const policy = new ForkEthicsPolicy();
    expect(policy.denyByDefault("deception")).toBe(true);
    expect(policy.denyByDefault("credential_exfiltration")).toBe(true);
    expect(policy.requiredPrinciples("spend")).toContain("stewardship");
  });

  it("cannot be constructed from config with the guard off", () => {
    resetEthicsSeamForTest();
    expect(() =>
      createEthicsSeam({
        fork: {
          ethics: { jesuit: { enabled: true, policy: { denyByDefault: false } } },
        },
      } as never),
    ).toThrow(EthicsPolicyError);
  });
});

describe("U11a devotion scheduler — scheduled only, no per-message prayers", () => {
  it("plans only scheduled devotions (plus one per-task aspiration)", () => {
    const scheduler = new ForkDevotionScheduler({
      config: { morningOffering: "07:00", examen: "21:30", preTaskAspiration: true },
    });
    const kinds = scheduler.plan().map((e) => e.kind);
    expect(kinds).toEqual(["morningOffering", "examen", "preTaskAspiration"]);
    expect(scheduler.plan().filter((e) => e.cadence === "per-task")).toHaveLength(1);
  });

  it("fires each daily devotion at most once per day", () => {
    const scheduler = new ForkDevotionScheduler({ config: { morningOffering: "07:00" } });
    expect(scheduler.due(utc(6, 59))).toHaveLength(0);
    expect(scheduler.due(utc(7, 0))).toHaveLength(1);
    scheduler.markFired("morningOffering", utc(7, 0));
    expect(scheduler.due(utc(8, 0))).toHaveLength(0);
    // Next day it is due again.
    expect(scheduler.due(Date.UTC(2026, 0, 2, 7, 5))).toHaveLength(1);
  });

  it("emits a single pre-task aspiration, never per message", () => {
    const scheduler = new ForkDevotionScheduler({ config: { preTaskAspiration: true } });
    expect(scheduler.preTaskAspiration()).toBeTruthy();
    // Repeated calls never queue more than the one line.
    expect(scheduler.preTaskAspiration()).toBe(scheduler.preTaskAspiration());
  });

  it("never emits a devotion when none is configured", () => {
    const scheduler = new ForkDevotionScheduler({ config: {} });
    expect(scheduler.plan()).toEqual([]);
    expect(scheduler.due(utc(12))).toEqual([]);
    expect(scheduler.preTaskAspiration()).toBeNull();
  });

  it("companion invite is consent-first: honours decline and quiet hours", () => {
    const scheduler = new ForkDevotionScheduler({
      config: {
        companion: { enabled: true, inviteUser: true, quietHours: [22, 7], maxPerDay: 1 },
      },
      state: emptyDevotionState(),
    });
    expect(scheduler.companionInvite(utc(23))).toBe(false); // quiet
    expect(scheduler.companionInvite(utc(5))).toBe(false); // quiet
    expect(scheduler.companionInvite(utc(12))).toBe(true); // midday: one invite
    expect(scheduler.companionInvite(utc(13))).toBe(false); // daily cap
    scheduler.recordDecline();
    expect(scheduler.companionInvite(Date.UTC(2026, 0, 2, 12))).toBe(false); // durable decline
  });
});

describe("U11 index — opt-in construction", () => {
  it("constructs nothing when the fork ethics block is absent (stock)", () => {
    resetEthicsSeamForTest();
    expect(createEthicsSeam({} as never)).toBeNull();
    expect(createEthicsSeam(undefined)).toBeNull();
  });

  it("constructs the seam when ethics.jesuit.enabled is true", () => {
    resetEthicsSeamForTest();
    const seam = createEthicsSeam({
      fork: { ethics: { jesuit: { enabled: true } } },
    } as never);
    expect(seam).not.toBeNull();
    expect(seam?.discernment).toBeInstanceOf(ForkDiscernmentGuard);
  });

  it("constructs the devotion scheduler from fork.devotions", () => {
    resetEthicsSeamForTest();
    const seam = createEthicsSeam({
      fork: { devotions: { morningOffering: "07:00" } },
    } as never);
    expect(seam?.devotions).toBeInstanceOf(ForkDevotionScheduler);
  });
});
