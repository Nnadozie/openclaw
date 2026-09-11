# CONTRACT-COVERAGE.md — OpenClaw+ (fork) seam contract ledger

Author: Ignacio (verifier) · 2026-09-10.
Rule (Sauki discipline + the 2026-09-10 discipline update): every exported seam interface/type under
`src/fork/**` counts **✅ only if all four** hold — (1) **implemented** by a concrete class,
(2) **invoked on a production path** (grep-verified call-site `file:line`, not a test),
(3) covered by a **unit/parity test**, (4) **PROVEN AT RUNTIME** by an executing gate (not static
grep). A seam whose only proof is a call-site grep is **🟡**, not ✅. A `Gate` column names the CI
script + gate that proves (or fails to prove) each contract.

Legend: ✅ = impl + prod-invoked + tested + runtime-proven + named gate · 🟡 = impl (+test) but not
prod-invoked OR not runtime-proven · ⭕ = type-only / no impl · ❌ = no test.

## U1 — Provider seam (`src/fork/provider/types.ts`)

> Wired to a real prod call-site, but **runtime-proven = static-only** (call-site grep + unit
> fixture). No running-gateway journey executes a live provider swap yet.

| Contract                                                     | Implemented      | Prod-invoked (file:line)                                                         | Runtime-proven? (executing gate) | Gate                                          | Test                             | Status |
| ------------------------------------------------------------ | ---------------- | -------------------------------------------------------------------------------- | -------------------------------- | --------------------------------------------- | -------------------------------- | ------ |
| `ForkProviderSeam` (register/list/swap/rollback/validate)    | ✅ `service.ts`  | ✅ `server-reload-managed.ts:7,487` (via `createProviderSeam`→`createForkSeams`) | 🟡 static grep only (call-site)  | Gate 2 prod call-site + `tier3-proof.test.ts` | `provider.test.ts`               | 🟡     |
| `ProviderAdapter` (native + OpenAI-compatible `adapters.ts`) | ✅ `adapters.ts` | ✅ same path (constructed by service)                                            | 🟡 static (unit fixture)         | Gate 2 + `provider.test.ts`                   | `provider.test.ts`               | 🟡     |
| `ModelConfig` registry type                                  | ✅ `types.ts`    | ✅ same path                                                                     | 🟡 static                        | Gate 2                                        | `provider.test.ts`               | 🟡     |
| BYOK resolution (`byok.ts`)                                  | ✅ `byok.ts`     | ✅ same path                                                                     | 🟡 static                        | Gate 2                                        | `provider.test.ts` (no-key-leak) | 🟡     |
| Secret redaction (`redact.ts`)                               | ✅ `redact.ts`   | ✅ same path                                                                     | 🟡 static                        | Gate 2                                        | `provider.test.ts`               | 🟡     |

## U2 — Self-upgrade loop (`src/fork/self-upgrade/types.ts`)

> `createSelfUpgradeSeam` is reached transitively (called by `src/fork/index.ts:45` →
> `createForkSeams` → `applyForkRuntime` → `server-reload-managed.ts:487`), but it is constructed
> with **fail-closed no-op deps** (`validate` always returns `{ok:false}`, `apply` is `async()=>{}`),
> so in production the loop is inert. Hence impl ✅, prod-invoked 🟡 (constructed, non-functional),
> runtime-proven ❌.

| Contract                                                 | Implemented       | Prod-invoked (file:line)                                 | Runtime-proven? | Gate                                             | Test                   | Status |
| -------------------------------------------------------- | ----------------- | -------------------------------------------------------- | --------------- | ------------------------------------------------ | ---------------------- | ------ |
| `SelfUpgradeSeam` (`pipeline`, `reviewer`, `reviewOnce`) | ✅ `index.ts`     | 🟡 reached via `src/fork/index.ts:45` (inert no-op deps) | ❌              | Gate 2 (wired-but-dead) + `self-upgrade.test.ts` | `self-upgrade.test.ts` | 🟡     |
| `SelfReviewer` / `Improvement`                           | ✅ `review.ts`    | 🟡 (inert — only through no-op seam)                     | ❌              | `self-upgrade.test.ts`                           | `self-upgrade.test.ts` | 🟡     |
| `ImprovementStager` (stage/validate/applies)             | ✅ `stage.ts`     | 🟡 (inert, `validate` refuses)                           | ❌              | `self-upgrade.test.ts`                           | `self-upgrade.test.ts` | 🟡     |
| `ImprovementLedger` (append-only)                        | ✅ `ledger.ts`    | 🟡 (inert)                                               | ❌              | `self-upgrade.test.ts`                           | `self-upgrade.test.ts` | 🟡     |
| `guard.ts` (`maySelfApply`, `touchesSensitiveSurface`)   | ✅ `guard.ts`     | 🟡 (inert)                                               | ❌              | `self-upgrade.test.ts`                           | `self-upgrade.test.ts` | 🟡     |
| `TelemetryCapture` (local-first)                         | ✅ `telemetry.ts` | 🟡 (inert)                                               | ❌              | `self-upgrade.test.ts`                           | `self-upgrade.test.ts` | 🟡     |

## U5 — Anti-silence autonomy (`src/fork/autonomy/types.ts`)

> `createAutonomySeam` is **never called** by production nor by `src/fork/index.ts` (only its own
> singleton `getAutonomySeam`). Fully unreached in a running gateway. Gate 3 (dead-export) FAILS here.

| Contract                                         | Implemented       | Prod-invoked (file:line) | Runtime-proven? | Gate                 | Test                    | Status |
| ------------------------------------------------ | ----------------- | ------------------------ | --------------- | -------------------- | ----------------------- | ------ |
| `AutonomySeam` (queue/driver/watchdog/heartbeat) | ✅ `index.ts`     | ❌ — no prod caller      | ❌              | Gate 3 (dead-export) | `autonomy.test.ts` (18) | 🟡     |
| `ForkWorkQueueSeam` (never-empty invariant)      | ✅ `queue.ts`     | ❌ (same)                | ❌              | Gate 3               | `autonomy.test.ts`      | 🟡     |
| `ForkDriver`                                     | ✅ `driver.ts`    | ❌ (same)                | ❌              | Gate 3               | `autonomy.test.ts`      | 🟡     |
| `ForkWatchdog`                                   | ✅ `watchdog.ts`  | ❌ (same)                | ❌              | Gate 3               | `autonomy.test.ts`      | 🟡     |
| `ForkHeartbeatInitiative`                        | ✅ `heartbeat.ts` | ❌ (same)                | ❌              | Gate 3               | `autonomy.test.ts`      | 🟡     |
| `store.ts` (queue/driver state persistence)      | ✅ `store.ts`     | ❌ (same)                | ❌              | Gate 3               | `autonomy.test.ts`      | 🟡     |

## U6 — Per-node model selection (`src/fork/per-node-model/types.ts`)

> `createNodeModelSeam` / `createRunNodeModelSeam` are **never called** from production (not
> reached from the gateway launch model-picker path). Gate 3 (dead-export) FAILS here.

| Contract                                                        | Implemented                            | Prod-invoked (file:line) | Runtime-proven? | Gate                 | Test                          | Status |
| --------------------------------------------------------------- | -------------------------------------- | ------------------------ | --------------- | -------------------- | ----------------------------- | ------ |
| `ForkNodeModelSeam` (`defaultFor`, `resolveModel`, `pick`)      | ✅ `index.ts` (`ForkNodeModelService`) | ❌ — no prod caller      | ❌              | Gate 3 (dead-export) | `per-node-model.test.ts` (17) | 🟡     |
| `resolve.ts` (`resolveModel`, `normalizeAlias`, `fallbacksFor`) | ✅ `resolve.ts`                        | ❌ (same)                | ❌              | Gate 3               | `per-node-model.test.ts`      | 🟡     |
| `picker.ts` (`isPeak`, `peakMultiplier`)                        | ✅ `picker.ts`                         | ❌ (same)                | ❌              | Gate 3               | `per-node-model.test.ts`      | 🟡     |
| `selection.ts` (live binding)                                   | ✅ `selection.ts`                      | ❌ (same)                | ❌              | Gate 3               | `per-node-model.test.ts`      | 🟡     |

## U11 — Ethics core (`src/fork/ethics/types.ts`)

> Wired to a real prod call-site, but **runtime-proven = static-only** (call-site grep + unit
> fixture). No running-gateway journey executes a real discernment `gate()` outcome yet.

| Contract                                         | Implemented         | Prod-invoked (file:line)                                     | Runtime-proven? | Gate                      | Test                                | Status |
| ------------------------------------------------ | ------------------- | ------------------------------------------------------------ | --------------- | ------------------------- | ----------------------------------- | ------ |
| `EthicsSeam` (discernment + devotion)            | ✅ `index.ts`       | ✅ `server-reload-managed.ts:7,487` (via `createEthicsSeam`) | 🟡 static       | Gate 2 + `ethics.test.ts` | `ethics.test.ts` (22)               | 🟡     |
| `ForkDiscernmentSeam` (`gate` → ALLOW/ASK/BLOCK) | ✅ `discernment.ts` | ✅ same path (`runtime.ts` `gate()`)                         | 🟡 static       | Gate 2 + `ethics.test.ts` | `ethics.test.ts`                    | 🟡     |
| Devotion scheduler (scheduled-only)              | ✅ `devotion.ts`    | ✅ same path                                                 | 🟡 static       | Gate 2 + `ethics.test.ts` | `ethics.test.ts`                    | 🟡     |
| `EthicsPolicy` (machine-readable, U11c)          | ✅ `policy.ts`      | ✅ same path                                                 | 🟡 static       | Gate 2 + `ethics.test.ts` | `ethics.test.ts` (no-policy-bypass) | 🟡     |

## U12 — Auto-upgrade / currency (`src/fork/upgrade/types.ts`)

> `createAutoUpgradeSeam` has **no call-site anywhere** (not in production, not even inside
> `src/fork`). Type-only export. Gate 3 (dead-export) FAILS here.

| Contract                                                        | Implemented      | Prod-invoked (file:line) | Runtime-proven? | Gate                 | Test                   | Status |
| --------------------------------------------------------------- | ---------------- | ------------------------ | --------------- | -------------------- | ---------------------- | ------ |
| `AutoUpgradeSeam` (`pipeline`, `consider`)                      | ✅ `index.ts`    | ❌ — never called        | ❌              | Gate 3 (dead-export) | `upgrade.test.ts` (13) | 🟡     |
| `ForkUpgradePipeline` (validate/canary/apply, rollback)         | ✅ `pipeline.ts` | ❌ (same)                | ❌              | Gate 3               | `upgrade.test.ts`      | 🟡     |
| `detect.ts` (`detectVersion`, `compareVersions`)                | ✅ `detect.ts`   | ❌ (same)                | ❌              | Gate 3               | `upgrade.test.ts`      | 🟡     |
| `guard.ts` (`mayAutoApply`, `touchesCriticalPath` — money/auth) | ✅ `guard.ts`    | ❌ (same)                | ❌              | Gate 3               | `upgrade.test.ts`      | 🟡     |

## Totals

| Seam              | Contracts | ✅ (runtime-proven) | 🟡     | ⭕/❌ |
| ----------------- | --------- | ------------------- | ------ | ----- |
| U1 Provider       | 5         | 0                   | 5      | 0     |
| U2 Self-upgrade   | 6         | 0                   | 6      | 0     |
| U5 Autonomy       | 6         | 0                   | 6      | 0     |
| U6 Per-node model | 4         | 0                   | 4      | 0     |
| U11 Ethics        | 4         | 0                   | 4      | 0     |
| U12 Auto-upgrade  | 4         | 0                   | 4      | 0     |
| **Total**         | **29**    | **0**               | **29** | **0** |

## The single structural gap

Every row shares one of two root causes, and **none is yet runtime-proven** (the 2026-09-10 discipline
update makes static grep insufficient):

- **Static-only proof (U1, U11):** the factory **is wired** to a real call-site and its tests pass,
  but no **executing gate** (a running-gateway journey / e2e) proves the user-visible outcome. Present
  ≠ proven at runtime.
- **Dead export / inert (U2, U5, U6, U12):** the seam **factory function exists and its tests pass,
  but it is not functionally active in production.** Only `applyForkRuntime` (U1+U11) is reached; U5/U6/U12
  are never called; U2 is reached but with inert no-op deps.

Fix (per discipline §0.1–0.3): give each a real production call-site + real deps, and add an
**executing** journey/e2e gate (not grep) — a browser journey or a real config-commit smoke that asserts
the user-visible outcome:

- U5 → `src/cron/heartbeat-task.ts` / `src/cron/service.ts` (heartbeat initiative + watchdog/driver).
- U6 → the launch model-picker path (stock `src/model-picker/*` / `commands/models/*`).
- U2 → the self-review scheduler (cron peer) with real stage/apply deps.
- U12 → the upstream tracker (fork-track assimilation / update-startup).
- U1/U11 → a journey gate exercising a live provider swap + a live `gate()` BLOCK/ALLOW.

Until each is `new`-ed in a non-test module reachable from a running gateway AND proven by an
executing gate, they are, per the discipline, **contracts with an impl but no runtime proof** —
honest 🟡, not ✅.
