// @fork-seam U1 — the provider seam implementation.
//
// Constructed in production by `src/fork/provider/index.ts` (see `createProviderSeam`)
// and wired from config. Responsibilities:
//   • typed registry of ForkModelConfig targets (additive; never replaces
//     ModelsConfigSchema or the run-loop)
//   • validate → probe → atomic swap → health poll → rollback lifecycle that is
//     STATE-CARRYING: only the model ref changes, sessions/memory/history survive
//   • advisory cost-aware routing (downgrade non-essential work in a peak window)
//
// BYOK: keys are resolved transiently from env, never stored, and are redacted in
// every error path via `safeError`.
import fs from "node:fs";
import path from "node:path";
import { selectAdapter } from "./adapters.js";
import { requiresUserKey, resolveByok, safeError } from "./byok.js";
import { redactSecrets } from "./redact.js";
import {
  ForkModelConfigSchema,
  type ForkModelConfig,
  type ForkProviderSeam,
  type ProbeResult,
  type RollbackResult,
  type RouteWork,
  type SwapResult,
  type ValidationResult,
} from "./types.js";

/** Persisted routing state (the only thing a swap writes). */
interface SwappedState {
  active: ForkModelConfig;
  lastGood: ForkModelConfig | null;
  swappedAt: string;
}

export interface ProviderSeamOptions {
  /** Path to the JSON state file the swap lifecycle reads/writes. */
  statePath: string;
  /** Initial registry entries. */
  models?: ForkModelConfig[];
  /** Model used when non-essential work is downgraded. */
  utilityRef?: ForkModelConfig;
  /** Enable advisory downgrade of non-essential work inside peak windows. */
  autoDowngrade?: boolean;
  /** Env source for BYOK resolution (injectable for tests). */
  env?: Record<string, string | undefined>;
  /**
   * Health probe executed after a swap write. Returns true when the gateway is
   * healthy on the new model. Injectable so tests need no live gateway.
   */
  healthCheck?: (cfg: ForkModelConfig) => Promise<boolean>;
  /** Dry-run probe (defaults to a key-presence + adapter-support check). */
  probeImpl?: (cfg: ForkModelConfig) => Promise<ProbeResult>;
  /** Optional hook fired after state is written (e.g. a real restart). */
  onRestart?: (cfg: ForkModelConfig) => Promise<void>;
}

export class ForkProviderService implements ForkProviderSeam {
  private readonly registry = new Map<string, ForkModelConfig>();
  private readonly opts: ProviderSeamOptions;
  private active: ForkModelConfig | null = null;
  private lastGood: ForkModelConfig | null = null;

  constructor(opts: ProviderSeamOptions) {
    this.opts = opts;
    for (const cfg of opts.models ?? []) {
      this.register(cfg);
    }
    this.active = this.loadState();
    if (!this.active && opts.models && opts.models.length > 0) {
      this.active = opts.models[0] ?? null;
    }
  }

  /** Registry key: canonical provider/model ref. */
  private key(cfg: Pick<ForkModelConfig, "provider" | "model">): string {
    return `${cfg.provider}/${cfg.model}`;
  }

  register(cfg: ForkModelConfig): void {
    const parsed = ForkModelConfigSchema.parse(cfg);
    this.registry.set(this.key(parsed), parsed);
  }

  list(): ForkModelConfig[] {
    return [...this.registry.values()];
  }

  /** The currently active model config, or null before any swap/seed. */
  current(): ForkModelConfig | null {
    return this.active;
  }

  async validate(cfg: ForkModelConfig): Promise<ValidationResult> {
    const errors: string[] = [];
    const parsed = ForkModelConfigSchema.safeParse(cfg);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        errors.push(`${issue.path.join(".") || "<root>"}: ${issue.message}`);
      }
      return { ok: false, errors };
    }
    const value = parsed.data;
    if (!selectAdapter(value, undefined)) {
      errors.push(`no adapter supports provider "${value.provider}"`);
    }
    if (value.authKind === "none" && !value.baseURL) {
      errors.push('authKind "none" is only valid for a self-hosted baseURL');
    }
    if (requiresUserKey(value.authKind)) {
      const { key } = resolveByok(value, this.opts.env);
      if (!key) {
        // Not fatal at validate time (BYOK may be injected later) but surfaced.
        errors.push(
          `no BYOK key found for provider "${value.provider}" (set ${resolveByok(value, this.opts.env).injection.keyRef.replace("env:", "")})`,
        );
      }
    }
    return { ok: errors.length === 0, errors: errors.map((e) => redactSecrets(e)) };
  }

  async probe(cfg: ForkModelConfig): Promise<ProbeResult> {
    if (this.opts.probeImpl) {
      const result = await this.opts.probeImpl(cfg);
      return { ok: result.ok, detail: redactSecrets(result.detail) };
    }
    const adapter = selectAdapter(cfg);
    if (!adapter) {
      return { ok: false, detail: `no adapter for provider "${cfg.provider}"` };
    }
    if (requiresUserKey(cfg.authKind)) {
      const { key } = resolveByok(cfg, this.opts.env);
      if (!key) {
        return { ok: false, detail: "dry-run probe: no BYOK key available" };
      }
    }
    return { ok: true, detail: `dry-run probe ok (${adapter.id})` };
  }

  /**
   * Atomic swap: validate → probe → backup last-good → write new state → restart
   * → health poll → rollback on any failure. Sessions/memory are NOT touched.
   */
  async swap(next: ForkModelConfig, opts: { atomic: true }): Promise<SwapResult> {
    if (!opts?.atomic) {
      return { ok: false, rolledBack: true, error: "swap requires { atomic: true }" };
    }
    const validation = await this.validate(next);
    if (!validation.ok) {
      return { ok: false, rolledBack: true, error: validation.errors.join("; ") };
    }
    const probe = await this.probe(next);
    if (!probe.ok) {
      return { ok: false, rolledBack: true, error: `probe failed: ${probe.detail}` };
    }

    const previousActive = this.active;
    const previousLastGood = this.lastGood;

    // Backup last-good, then write the candidate as active.
    this.lastGood = this.active ?? this.lastGood;
    this.active = next;
    try {
      this.writeState({
        active: next,
        lastGood: this.lastGood,
        swappedAt: new Date().toISOString(),
      });
    } catch (error) {
      this.active = previousActive;
      this.lastGood = previousLastGood;
      return {
        ok: false,
        rolledBack: true,
        error: safeError(`state write failed: ${String(error)}`),
      };
    }

    // Restart + health poll; roll back on failure.
    try {
      if (this.opts.onRestart) {
        await this.opts.onRestart(next);
      }
      const healthy = this.opts.healthCheck ? await this.opts.healthCheck(next) : true;
      if (!healthy) {
        await this.rollback();
        return { ok: false, rolledBack: true, error: "health check failed after swap" };
      }
    } catch (error) {
      await this.rollback();
      return { ok: false, rolledBack: true, error: safeError(`restart failed: ${String(error)}`) };
    }

    return { ok: true, active: next };
  }

  /** Restore the last-good config (or the seeded first model). */
  async rollback(): Promise<RollbackResult> {
    const target = this.lastGood;
    if (!target) {
      return { ok: false, restored: null, error: "no last-good config to restore" };
    }
    this.active = target;
    this.lastGood = null;
    try {
      this.writeState({ active: target, lastGood: null, swappedAt: new Date().toISOString() });
    } catch (error) {
      return { ok: false, restored: target, error: safeError(String(error)) };
    }
    return { ok: true, restored: target };
  }

  /**
   * Advisory cost-aware routing. An essential user turn is NEVER downgraded.
   * Non-essential work inside a peak window is downgraded to the utility model
   * when `autoDowngrade` is on.
   */
  route(work: RouteWork): ForkModelConfig {
    const current = this.active ?? this.list()[0];
    if (!current) {
      throw new Error("provider seam has no registered model to route to");
    }
    if (work.essential || !this.opts.autoDowngrade) {
      return current;
    }
    const utility = this.opts.utilityRef;
    if (!utility) {
      return current;
    }
    return this.isPeak(current, work.nowUtc) ? utility : current;
  }

  private isPeak(cfg: ForkModelConfig, nowUtc: number): boolean {
    const window = cfg.peakWindow;
    if (!window) {
      return false;
    }
    const hour = new Date(nowUtc).getUTCHours();
    return hour >= window.startUtcH && hour < window.endUtcH;
  }

  private statePath(): string {
    return this.opts.statePath;
  }

  private loadState(): ForkModelConfig | null {
    try {
      const raw = fs.readFileSync(this.statePath(), "utf8");
      const parsed = JSON.parse(raw) as Partial<SwappedState>;
      if (parsed.lastGood) {
        this.lastGood = ForkModelConfigSchema.parse(parsed.lastGood);
      }
      return parsed.active ? ForkModelConfigSchema.parse(parsed.active) : null;
    } catch {
      return null;
    }
  }

  /** Atomic write: temp file + rename so a crash never leaves a torn state file. */
  private writeState(state: SwappedState): void {
    const target = this.statePath();
    const dir = path.dirname(target);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, target);
  }
}
