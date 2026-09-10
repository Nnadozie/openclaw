// @fork-seam U11b — discernment guard (ALLOW | ASK | BLOCK).
//
// The guard is a pre-action admission check for CONSEQUENTIAL actions. It is
// ADDITIVE and FAIL-CLOSED: if the policy is missing, malformed, or the check
// itself throws, the verdict is ASK (never ALLOW). It never weakens upstream
// safety — it only ever adds friction.
//
// Charter tests (design/11 §10):
//   • BLOCKs a deceptive-action fixture
//   • ALLOWs an honest one
//   • ASK path is durable (returned, not swallowed)
import {
  DEFAULT_ETHICS_POLICY,
  ForkEthicsPolicy,
  type CapabilityRule,
  type EthicsPolicy,
} from "./policy.js";
import type { ConsequentialActionClass, DiscernmentDecision, GatedAction } from "./types.js";

/** Map an action class to the policy capability that gates it. */
const ACTION_TO_CAPABILITY: Readonly<Record<ConsequentialActionClass, string>> = {
  external_send: "external_send",
  spend: "spend",
  destructive: "destructive",
  irreversible: "irreversible",
  public_post: "external_send",
  credential_use: "credential_exfiltration",
};

/** Signals in a summary that mark an action as deceptive (deny-by-default). */
const DECEPTION_MARKERS: readonly RegExp[] = [
  /\b(deceiv\w*|decept\w*|misle[a-z]*|lying|lie|fib\w*|forge\w*|fabricat\w*|falsif\w*|falsified)\b/i,
  /\b(impersonat\w*|disguis\w*|spoof\w*|phish\w*|scam\w*|fraud\w*|cover[\s-]?up|misrepresent\w*)\b/i,
  /\bwithout\s+(telling|informing|consent|permission|disclosing)\b/i,
  /\b(pretend\w*|posing?\s+as|pose\s+as|pass\w*\s+off|fake)\b/i,
];

/** Signals that this is a credential-moving action. */
const EXFIL_MARKERS: readonly RegExp[] = [
  /\b(exfiltrat|leak|dump|send|upload|post|transmit|share)[\s\S]{0,40}\b(key|token|secret|credential|password|passwd|pat|api[\s_-]?key)\b/i,
  /\b(key|token|secret|credential|password)\b[\s\S]{0,40}\b(to|into|via)\b[\s\S]{0,30}\b(http|webhook|pastebin|gist|external|third[\s-]?party)\b/i,
];

/** A phrase that explicitly carries consent. */
const CONSENT_PHRASE =
  /\b(with\s+(the\s+)?(explicit\s+)?(user'?s?\s+)?(consent|approval|permission|confirmation))\b/i;

export interface DiscernmentGuardOptions {
  /** Policy document; defaults to the shipped fail-closed policy. */
  policy?: EthicsPolicy;
  /** Append-only sink for the conscience ledger. */
  ledger?: (entry: {
    actionClass: ConsequentialActionClass;
    verdict: DiscernmentDecision["verdict"];
    summary: string;
    worthy: boolean;
    reason: string;
  }) => void;
  /** Structured one-line log sink (defaults to a no-op; never logs secrets). */
  log?: (line: string) => void;
}

/** The U11b seam surface. */
export interface ForkDiscernmentSeam {
  gate(action: GatedAction): Promise<DiscernmentDecision>;
  /** True when deception markers are present in the summary. */
  isDeceptive(action: GatedAction): boolean;
  conscienceLedgerAppend(entry: {
    verdict: DiscernmentDecision["verdict"];
    summary: string;
    worthy: boolean;
  }): void;
}

function matches(patterns: readonly RegExp[], text: string): boolean {
  return patterns.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

export class ForkDiscernmentGuard implements ForkDiscernmentSeam {
  private readonly policy: ForkEthicsPolicy;
  private readonly opts: DiscernmentGuardOptions;

  constructor(opts: DiscernmentGuardOptions = {}) {
    // Constructing with a bad policy throws (assertPolicyArmed). Fail-closed.
    this.policy = new ForkEthicsPolicy(opts.policy ?? DEFAULT_ETHICS_POLICY);
    this.opts = opts;
  }

  /** Deception is judged from the summary text, not from the caller's claim. */
  isDeceptive(action: GatedAction): boolean {
    return matches(DECEPTION_MARKERS, action.summary);
  }

  private isCredentialExfiltration(action: GatedAction): boolean {
    return action.class_ === "credential_use" || matches(EXFIL_MARKERS, action.summary);
  }

  private capabilityRule(capability: string): CapabilityRule | undefined {
    return this.policy.ruleFor(capability);
  }

  /**
   * Decide ALLOW | ASK | BLOCK for a consequential action.
   *
   * Order of checks (first match wins):
   *   1. deceptive summary            -> BLOCK  (honesty: deny-by-default)
   *   2. credential exfiltration      -> BLOCK  (stewardship: deny-by-default)
   *   3. capability deny-by-default   -> ASK    (needs an explicit human allow)
   *   4. consent phrase present       -> ALLOW
   *   5. otherwise                    -> ASK    (durable ask, never a silent allow)
   *
   * Any thrown error while deciding yields ASK — the guard never ALLOWs by default.
   */
  async gate(action: GatedAction): Promise<DiscernmentDecision> {
    let decision: DiscernmentDecision;
    try {
      decision = this.decide(action);
    } catch (error) {
      decision = {
        verdict: "ASK",
        reason: `guard error; fail-closed to ASK (${error instanceof Error ? error.name : "unknown"})`,
      };
    }
    this.emit(action, decision);
    return decision;
  }

  private decide(action: GatedAction): DiscernmentDecision {
    const summary = typeof action.summary === "string" ? action.summary : "";

    if (this.isDeceptive(action) || action.honest === false) {
      return {
        verdict: "BLOCK",
        reason: "deceptive action: honesty is deny-by-default",
      };
    }

    if (this.isCredentialExfiltration(action)) {
      return {
        verdict: "BLOCK",
        reason: "credential exfiltration: stewardship is deny-by-default",
      };
    }

    const capability = ACTION_TO_CAPABILITY[action.class_];
    const rule = this.capabilityRule(capability);
    if (!rule || rule.denyByDefault || this.policy.denyByDefault(capability)) {
      return {
        verdict: "ASK",
        reason: `capability "${capability}" is deny-by-default; explicit approval required`,
      };
    }

    if (CONSENT_PHRASE.test(summary)) {
      return {
        verdict: "ALLOW",
        reason: `honest ${action.class_} with explicit consent`,
      };
    }

    return {
      verdict: "ASK",
      reason: `${action.class_}: consent not evidenced; confirm before acting`,
    };
  }

  private emit(action: GatedAction, decision: DiscernmentDecision): void {
    const worthy = decision.verdict === "ALLOW";
    // One-line, structured, secret-free.
    const line = `discernment verdict=${decision.verdict} class=${action.class_} reason=${decision.reason}`;
    try {
      this.opts.log?.(line);
    } catch {
      // Logging must never change the verdict.
    }
    try {
      this.opts.ledger?.({
        actionClass: action.class_,
        verdict: decision.verdict,
        summary: action.summary,
        worthy,
        reason: decision.reason,
      });
    } catch {
      // The ledger is best-effort; a sink failure never relaxes the verdict.
    }
  }

  conscienceLedgerAppend(entry: {
    verdict: DiscernmentDecision["verdict"];
    summary: string;
    worthy: boolean;
  }): void {
    try {
      this.opts.ledger?.({
        actionClass: "external_send",
        verdict: entry.verdict,
        summary: entry.summary,
        worthy: entry.worthy,
        reason: "explicit conscience entry",
      });
    } catch {
      // Append-only best-effort; never throws.
    }
  }
}
