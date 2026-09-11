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

> **2026-09-10 wiring update (this commit).** All four formerly-dead seams (U5, U6, U12 and the U6
> run-bind `createRunNodeModelSeam`) are now **wired into `createForkSeams`** — the production entry
> invoked by `applyForkRuntime` → `server-reload-managed.ts:487` on the config-commit path — and
> **parity-tested** in `runtime.test.ts`. The dead-export gate (Gate 3) that was RED is now GREEN.
> What this update does **NOT** claim: runtime-proof. There is still no **executing** journey gate
> (a live gateway journey that asserts a user-visible outcome); the proof remains static call-site
> grep + unit fixture. So these rows move from **dead-export** to **wired + tested**, and stay
> honestly **🟡** — not ✅ — until an executing gate closes the runtime-proof gap.

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

> `createSelfUpgradeSeam` is reached transitively (called by `src/fork/index.ts` → `createForkSeams`
> → `applyForkRuntime` → `server-reload-managed.ts:487`), but it is constructed with **fail-closed
> no-op deps** (`validate` always returns `{ok:false}`, `apply` is `async()=>{}`), so in production
> the loop is inert. Hence impl ✅, prod-invoked 🟡 (constructed, non-functional), runtime-proven ❌.

| Contract                                                 | Implemented       | Prod-invoked (file:line)                              | Runtime-proven? | Gate                                              | Test                   | Status |
| -------------------------------------------------------- | ----------------- | ----------------------------------------------------- | --------------- | ------------------------------------------------- | ---------------------- | ------ |
| `SelfUpgradeSeam` (`pipeline`, `reviewer`, `reviewOnce`) | ✅ `index.ts`     | 🟡 reached via `src/fork/index.ts` (inert no-op deps) | ❌              | Gate 2 (wired-but-inert) + `self-upgrade.test.ts` | `self-upgrade.test.ts` | 🟡     |
| `SelfReviewer` / `Improvement`                           | ✅ `review.ts`    | 🟡 (inert — only through no-op seam)                  | ❌              | `self-upgrade.test.ts`                            | `self-upgrade.test.ts` | 🟡     |
| `ImprovementStager` (stage/validate/applies)             | ✅ `stage.ts`     | 🟡 (inert, `validate` refuses)                        | ❌              | `self-upgrade.test.ts`                            | `self-upgrade.test.ts` | 🟡     |
| `ImprovementLedger` (append-only)                        | ✅ `ledger.ts`    | 🟡 (inert)                                            | ❌              | `self-upgrade.test.ts`                            | `self-upgrade.test.ts` | 🟡     |
| `guard.ts` (`maySelfApply`, `touchesSensitiveSurface`)   | ✅ `guard.ts`     | 🟡 (inert)                                            | ❌              | `self-upgrade.test.ts`                            | `self-upgrade.test.ts` | 🟡     |
| `TelemetryCapture` (local-first)                         | ✅ `telemetry.ts` | 🟡 (inert)                                            | ❌              | `self-upgrade.test.ts`                            | `self-upgrade.test.ts` | 🟡     |

## U5 — Anti-silence autonomy (`src/fork/autonomy/types.ts`)

> **Wired (this commit).** `createAutonomySeam` is now called by `createForkSeams` (`src/fork/index.ts`)
> on the config-commit path, so a configured `fork.autonomy` block constructs the full
> queue/driver/watchdog/heartbeat surface. **Still not runtime-proven:** nothing _schedules_ the
> heartbeat/watchdog to tick in a live gateway (no cron/heartbeat-task wiring yet), so the seam is
> constructed but not yet driving. Gate 3 (dead-export) now passes; runtime-proof remains static.

| Contract                                         | Implemented       | Prod-invoked (file:line)                                                    | Runtime-proven?                | Gate                       | Test                                        | Status |
| ------------------------------------------------ | ----------------- | --------------------------------------------------------------------------- | ------------------------------ | -------------------------- | ------------------------------------------- | ------ |
| `AutonomySeam` (queue/driver/watchdog/heartbeat) | ✅ `index.ts`     | ✅ `src/fork/index.ts` (`createForkSeams` → `server-reload-managed.ts:487`) | 🟡 static (wired, unscheduled) | Gate 2 + `runtime.test.ts` | `autonomy.test.ts` (18) + `runtime.test.ts` | 🟡     |
| `ForkWorkQueueSeam` (never-empty invariant)      | ✅ `queue.ts`     | ✅ same path                                                                | 🟡 static                      | Gate 2                     | `autonomy.test.ts`                          | 🟡     |
| `ForkDriver`                                     | ✅ `driver.ts`    | ✅ same path                                                                | 🟡 static                      | Gate 2                     | `autonomy.test.ts`                          | 🟡     |
| `ForkWatchdog`                                   | ✅ `watchdog.ts`  | ✅ same path                                                                | 🟡 static                      | Gate 2                     | `autonomy.test.ts`                          | 🟡     |
| `ForkHeartbeatInitiative`                        | ✅ `heartbeat.ts` | ✅ same path                                                                | 🟡 static                      | Gate 2                     | `autonomy.test.ts`                          | 🟡     |
| `store.ts` (queue/driver state persistence)      | ✅ `store.ts`     | ✅ same path                                                                | 🟡 static                      | Gate 2                     | `autonomy.test.ts`                          | 🟡     |

## U6 — Per-node model selection (`src/fork/per-node-model/types.ts`)

> **Wired (this commit).** Two factories, two real call-sites:
>
> - `createNodeModelSeam` — called by `createForkSeams` (`src/fork/index.ts`) to build the gateway-level
>   node-model service (stock-derived selection via `buildNodeModelSelection`).
> - `createRunNodeModelSeam` — the per-run bind, already on the launch model-picker path
>   (`src/agents/embedded-agent-runner/run/model-setup.ts:51` → `applyRunNodeModelSelection` →
>   `createRunNodeModelSeam` → `createNodeModelSeam`). Gate 2 now proves this transitively.
>
> **Still not runtime-proven:** the picker executes in unit fixtures but no live turn/e2e asserts a
> real per-node model swap on a running gateway. Gate 3 now passes; runtime-proof remains static.

| Contract                                                        | Implemented                            | Prod-invoked (file:line)                                                        | Runtime-proven?   | Gate                       | Test                                              | Status |
| --------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------- | ----------------- | -------------------------- | ------------------------------------------------- | ------ |
| `ForkNodeModelSeam` (`defaultFor`, `resolveModel`, `pick`)      | ✅ `index.ts` (`ForkNodeModelService`) | ✅ `src/fork/index.ts` + `model-setup.ts:51` (via `applyRunNodeModelSelection`) | 🟡 static (wired) | Gate 2 + `runtime.test.ts` | `per-node-model.test.ts` (17) + `runtime.test.ts` | 🟡     |
| `resolve.ts` (`resolveModel`, `normalizeAlias`, `fallbacksFor`) | ✅ `resolve.ts`                        | ✅ same path                                                                    | 🟡 static         | Gate 2                     | `per-node-model.test.ts`                          | 🟡     |
| `picker.ts` (`isPeak`, `peakMultiplier`)                        | ✅ `picker.ts`                         | ✅ same path                                                                    | 🟡 static         | Gate 2                     | `per-node-model.test.ts`                          | 🟡     |
| `selection.ts` (live binding)                                   | ✅ `selection.ts`                      | ✅ `model-setup.ts:51` (real run path)                                          | 🟡 static         | Gate 2 + `runtime.test.ts` | `per-node-model.test.ts`                          | 🟡     |

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

> **Wired (this commit).** `createAutoUpgradeSeam` is now called by `createForkSeams`
> (`src/fork/index.ts`) with fail-closed deps (mirroring U2), so a configured `fork.autoUpgrade`
> block constructs the guarded pipeline — and `pipeline.consider()` correctly refuses to promote on
> the no-op validator (proven in `runtime.test.ts`). **Still not runtime-proven:** no upstream
> tracker feeds the `consider()` path with a live release, and there is no executing journey gate.
> Gate 3 now passes; runtime-proof remains static.

| Contract                                                        | Implemented      | Prod-invoked (file:line)                             | Runtime-proven?   | Gate                       | Test                                       | Status |
| --------------------------------------------------------------- | ---------------- | ---------------------------------------------------- | ----------------- | -------------------------- | ------------------------------------------ | ------ |
| `AutoUpgradeSeam` (`pipeline`, `consider`)                      | ✅ `index.ts`    | ✅ `src/fork/index.ts` (via `createAutoUpgradeSeam`) | 🟡 static (wired) | Gate 2 + `runtime.test.ts` | `upgrade.test.ts` (13) + `runtime.test.ts` | 🟡     |
| `ForkUpgradePipeline` (validate/canary/apply, rollback)         | ✅ `pipeline.ts` | ✅ same path                                         | 🟡 static         | Gate 2                     | `upgrade.test.ts`                          | 🟡     |
| `detect.ts` (`detectVersion`, `compareVersions`)                | ✅ `detect.ts`   | ✅ same path                                         | 🟡 static         | Gate 2                     | `upgrade.test.ts`                          | 🟡     |
| `guard.ts` (`mayAutoApply`, `touchesCriticalPath` — money/auth) | ✅ `guard.ts`    | ✅ same path                                         | 🟡 static         | Gate 2                     | `upgrade.test.ts`                          | 🟡     |

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

## The remaining structural gap

**All six seams are now wired + tested (this commit), but none is yet runtime-proven.** The
dead-export class (U5/U6/U12) is **closed** — every exported `create*Seam` factory now has a real
production call-site and Gate 3 is green. What remains is the same single gap that keeps every row
at 🟡:

- **No executing gate.** Proof is still _static_ (call-site grep → Gate 2) + _unit fixture_
  (`*.test.ts`). No **journey/e2e gate** runs a live gateway and asserts a user-visible outcome
  (a real provider swap, a real `gate()` BLOCK/ALLOW, a real per-node model selection on a running
  turn, a real scheduled heartbeat tick, a real auto-upgrade promotion). Per discipline §0.1–0.3,
  presence ≠ behaviour at runtime; static proof is 🟡, not ✅.

Secondary, per-seam functional gaps that remain after this wiring (each is a follow-on build lane):

- **U5** — constructed but **unscheduled**: no cron/heartbeat-task drives `driver`/`watchdog` to tick.
- **U6** — the run picker is live (`model-setup.ts`), but the gateway-level `nodeModel` service is
  constructed yet unused beyond `defaultFor`.
- **U2 / U12** — still constructed with **fail-closed no-op deps**; a real deployment must inject
  materialize/validate/apply (U2) and validate/canary/apply (U12) from the gateway runtime.
- **U1 / U11** — unchanged from before (wired, static-proved).

The single migration that would turn the whole board green: an **executing** journey gate — a real
config-commit smoke (browser journey or e2e) that asserts the user-visible outcome of each seam on a
running gateway. That is a separate build lane (deferred); this commit only closes the dead-export
class and wires the four formerly-orphaned factories into the one true entry point.
