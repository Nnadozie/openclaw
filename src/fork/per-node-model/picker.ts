// U6 — cost-window awareness: advisory downgrade only, never a block.
import type { CostWindow } from "./types.js";

/** True when `nowUtc` falls inside the model's peak surcharge window. */
export function isPeak(
  model: string,
  nowUtc: number,
  windows: Record<string, CostWindow> = {},
): boolean {
  const win = windows[model];
  if (!win) {
    return false;
  }
  const hour = new Date(nowUtc).getUTCHours();
  const { startUtcH, endUtcH } = win;
  if (startUtcH === endUtcH) {
    return false;
  }
  // Wrap-around window (e.g. 22 → 06) supported.
  return startUtcH < endUtcH
    ? hour >= startUtcH && hour < endUtcH
    : hour >= startUtcH || hour < endUtcH;
}

/** The multiplier in force at `nowUtc` (1 when off-peak / unknown). */
export function peakMultiplier(
  model: string,
  nowUtc: number,
  windows: Record<string, CostWindow> = {},
): number {
  return isPeak(model, nowUtc, windows) ? (windows[model]?.multiplier ?? 1) : 1;
}
