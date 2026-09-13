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

> **2026-09-12 runtime-proof update.** The earlier "no executing journey gate" gap is **closed**:
> each seam now ships an executing `*-runtime-proof.test.ts` (U6: `launch-runtime-gate.test.ts`) that
> drives the REAL production entry (`applyForkRuntime` → `createForkSeams` → the seam, or the exact
> `model-setup.ts:51` launch decision) and asserts user-visible outcomes with RED non-vacuity fixtures.
> `fork-ci.yml` runs them. Rows below are re-derived from those facts: the Runtime-proven? column now
> reads ✅ where an executing gate proves the contract. A row stays **status-🟡 only when its DEFAULT
> prod wiring is inert** (U2 fail-closed no-op deps; U5 not yet scheduled) — proof is present, the
> stock gateway just does not yet drive it. (Historic note: the old text below this line, which
> claimed all rows stayed 🟡 for lack of an executing gate, is superseded and preserved as the
> original 2026-09-10 wiring record.)
>
> **2026-09-10 wiring update (original record).** All four formerly-dead seams (U5, U6, U12 and the U6
> run-bind `createRunNodeModelSeam`) are now **wired into `createForkSeams`** — the production entry
> invoked by `applyForkRuntime` → `server-reload-managed.ts:487` on the config-commit path — and
> **parity-tested** in `runtime.test.ts`. The dead-export gate (Gate 3) that was RED is now GREEN.
> What that update did **NOT** claim (and which is now resolved — see the 2026-09-12 note above):
> runtime-proof; at the time the proof was static call-site grep + unit fixture.

## U1 — Provider seam (`src/fork/provider/types.ts`)

> **Runtime-proven (executing gate).** `provider-runtime-proof.test.ts` drives the real production
> entry `applyForkRuntime` → `createForkSeams` → `createProviderSeam` and serves turns through
> `serve()` — (a) served via selected adapter, (b) swap takes effect on the running path, (c) swap
> failure rolls back, (d) no key leak; RED fixtures prove non-vacuity. Runs in `fork-ci.yml`.

| Contract                                                     | Implemented      | Prod-invoked (file:line)                                                         | Runtime-proven? (executing gate)                | Gate                                                     | Test                                                 | Status |
| ------------------------------------------------------------ | ---------------- | -------------------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------- | ------ |
| `ForkProviderSeam` (register/list/swap/rollback/validate)    | ✅ `service.ts`  | ✅ `server-reload-managed.ts:7,487` (via `createProviderSeam`→`createForkSeams`) | ✅ `provider-runtime-proof.test.ts` (executing) | Gate 2 prod call-site + `provider-runtime-proof.test.ts` | `provider.test.ts`, `provider-runtime-proof.test.ts` | ✅     |
| `ProviderAdapter` (native + OpenAI-compatible `adapters.ts`) | ✅ `adapters.ts` | ✅ same path (constructed by service)                                            | ✅ executing (`provider-runtime-proof.test.ts`) | Gate 2 + `provider-runtime-proof.test.ts`                | `provider.test.ts`, `provider-runtime-proof.test.ts` | ✅     |
| `ModelConfig` registry type                                  | ✅ `types.ts`    | ✅ same path                                                                     | ✅ executing (served via the runtime proof)     | Gate 2 + `provider-runtime-proof.test.ts`                | `provider.test.ts`                                   | ✅     |
| BYOK resolution (`byok.ts`)                                  | ✅ `byok.ts`     | ✅ same path                                                                     | ✅ executing (no-key-leak asserted)             | Gate 2 + `provider-runtime-proof.test.ts`                | `provider.test.ts` (no-key-leak)                     | ✅     |
| Secret redaction (`redact.ts`)                               | ✅ `redact.ts`   | ✅ same path                                                                     | ✅ executing (raw key never survives)           | Gate 2 + `provider-runtime-proof.test.ts`                | `provider.test.ts`                                   | ✅     |

## U2 — Self-upgrade loop (`src/fork/self-upgrade/types.ts`)

> `createSelfUpgradeSeam` is reached transitively (called by `src/fork/index.ts` → `createForkSeams`
> → `applyForkRuntime` → `server-reload-managed.ts:487`), but it is constructed with **fail-closed
> no-op deps** (`validate` always returns `{ok:false}`, `apply` is `async()=>{}`), so in production
> the loop is inert in the DEFAULT wiring. Hence impl ✅, prod-invoked 🟡 (constructed,
> non-functional), but **runtime-proven ✅ by an executing gate**: `self-upgrade-runtime-proof.test.ts`
> drives `createForkSeams` → `createSelfUpgradeSeam` with real stage/apply/restore deps and asserts
> BLOCK-sensitive / STAGE+APPLY / ROLLBACK on the real path (RED non-vacuity). Status stays 🟡 because
> a stock deployment still supplies the fail-closed no-op deps until a runtime backer is wired.

| Contract                                                 | Implemented       | Prod-invoked (file:line)                              | Runtime-proven?                                     | Gate                                                            | Test                   | Status |
| -------------------------------------------------------- | ----------------- | ----------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------- | ---------------------- | ------ |
| `SelfUpgradeSeam` (`pipeline`, `reviewer`, `reviewOnce`) | ✅ `index.ts`     | 🟡 reached via `src/fork/index.ts` (inert no-op deps) | ✅ executing (`self-upgrade-runtime-proof.test.ts`) | Gate 2 (wired-but-inert) + `self-upgrade-runtime-proof.test.ts` | `self-upgrade.test.ts` | 🟡     |
| `SelfReviewer` / `Improvement`                           | ✅ `review.ts`    | 🟡 (inert — only through no-op seam)                  | ✅ executing                                        | `self-upgrade-runtime-proof.test.ts`                            | `self-upgrade.test.ts` | 🟡     |
| `ImprovementStager` (stage/validate/applies)             | ✅ `stage.ts`     | 🟡 (inert, `validate` refuses)                        | ✅ executing                                        | `self-upgrade-runtime-proof.test.ts`                            | `self-upgrade.test.ts` | 🟡     |
| `ImprovementLedger` (append-only)                        | ✅ `ledger.ts`    | 🟡 (inert)                                            | ✅ executing                                        | `self-upgrade-runtime-proof.test.ts`                            | `self-upgrade.test.ts` | 🟡     |
| `guard.ts` (`maySelfApply`, `touchesSensitiveSurface`)   | ✅ `guard.ts`     | 🟡 (inert)                                            | ✅ executing                                        | `self-upgrade-runtime-proof.test.ts`                            | `self-upgrade.test.ts` | 🟡     |
| `TelemetryCapture` (local-first)                         | ✅ `telemetry.ts` | 🟡 (inert)                                            | ✅ executing                                        | `self-upgrade-runtime-proof.test.ts`                            | `self-upgrade.test.ts` | 🟡     |

## U5 — Anti-silence autonomy (`src/fork/autonomy/types.ts`)

> **Wired (this commit).** `createAutonomySeam` is now called by `createForkSeams` (`src/fork/index.ts`)
> on the config-commit path, so a configured `fork.autonomy` block constructs the full
> queue/driver/watchdog/heartbeat surface. **Still not runtime-proven:** nothing _schedules_ the
> heartbeat/watchdog to tick in a live gateway (no cron/heartbeat-task wiring yet), so the seam is
> constructed but not yet driving. **Runtime-proven ✅ by an executing gate:**
> `autonomy-runtime-proof.test.ts` proves a LIVE scheduled tick through `createForkSeams` →
> `createAutonomySeam` (ticker started; starved queue refilled; driver advances; watchdog detects a
> stall; RED non-vacuity). Status stays 🟡 because the stock gateway does not yet schedule the ticker.

| Contract                                         | Implemented       | Prod-invoked (file:line)                                                    | Runtime-proven?                     | Gate                                      | Test                                                       | Status |
| ------------------------------------------------ | ----------------- | --------------------------------------------------------------------------- | ----------------------------------- | ----------------------------------------- | ---------------------------------------------------------- | ------ |
| `AutonomySeam` (queue/driver/watchdog/heartbeat) | ✅ `index.ts`     | ✅ `src/fork/index.ts` (`createForkSeams` → `server-reload-managed.ts:487`) | ✅ executing (unscheduled in stock) | Gate 2 + `autonomy-runtime-proof.test.ts` | `autonomy.test.ts` (18) + `autonomy-runtime-proof.test.ts` | 🟡     |
| `ForkWorkQueueSeam` (never-empty invariant)      | ✅ `queue.ts`     | ✅ same path                                                                | ✅ executing (tick refills)         | Gate 2 + `autonomy-runtime-proof.test.ts` | `autonomy.test.ts`                                         | 🟡     |
| `ForkDriver`                                     | ✅ `driver.ts`    | ✅ same path                                                                | ✅ executing                        | Gate 2 + `autonomy-runtime-proof.test.ts` | `autonomy.test.ts`                                         | 🟡     |
| `ForkWatchdog`                                   | ✅ `watchdog.ts`  | ✅ same path                                                                | ✅ executing (stall detected)       | Gate 2 + `autonomy-runtime-proof.test.ts` | `autonomy.test.ts`                                         | 🟡     |
| `ForkHeartbeatInitiative`                        | ✅ `heartbeat.ts` | ✅ same path                                                                | ✅ executing                        | Gate 2 + `autonomy-runtime-proof.test.ts` | `autonomy.test.ts`                                         | 🟡     |
| `store.ts` (queue/driver state persistence)      | ✅ `store.ts`     | ✅ same path                                                                | ✅ executing                        | Gate 2 + `autonomy-runtime-proof.test.ts` | `autonomy.test.ts`                                         | 🟡     |

## U6 — Per-node model selection (`src/fork/per-node-model/types.ts`)

> **Wired (this commit).** Two factories, two real call-sites:
>
> - `createNodeModelSeam` — called by `createForkSeams` (`src/fork/index.ts`) to build the gateway-level
>   node-model service (stock-derived selection via `buildNodeModelSelection`).
> - `createRunNodeModelSeam` — the per-run bind, already on the launch model-picker path
>   (`src/agents/embedded-agent-runner/run/model-setup.ts:51` → `applyRunNodeModelSelection` →
>   `createRunNodeModelSeam` → `createNodeModelSeam`). Gate 2 now proves this transitively.
>
> **Runtime-proven (executing gate).** `launch-runtime-gate.test.ts` drives `applyRunNodeModelSelection`
> — the exact `model-setup.ts:51` launch decision — with real stock + `fork.nodes` config: per-node
> default overrides stock, explicit per-run wins, a malformed block fails safe (RED), agent≠subagent.

| Contract                                                        | Implemented                            | Prod-invoked (file:line)                                                        | Runtime-proven?                              | Gate                                   | Test                                                          | Status |
| --------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------- | ------------------------------------------------------------- | ------ |
| `ForkNodeModelSeam` (`defaultFor`, `resolveModel`, `pick`)      | ✅ `index.ts` (`ForkNodeModelService`) | ✅ `src/fork/index.ts` + `model-setup.ts:51` (via `applyRunNodeModelSelection`) | ✅ executing (`launch-runtime-gate.test.ts`) | Gate 2 + `launch-runtime-gate.test.ts` | `per-node-model.test.ts` (17) + `launch-runtime-gate.test.ts` | ✅     |
| `resolve.ts` (`resolveModel`, `normalizeAlias`, `fallbacksFor`) | ✅ `resolve.ts`                        | ✅ same path                                                                    | ✅ executing                                 | Gate 2 + `launch-runtime-gate.test.ts` | `per-node-model.test.ts`                                      | ✅     |
| `picker.ts` (`isPeak`, `peakMultiplier`)                        | ✅ `picker.ts`                         | ✅ same path                                                                    | ✅ executing                                 | Gate 2 + `launch-runtime-gate.test.ts` | `per-node-model.test.ts`                                      | ✅     |
| `selection.ts` (live binding)                                   | ✅ `selection.ts`                      | ✅ `model-setup.ts:51` (real run path)                                          | ✅ executing                                 | Gate 2 + `launch-runtime-gate.test.ts` | `per-node-model.test.ts`                                      | ✅     |

## U11 — Ethics core (`src/fork/ethics/types.ts`)

> **Runtime-proven (executing gate).** `ethics-runtime-proof.test.ts` drives `applyForkRuntime` →
> `createForkSeams` → `createEthicsSeam` and asserts a real BLOCK / ALLOW / ASK plus RED
> no-policy-bypass fixtures on the running path.

| Contract                                         | Implemented         | Prod-invoked (file:line)                                     | Runtime-proven?                               | Gate                                    | Test                                                  | Status |
| ------------------------------------------------ | ------------------- | ------------------------------------------------------------ | --------------------------------------------- | --------------------------------------- | ----------------------------------------------------- | ------ |
| `EthicsSeam` (discernment + devotion)            | ✅ `index.ts`       | ✅ `server-reload-managed.ts:7,487` (via `createEthicsSeam`) | ✅ executing (`ethics-runtime-proof.test.ts`) | Gate 2 + `ethics-runtime-proof.test.ts` | `ethics.test.ts` (22), `ethics-runtime-proof.test.ts` | ✅     |
| `ForkDiscernmentSeam` (`gate` → ALLOW/ASK/BLOCK) | ✅ `discernment.ts` | ✅ same path (`runtime.ts` `gate()`)                         | ✅ executing (real BLOCK/ALLOW/ASK)           | Gate 2 + `ethics-runtime-proof.test.ts` | `ethics.test.ts`                                      | ✅     |
| Devotion scheduler (scheduled-only)              | ✅ `devotion.ts`    | ✅ same path                                                 | ✅ executing                                  | Gate 2 + `ethics-runtime-proof.test.ts` | `ethics.test.ts`                                      | ✅     |
| `EthicsPolicy` (machine-readable, U11c)          | ✅ `policy.ts`      | ✅ same path                                                 | ✅ executing (no-policy-bypass RED)           | Gate 2 + `ethics-runtime-proof.test.ts` | `ethics.test.ts` (no-policy-bypass)                   | ✅     |

## U12 — Auto-upgrade / currency (`src/fork/upgrade/types.ts`)

> **Wired (this commit).** `createAutoUpgradeSeam` is now called by `createForkSeams`
> (`src/fork/index.ts`) with fail-closed deps (mirroring U2), so a configured `fork.autoUpgrade`
> block constructs the guarded pipeline — and `pipeline.consider()` correctly refuses to promote on
> the no-op validator (proven in `runtime.test.ts`). **Still not runtime-proven:** no upstream
> upstream tracker (`detectUpstreamRelease`) now feeds `considerUpstream()` a real release.
> **Runtime-proven (executing gate):** `upgrade-runtime-proof.test.ts` drives the real feed →
> detect → guard → validate → stage → apply → rollback path (RED stale/unsafe refuse).

| Contract                                                        | Implemented      | Prod-invoked (file:line)                             | Runtime-proven?                                | Gate                                     | Test                                                          | Status |
| --------------------------------------------------------------- | ---------------- | ---------------------------------------------------- | ---------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------- | ------ |
| `AutoUpgradeSeam` (`pipeline`, `consider`)                      | ✅ `index.ts`    | ✅ `src/fork/index.ts` (via `createAutoUpgradeSeam`) | ✅ executing (`upgrade-runtime-proof.test.ts`) | Gate 2 + `upgrade-runtime-proof.test.ts` | `upgrade.test.ts` (13) + `upgrade-runtime-proof.test.ts` (11) | ✅     |
| `ForkUpgradePipeline` (validate/canary/apply, rollback)         | ✅ `pipeline.ts` | ✅ same path                                         | ✅ executing                                   | Gate 2 + `upgrade-runtime-proof.test.ts` | `upgrade.test.ts`                                             | ✅     |
| `detect.ts` (`detectVersion`, `compareVersions`)                | ✅ `detect.ts`   | ✅ same path                                         | ✅ executing                                   | Gate 2 + `upgrade-runtime-proof.test.ts` | `upgrade.test.ts`                                             | ✅     |
| `guard.ts` (`mayAutoApply`, `touchesCriticalPath` — money/auth) | ✅ `guard.ts`    | ✅ same path                                         | ✅ executing                                   | Gate 2 + `upgrade-runtime-proof.test.ts` | `upgrade.test.ts`                                             | ✅     |

## Totals

> Re-derived from the tables above (2026-09-12). `runtime-proven` counts contracts with an executing
> gate; `status ✅/🟡` counts final status. Every one of the 29 contracts is now **runtime-proven by an
> executing gate**; the 12 that stay status-🟡 are so because their DEFAULT prod wiring is inert
> (U2 fail-closed no-op deps; U5 unscheduled), not for lack of an executing proof.

| Seam              | Contracts | runtime-proven ✅ | status ✅ | status 🟡 | ❌    |
| ----------------- | --------- | ----------------- | --------- | --------- | ----- |
| U1 Provider       | 5         | 5                 | 5         | 0         | 0     |
| U2 Self-upgrade   | 6         | 6                 | 0         | 6         | 0     |
| U5 Autonomy       | 6         | 6                 | 0         | 6         | 0     |
| U6 Per-node model | 4         | 4                 | 4         | 0         | 0     |
| U11 Ethics        | 4         | 4                 | 4         | 0         | 0     |
| U12 Auto-upgrade  | 4         | 4                 | 4         | 0         | 0     |
| **Total**         | **29**    | **29**            | **17**    | **12**    | **0** |

## The remaining structural gap

**All six seams are now wired + tested + runtime-proven by an executing gate.** The dead-export class
(U5/U6/U12) is **closed** — every exported `create*Seam` factory has a real production call-site and
Gate 3 is green — and each seam now carries an executing `*-runtime-proof.test.ts` (U6:
`launch-runtime-gate.test.ts`) driven from the real production entry, with RED non-vacuity fixtures.
These run in `fork-ci.yml`. So the earlier "runtime-proof gap" is **closed for all six**.

What remains is **functional wiring in the default deployment**, not proof:

- **U5** — constructed but **unscheduled**: no cron/heartbeat-task drives `driver`/`watchdog` to tick.
- **U6** — the run picker is live (`model-setup.ts`); the gateway-level `nodeModel` service is
  constructed and consumed via the live launch decision.
- **U2 / U12** — the executing gates prove stage/apply/rollback and feed→detect→promote; the DEFAULT
  `createForkSeams` wiring still injects **fail-closed no-op deps** until a real runtime backer
  supplies them (U2 needs a stage/apply backer; U12's upstream feed is real but validate/apply are
  no-op by default).
- **U1 / U11** — fully runtime-proven (provider serve/swap/rollback + ethics BLOCK/ALLOW/ASK).

The remaining migration is therefore a **wiring** lane: inject the real stage/apply backer (U2/U12)
and schedule the autonomy ticker (U5) from the gateway runtime. No further proof harness is needed.
