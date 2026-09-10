// @fork-seam U2 — self-upgrading loop: local-first telemetry capture.
//
// Privacy-preserving by construction: we capture DIMENSIONS (latency, token and
// cost aggregates, error classes, tool names) — never conversation text, never
// secrets. Samples are appended to a local NDJSON ring; summaries are derived on
// read. This module is side-effect free apart from the sink, and injectable for
// tests (in-memory capture).
import fs from "node:fs";
import path from "node:path";
import type { TelemetrySample, TelemetrySummary } from "./types.js";

export interface TelemetryCaptureOptions {
  /** Append-only NDJSON file under the fork state dir. */
  samplesPath?: string;
  /** Injected clock (ms epoch) for deterministic tests. */
  now?: () => number;
  /** Cap on in-memory retention (ring). */
  maxSamples?: number;
}

/**
 * The telemetry capture seam. `capture()` records one sample; `summarize()` rolls
 * the retained samples up into a secret-free aggregate for the self-reviewer.
 */
export class TelemetryCapture {
  private readonly samplesPath: string | undefined;
  private readonly now: () => number;
  private readonly maxSamples: number;
  private readonly memory: TelemetrySample[] = [];

  constructor(opts: TelemetryCaptureOptions = {}) {
    this.samplesPath = opts.samplesPath;
    this.now = opts.now ?? Date.now;
    this.maxSamples = opts.maxSamples ?? 10_000;
  }

  /**
   * Record one turn sample. Secret-free contract: callers MUST NOT pass
   * conversation text; only the fields on TelemetrySample are persisted.
   */
  capture(sample: Omit<TelemetrySample, "at"> & { at?: number }): TelemetrySample {
    const full: TelemetrySample = { at: sample.at ?? this.now(), ...sample };
    this.memory.push(full);
    if (this.memory.length > this.maxSamples) {
      this.memory.splice(0, this.memory.length - this.maxSamples);
    }
    if (this.samplesPath) {
      try {
        fs.mkdirSync(path.dirname(this.samplesPath), { recursive: true });
        fs.appendFileSync(this.samplesPath, `${JSON.stringify(full)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
      } catch {
        // A sink failure must never change the turn's outcome.
      }
    }
    return full;
  }

  /** All retained samples (in-memory; the ring window). */
  samples(): TelemetrySample[] {
    return this.memory.slice();
  }

  /** Roll retained samples up into a secret-free summary for the self-review. */
  summarize(windowStart?: string): TelemetrySummary {
    const samples = this.memory;
    const turns = samples.length;
    const lat = samples.map((s) => s.latencyMs).sort((a, b) => a - b);
    const pct = (p: number): number => {
      if (turns === 0) {
        return 0;
      }
      const idx = Math.min(turns - 1, Math.floor((p / 100) * turns));
      return lat[idx] ?? 0;
    };
    const totalCost = samples.reduce((acc, s) => acc + s.costMinor, 0);
    const errors: Record<string, number> = {};
    const toolUsage: Record<string, number> = {};
    for (const s of samples) {
      if (s.errorClass) {
        errors[s.errorClass] = (errors[s.errorClass] ?? 0) + 1;
      }
      for (const t of s.tools) {
        toolUsage[t] = (toolUsage[t] ?? 0) + 1;
      }
    }
    return {
      turns,
      latency: { p50: pct(50), p95: pct(95) },
      cost: { total: totalCost, mean: turns === 0 ? 0 : totalCost / turns },
      errors,
      toolUsage,
      windowStart: windowStart ?? new Date(this.now()).toISOString(),
    };
  }
}
