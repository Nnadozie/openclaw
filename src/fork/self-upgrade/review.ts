// @fork-seam U2 — self-upgrading loop: scheduled self-review.
//
// Reads local telemetry + classified feedback and proposes exactly ONE
// improvement. Deterministic and side-effect-free: it ranks signals and picks
// the single most actionable, returns null when nothing is worth changing (an
// honest "no change" is a valid outcome — never a fabricated improvement).
import type { FeedbackSignal, Improvement, ImprovementKind, TelemetrySummary } from "./types.js";

export interface SelfReviewInput {
  telemetry: TelemetrySummary;
  feedback?: FeedbackSignal[];
  /** Injected clock (ms epoch) for deterministic ids. */
  now?: () => number;
}

export interface SelfReviewOptions {
  /** Only propose if the signal clears this threshold (keeps the loop quiet). */
  minTurns?: number;
}

/**
 * The self-review seam. Propose exactly ONE improvement (ADR-U2-1), ranked by
 * actionability, or null when there is nothing worth changing.
 */
export class SelfReviewer {
  private readonly minTurns: number;

  constructor(opts: SelfReviewOptions = {}) {
    this.minTurns = opts.minTurns ?? 1;
  }

  review(input: SelfReviewInput): Improvement | null {
    const now = input.now?.() ?? Date.now();
    const id = new Date(now).toISOString();

    // Guard: don't propose off an empty / too-small sample (never fabricate).
    if (input.telemetry.turns < this.minTurns) {
      return null;
    }

    const proposal = this.rank(input);
    if (!proposal) {
      return null;
    }
    return proposal(id);
  }

  private rank(input: SelfReviewInput): ((id: string) => Improvement) | null {
    const t = input.telemetry;

    // 1. A classified opt-out / bug is the strongest, most actionable signal.
    const bug = input.feedback?.find((f) => f.kind === "bug");
    if (bug) {
      return (id) =>
        this.make("feedback", id, `address reported bug: ${bug.detail}`, bug.detail, [
          "DEVELOPER-SUPPLIED",
        ]);
    }

    // 2. A dominant error class is the clearest correctness problem.
    const topError = this.topKey(t.errors);
    if (topError && t.errors[topError]! / Math.max(1, t.turns) >= 0.25) {
      return (id) =>
        this.make(
          "error",
          id,
          `reduce ${topError} errors (${t.errors[topError]} of ${t.turns} turns)`,
          `${topError} error dominant`,
        );
    }

    // 3. Latency: p95 clearly past the 2s mark is an actionable target.
    if (t.latency.p95 > 2000) {
      return (id) =>
        this.make(
          "latency",
          id,
          `reduce p95 latency (currently ${t.latency.p95}ms)`,
          `p95 latency ${t.latency.p95}ms > 2000ms`,
        );
    }

    // 4. Cost: a mean turn cost in the top decile of the window is worth a look.
    if (t.cost.mean > 0 && t.turns >= 10) {
      return (id) =>
        this.make(
          "cost",
          id,
          `optimise spend (mean ${t.cost.mean} minor/turn over ${t.turns} turns)`,
          `mean turn cost ${t.cost.mean}`,
        );
    }

    return null;
  }

  private make(
    kind: ImprovementKind,
    id: string,
    summary: string,
    motivation: string,
    files: string[] = ["DEVELOPER-SUPPLIED"],
  ): Improvement {
    return {
      id: `${kind}:${id}`,
      kind,
      summary,
      // The loop NEVER authors code itself: it proposes; a builder (human or
      // approved agent) supplies the actual diff/files. Empty diff = proposal
      // awaiting a real change (fail-closed: an empty diff never applies).
      diff: "",
      files,
      motivation,
      lastGood: null,
    };
  }

  private topKey(map: Record<string, number>): string | null {
    let best: string | null = null;
    let bestN = -1;
    for (const [key, n] of Object.entries(map)) {
      if (n > bestN) {
        best = key;
        bestN = n;
      }
    }
    return best;
  }
}
