# CONTRACT-COVERAGE.md — OpenClaw+ (fork) seam contract ledger

Author: Ignacio (verifier) · 2026-09-10.
Rule (Sauki discipline, applied to the fork): every exported seam interface/type under `src/fork/**`
counts **✅ only if all three** hold — (1) **implemented** by a concrete class, (2) **invoked on a
production path** (grep-verified call-site `file:line`, not a test), (3) covered by a **unit/parity
test**. Anything else gets the exact gap, not a ⚠️.

Legend: ✅ = impl + prod-invoked + tested · 🟡 = impl (+test) but not prod-invoked · ⭕ = type-only /
no impl · ❌ = no test.

## U1 — Provider seam (`src/fork/provider/types.ts`)

| Contract                                                     | Implemented      | Prod-invoked (file:line)                                                         | Test                             | Status |
| ------------------------------------------------------------ | ---------------- | -------------------------------------------------------------------------------- | -------------------------------- | ------ |
| `ForkProviderSeam` (register/list/swap/rollback/validate)    | ✅ `service.ts`  | ✅ `server-reload-managed.ts:7,487` (via `createProviderSeam`→`createForkSeams`) | `provider.test.ts`               | ✅     |
| `ProviderAdapter` (native + OpenAI-compatible `adapters.ts`) | ✅ `adapters.ts` | ✅ same path (constructed by service)                                            | `provider.test.ts`               | ✅     |
| `ModelConfig` registry type                                  | ✅ `types.ts`    | ✅ same path                                                                     | `provider.test.ts`               | ✅     |
| BYOK resolution (`byok.ts`)                                  | ✅ `byok.ts`     | ✅ same path                                                                     | `provider.test.ts` (no-key-leak) | ✅     |
| Secret redaction (`redact.ts`)                               | ✅ `redact.ts`   | ✅ same path                                                                     | `provider.test.ts`               | ✅     |

## U2 — Self-upgrade loop (`src/fork/self-upgrade/types.ts`)

> `createSelfUpgradeSeam` is reached transitively (called by `src/fork/index.ts:45` →
> `createForkSeams` → `applyForkRuntime` → `server-reload-managed.ts:487`), but it is constructed
> with **fail-closed no-op deps** (`validate` always returns `{ok:false}`, `apply` is `async()=>{}`),
> so in production the loop is inert. Hence impl ✅, prod-invoked 🟡 (constructed, non-functional).

| Contract                                                 | Implemented       | Prod-invoked (file:line)                                 | Test                   | Status |
| -------------------------------------------------------- | ----------------- | -------------------------------------------------------- | ---------------------- | ------ |
| `SelfUpgradeSeam` (`pipeline`, `reviewer`, `reviewOnce`) | ✅ `index.ts`     | 🟡 reached via `src/fork/index.ts:45` (inert no-op deps) | `self-upgrade.test.ts` | 🟡     |
| `SelfReviewer` / `Improvement`                           | ✅ `review.ts`    | 🟡 (inert — only through no-op seam)                     | `self-upgrade.test.ts` | 🟡     |
| `ImprovementStager` (stage/validate/applies)             | ✅ `stage.ts`     | 🟡 (inert, `validate` refuses)                           | `self-upgrade.test.ts` | 🟡     |
| `ImprovementLedger` (append-only)                        | ✅ `ledger.ts`    | 🟡 (inert)                                               | `self-upgrade.test.ts` | 🟡     |
| `guard.ts` (`maySelfApply`, `touchesSensitiveSurface`)   | ✅ `guard.ts`     | 🟡 (inert)                                               | `self-upgrade.test.ts` | 🟡     |
| `TelemetryCapture` (local-first)                         | ✅ `telemetry.ts` | 🟡 (inert)                                               | `self-upgrade.test.ts` | 🟡     |

## U5 — Anti-silence autonomy (`src/fork/autonomy/types.ts`)

> `createAutonomySeam` is **never called** by production nor by `src/fork/index.ts` (only its own
> singleton `getAutonomySeam`). Fully unreached in a running gateway.

| Contract                                         | Implemented       | Prod-invoked (file:line) | Test                    | Status |
| ------------------------------------------------ | ----------------- | ------------------------ | ----------------------- | ------ |
| `AutonomySeam` (queue/driver/watchdog/heartbeat) | ✅ `index.ts`     | ❌ — no prod caller      | `autonomy.test.ts` (18) | 🟡     |
| `ForkWorkQueueSeam` (never-empty invariant)      | ✅ `queue.ts`     | ❌ (same)                | `autonomy.test.ts`      | 🟡     |
| `ForkDriver`                                     | ✅ `driver.ts`    | ❌ (same)                | `autonomy.test.ts`      | 🟡     |
| `ForkWatchdog`                                   | ✅ `watchdog.ts`  | ❌ (same)                | `autonomy.test.ts`      | 🟡     |
| `ForkHeartbeatInitiative`                        | ✅ `heartbeat.ts` | ❌ (same)                | `autonomy.test.ts`      | 🟡     |
| `store.ts` (queue/driver state persistence)      | ✅ `store.ts`     | ❌ (same)                | `autonomy.test.ts`      | 🟡     |

## U6 — Per-node model selection (`src/fork/per-node-model/types.ts`)

> `createNodeModelSeam` / `createRunNodeModelSeam` are **never called** from production (not
> reached from the gateway launch model-picker path).

| Contract                                                        | Implemented                            | Prod-invoked (file:line) | Test                          | Status |
| --------------------------------------------------------------- | -------------------------------------- | ------------------------ | ----------------------------- | ------ |
| `ForkNodeModelSeam` (`defaultFor`, `resolveModel`, `pick`)      | ✅ `index.ts` (`ForkNodeModelService`) | ❌ — no prod caller      | `per-node-model.test.ts` (17) | 🟡     |
| `resolve.ts` (`resolveModel`, `normalizeAlias`, `fallbacksFor`) | ✅ `resolve.ts`                        | ❌ (same)                | `per-node-model.test.ts`      | 🟡     |
| `picker.ts` (`isPeak`, `peakMultiplier`)                        | ✅ `picker.ts`                         | ❌ (same)                | `per-node-model.test.ts`      | 🟡     |
| `selection.ts` (live binding)                                   | ✅ `selection.ts`                      | ❌ (same)                | `per-node-model.test.ts`      | 🟡     |

## U11 — Ethics core (`src/fork/ethics/types.ts`)

| Contract                                         | Implemented         | Prod-invoked (file:line)                                     | Test                                | Status |
| ------------------------------------------------ | ------------------- | ------------------------------------------------------------ | ----------------------------------- | ------ |
| `EthicsSeam` (discernment + devotion)            | ✅ `index.ts`       | ✅ `server-reload-managed.ts:7,487` (via `createEthicsSeam`) | `ethics.test.ts` (22)               | ✅     |
| `ForkDiscernmentSeam` (`gate` → ALLOW/ASK/BLOCK) | ✅ `discernment.ts` | ✅ same path (`runtime.ts` `gate()`)                         | `ethics.test.ts`                    | ✅     |
| Devotion scheduler (scheduled-only)              | ✅ `devotion.ts`    | ✅ same path                                                 | `ethics.test.ts`                    | ✅     |
| `EthicsPolicy` (machine-readable, U11c)          | ✅ `policy.ts`      | ✅ same path                                                 | `ethics.test.ts` (no-policy-bypass) | ✅     |

## U12 — Auto-upgrade / currency (`src/fork/upgrade/types.ts`)

> `createAutoUpgradeSeam` has **no call-site anywhere** (not in production, not even inside
> `src/fork`). Type-only export.

| Contract                                                        | Implemented      | Prod-invoked (file:line) | Test                   | Status |
| --------------------------------------------------------------- | ---------------- | ------------------------ | ---------------------- | ------ |
| `AutoUpgradeSeam` (`pipeline`, `consider`)                      | ✅ `index.ts`    | ❌ — never called        | `upgrade.test.ts` (13) | 🟡     |
| `ForkUpgradePipeline` (validate/canary/apply, rollback)         | ✅ `pipeline.ts` | ❌ (same)                | `upgrade.test.ts`      | 🟡     |
| `detect.ts` (`detectVersion`, `compareVersions`)                | ✅ `detect.ts`   | ❌ (same)                | `upgrade.test.ts`      | 🟡     |
| `guard.ts` (`mayAutoApply`, `touchesCriticalPath` — money/auth) | ✅ `guard.ts`    | ❌ (same)                | `upgrade.test.ts`      | 🟡     |

## Totals

| Seam              | Contracts | ✅    | 🟡     | ⭕/❌ |
| ----------------- | --------- | ----- | ------ | ----- |
| U1 Provider       | 5         | 5     | 0      | 0     |
| U2 Self-upgrade   | 6         | 0     | 6      | 0     |
| U5 Autonomy       | 6         | 0     | 6      | 0     |
| U6 Per-node model | 4         | 0     | 4      | 0     |
| U11 Ethics        | 4         | 4     | 0      | 0     |
| U12 Auto-upgrade  | 4         | 0     | 4      | 0     |
| **Total**         | **29**    | **9** | **20** | **0** |

## The single structural gap

Every 🟡 row shares one root cause: the seam **factory function exists and its tests pass, but it is
not functionally active in production.** Only `applyForkRuntime` (U1+U11) is both reached and real:

- **U2** is reached (`createForkSeams` → `applyForkRuntime`) but wired with inert/fail-closed no-op
  deps — the self-upgrade loop can never act.
- **U5 / U6 / U12** are never called at all (no prod module, and U12 has no call-site even in
  `src/fork`).

Fix: give each a real production call-site + real deps, with a runtime-invocation test (the
`runtime.test.ts` pattern):

- U5 → `src/cron/heartbeat-task.ts` / `src/cron/service.ts` (heartbeat initiative + watchdog/driver).
- U6 → the launch model-picker path (stock `src/model-picker/*` / `commands/models/*`).
- U2 → the self-review scheduler (cron peer) with real stage/apply deps.
- U12 → the upstream tracker (fork-track assimilation / update-startup).

Until each is `new`-ed in a non-test module reachable from a running gateway (and, for U2, with real
non-no-op deps), they are, per the discipline, **contracts with an impl but no running path** —
honest 🟡, not ✅.
