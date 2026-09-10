// @fork-seam U2 — self-upgrading loop: append-only improvement ledger + state.
//
// Local, dependency-light, NO-DELETE. The improvement ledger is append-only
// NDJSON; the state file is written atomically (temp + rename). Reuses the U5
// store helpers so the fork has one atomic-write discipline.
import { appendNdjson, readJsonFile, writeJsonAtomic } from "../autonomy/store.js";
import type { ImprovementRecord, SelfUpgradeStateFile } from "./types.js";

export class ImprovementLedger {
  private readonly statePath: string;
  private readonly ledgerPath: string;

  constructor(opts: { stateDir: string }) {
    this.statePath = `${opts.stateDir}/fork/self-upgrade-state.json`;
    this.ledgerPath = `${opts.stateDir}/fork/self-upgrade-ledger.ndjson`;
  }

  readState(): SelfUpgradeStateFile {
    const parsed = readJsonFile<Partial<SelfUpgradeStateFile>>(this.statePath);
    return {
      lastGood: parsed?.lastGood ?? null,
      current: parsed?.current ?? null,
      updatedAt: parsed?.updatedAt ?? new Date().toISOString(),
    };
  }

  writeState(state: SelfUpgradeStateFile): void {
    writeJsonAtomic(this.statePath, state);
  }

  /** Append-only: never mutates or removes a prior record. */
  append(record: ImprovementRecord): void {
    appendNdjson(this.ledgerPath, record);
  }
}
