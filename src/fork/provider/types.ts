// @fork-seam U1 — Provider-agnostic LLM seam: typed contracts.
//
// Additive seam. It NEVER replaces the stock model config schema
// (`src/config/zod-schema.core.ts` ModelsConfigSchema) or the run-loop. It adds a
// routing registry + adapters + a state-carrying swap lifecycle around them.
//
// BYOK: the user supplies their own `<PROVIDER>_API_KEY`. We ship NO bundled
// credentials and never persist a key in config (see ADR-U1-2 / ADR-F-5).
import { z } from "zod";

/** How a provider authenticates a request. */
export type ProviderAuthKind = "api-key" | "bearer" | "oauth" | "none";

/** Coarse cost band, used for advisory routing (never a price itself). */
export type CostClass = "cheap" | "standard" | "premium" | "custom";

/** Optional peak surcharge window in UTC whole hours (start inclusive, end exclusive). */
export interface ModelCostWindow {
  startUtcH: number;
  endUtcH: number;
  multiplier: number;
}

/**
 * The fork's typed view of a provider/model target. Extends (never replaces) the
 * stock `provider/model` ref by carrying the routing + auth metadata we need.
 */
export interface ForkModelConfig {
  /** Canonical provider id (matches ModelsConfigSchema.providers key). */
  provider: string;
  /** Canonical model id. */
  model: string;
  /** Base URL for OpenAI-compatible / self-hosted endpoints. */
  baseURL?: string;
  /** Auth mechanism; "none" is allowed only for local/self-host endpoints. */
  authKind: ProviderAuthKind;
  /** Context window in tokens. */
  ctxLimit?: number;
  /** Advisory cost band. */
  costClass: CostClass;
  /** Optional peak surcharge window. */
  peakWindow?: ModelCostWindow;
  /** Optional alias used by the router (maps to a fallback in peak). */
  alias?: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export interface ProbeResult {
  ok: boolean;
  /** Human-readable detail; MUST be pre-redacted (never contains a raw key). */
  detail: string;
}

export type SwapResult =
  | { ok: true; active: ForkModelConfig }
  | { ok: false; rolledBack: true; error: string };

export interface RollbackResult {
  ok: boolean;
  restored: ForkModelConfig | null;
  error?: string;
}

/** Cost-aware routing input. */
export interface RouteWork {
  essential: boolean;
  /** Epoch milliseconds. */
  nowUtc: number;
}

/**
 * BYOK injection record. The key itself is never carried here — only a reference
 * (`env:<VAR>`) plus explicit never-log / redact flags.
 */
export interface ByokInjection {
  provider: string;
  keyRef: `env:${string}`;
  neverLog: true;
  redactInTelemetry: true;
}

/** Adapter contract: one shaped request/response surface, many providers. */
export interface ForkModelAdapter {
  /** Adapter id, e.g. "native-anthropic", "openai-compatible". */
  readonly id: string;
  /** True when this adapter can serve the given config. */
  supports(cfg: ForkModelConfig): boolean;
  /** Shape an outbound request. Key is passed transiently; never stored. */
  buildRequest(cfg: ForkModelConfig, req: AdapterRequest, key?: string): AdapterWireRequest;
  /** Normalize a provider response into the shared shape. */
  parseResponse(raw: unknown): AdapterResponse;
}

/** Provider-agnostic request (mechanism-level, not a full SDK request). */
export interface AdapterRequest {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  tools?: Array<{ name: string; description?: string }>;
  stream?: boolean;
}

/** Provider-agnostic wire request produced by an adapter. */
export interface AdapterWireRequest {
  url?: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  authKind: ProviderAuthKind;
}

/** Provider-agnostic response shape (the 1:1 conformance target). */
export interface AdapterResponse {
  text: string;
  toolCalls: Array<{ name: string; arguments: string }>;
  finishReason: "stop" | "length" | "tool_calls" | "error";
  streaming: boolean;
}

/**
 * The transport that actually delivers a turn to the selected provider and
 * returns the raw provider response. In production this is the real HTTP/SDK
 * client for the provider; in the runtime gate it is an in-process mock that
 * returns a provider-shaped fixture. It is the single I/O boundary of the seam —
 * everything else (route → adapter → buildRequest → parseResponse) is pure.
 *
 * A transport MUST be given a key transiently (never stored) and MUST NOT leak
 * it: the seam redacts every surface it controls, and the transport is the one
 * place a raw key may legitimately touch the wire.
 */
export interface ForkTurnTransport {
  /**
   * Deliver a wire request and return the raw provider response. `key` is the
   * transient BYOK key for the provider (or undefined for `authKind: "none"`).
   * The adapter id and config are supplied so a transport can select the right
   * wire dialect; the response is parsed by the adapter afterwards.
   */
  send(request: AdapterWireRequest, requestMeta: ForkTurnRequestMeta): Promise<unknown>;
}

/** Provider-side metadata for a single served turn (never carries a key). */
export interface ForkTurnRequestMeta {
  adapterId: string;
  provider: string;
  model: string;
}

/** The normalized result of one served turn (the 1:1 shared shape). */
export interface ServeResult {
  /** AdapterResponse normalized from the provider's raw response. */
  response: AdapterResponse;
  /** The adapter id that actually served the turn (e.g. "native-anthropic"). */
  adapterId: string;
  /** The provider/model that served the turn (`provider/model`). */
  servedBy: string;
}

/** The U1 seam surface. */
export interface ForkProviderSeam {
  register(cfg: ForkModelConfig): void;
  list(): ForkModelConfig[];
  validate(cfg: ForkModelConfig): Promise<ValidationResult>;
  probe(cfg: ForkModelConfig): Promise<ProbeResult>;
  swap(next: ForkModelConfig, opts: { atomic: true }): Promise<SwapResult>;
  rollback(): Promise<RollbackResult>;
  route(work: RouteWork): ForkModelConfig;
  /**
   * Serve one complete turn through the adapter selected for the routed model.
   * This is the real runtime path: route → selectAdapter → buildRequest →
   * transport.send → parseResponse. A turn is NEVER served by a provider whose
   * config failed validation; a transport that throws surfaces a redacted error.
   */
  serve(request: AdapterRequest, work?: RouteWork): Promise<ServeResult>;
}

// ---- Zod schemas (additive config surface: fork.models[], fork.router{}) ----

const ProviderAuthKindSchema = z.enum(["api-key", "bearer", "oauth", "none"]);
const CostClassSchema = z.enum(["cheap", "standard", "premium", "custom"]);

export const ModelCostWindowSchema = z
  .strictObject({
    startUtcH: z.number().int().min(0).max(23),
    endUtcH: z.number().int().min(0).max(24),
    multiplier: z.number().positive(),
  })
  .refine((v) => v.endUtcH > v.startUtcH || (v.startUtcH === 0 && v.endUtcH === 24), {
    message: "peakWindow.endUtcH must be after startUtcH",
  });

export const ForkModelConfigSchema = z.strictObject({
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1),
  baseURL: z.string().trim().url().optional(),
  authKind: ProviderAuthKindSchema,
  ctxLimit: z.number().int().positive().optional(),
  costClass: CostClassSchema,
  peakWindow: ModelCostWindowSchema.optional(),
  alias: z.string().trim().min(1).optional(),
});

export const ForkRouterConfigSchema = z
  .strictObject({
    /** When true, non-essential work is downgraded inside a peak window. */
    autoDowngrade: z.boolean().optional(),
    /** Cheap model ref ("provider/model") used for downgraded non-essential work. */
    utilityRef: z.string().trim().min(1).optional(),
  })
  .optional();

export const ForkModelsConfigSchema = z
  .strictObject({
    models: z.array(ForkModelConfigSchema).optional(),
    router: ForkRouterConfigSchema,
  })
  .optional();
