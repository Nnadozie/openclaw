// @fork-seam U11c — machine-readable ethics policy (Jesuit grounding).
//
// The policy is CODE, not prose (charter U11c): it gates capability defaults and
// cannot be silently disabled. Any attempt to run with the guard off must carry
// an explicit, audited override; otherwise the guard stays ON (fail-closed).
//
// Principles: honesty, consent, dignity, subsidiarity, common good, stewardship.
import { z } from "zod";

export const ETHICS_VERSION = "1.0.0";

/** The six grounding principles (charter U11c). */
export const ETHICS_PRINCIPLES = [
  "honesty",
  "consent",
  "dignity",
  "subsidiarity",
  "commonGood",
  "stewardship",
] as const;

export type EthicsPrinciple = (typeof ETHICS_PRINCIPLES)[number];

/** A capability whose default is gated by the policy. */
export interface CapabilityRule {
  capability: string;
  /** When true, the capability is denied unless a principle explicitly allows it. */
  denyByDefault: boolean;
  /** Principles that must hold for the capability to be permitted at all. */
  requires: EthicsPrinciple[];
}

/**
 * Machine-readable policy document. `denyByDefault` is the master switch: when
 * on, unknown/ungated capabilities are denied (fail-closed).
 */
export interface EthicsPolicy {
  version: string;
  /** Master fail-closed switch; MUST be true for the guard to be considered armed. */
  denyByDefault: boolean;
  principles: Record<EthicsPrinciple, string>;
  capabilities: CapabilityRule[];
}

export const EthicsPolicySchema = z.strictObject({
  version: z.string().min(1),
  denyByDefault: z.boolean(),
  principles: z.record(z.enum(ETHICS_PRINCIPLES), z.string()),
  capabilities: z.array(
    z.strictObject({
      capability: z.string().min(1),
      denyByDefault: z.boolean(),
      requires: z.array(z.enum(ETHICS_PRINCIPLES)),
    }),
  ),
});

/** The shipped default policy. Deception is deny-by-default everywhere. */
export const DEFAULT_ETHICS_POLICY: EthicsPolicy = {
  version: ETHICS_VERSION,
  denyByDefault: true,
  principles: {
    honesty: "Speak and act truthfully; never deceive, mislead, or forge.",
    consent: "Act only with the informed consent of the person affected.",
    dignity: "Treat every person as an end, never merely as a means.",
    subsidiarity: "Do not override a person's own judgement without cause.",
    commonGood: "Weigh the good of the whole, not only the immediate party.",
    stewardship: "Preserve and account for what is entrusted (money, data, systems).",
  },
  capabilities: [
    { capability: "external_send", denyByDefault: false, requires: ["consent", "honesty"] },
    { capability: "spend", denyByDefault: false, requires: ["stewardship", "consent"] },
    { capability: "destructive", denyByDefault: false, requires: ["stewardship", "subsidiarity"] },
    { capability: "irreversible", denyByDefault: false, requires: ["stewardship", "subsidiarity"] },
    { capability: "deception", denyByDefault: true, requires: ["honesty"] },
    { capability: "credential_exfiltration", denyByDefault: true, requires: ["stewardship"] },
  ],
};

/** Thrown when the policy is malformed or an override attempts to silence the guard. */
export class EthicsPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EthicsPolicyError";
  }
}

/**
 * Assert a policy can be armed. Fail-closed means an invalid or deny-by-default-
 * disabled master policy is rejected outright: the guard can never silently
 * become a no-op.
 */
export function assertPolicyArmed(policy: EthicsPolicy): void {
  const parsed = EthicsPolicySchema.safeParse(policy);
  if (!parsed.success) {
    throw new EthicsPolicyError(
      `ethics policy is malformed: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
  }
  if (policy.denyByDefault !== true) {
    throw new EthicsPolicyError(
      "ethics policy denyByDefault must be true (the guard cannot be silently disabled)",
    );
  }
}

/**
 * The policy gate. `denyByDefault(capability)` is true when the capability is
 * unknown or explicitly deny-by-default. Always armed: constructing it with a
 * non-fail-closed policy throws.
 */
export class ForkEthicsPolicy {
  private readonly policy: EthicsPolicy;

  constructor(policy: EthicsPolicy = DEFAULT_ETHICS_POLICY) {
    assertPolicyArmed(policy);
    this.policy = policy;
  }

  get version(): string {
    return this.policy.version;
  }

  /** The raw rule for a capability, or undefined when the capability is unknown. */
  ruleFor(capability: string): CapabilityRule | undefined {
    return this.policy.capabilities.find((c) => c.capability === capability);
  }

  /** True when the capability must be denied absent an explicit allow. */
  denyByDefault(capability: string): boolean {
    const rule = this.policy.capabilities.find((c) => c.capability === capability);
    if (!rule) {
      // Unknown capability → fail-closed.
      return this.policy.denyByDefault;
    }
    return rule.denyByDefault;
  }

  /** The principles a capability must satisfy, or an empty list when unknown. */
  requiredPrinciples(capability: string): EthicsPrinciple[] {
    return this.policy.capabilities.find((c) => c.capability === capability)?.requires ?? [];
  }
}
