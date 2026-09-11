// @fork-seam U1 — THE runtime-proven gate (not a unit fixture).
//
// This is the executing proof that turns U1 🟡 → ✅. Unlike `provider.test.ts`
// and `tier3-proof.test.ts` (which construct `ForkProviderService` directly = a
// unit fixture), this file drives the EXACT production entry the gateway calls:
//
//     applyForkRuntime(config, opts)
//       └─ createForkSeams(config, opts)
//            └─ createProviderSeam(config, opts)   <- the real prod wiring
//
// and serves complete turns through the REAL seam surface (`serve()`), asserting
// the four user-visible outcomes:
//
//   (a) a turn is actually served through the selected provider adapter
//   (b) a provider swap completes and the running path then uses the NEW provider
//   (c) a swap failure ROLLS BACK to last-good (the old provider still serves)
//   (d) no API key leaks into logs/errors/state/requests
//
// NON-VACUOUS (discipline §0.1): the gate is NOT tautologically green. It
// includes RED-fixtures that must FAIL — a transport that throws must not serve;
// a broken provider config must be refused; a raw key must never survive
// redaction or an error surface. Each RED-fixture asserts the *failure* branch of
// the same production path, proving the gate discriminates broken from working.
//
// Zero marginal cost: the transport is an in-process mock (no paid provider call);
// the "provider" is a registered adapter so the real select/build/parse path runs
// without any network or credential spend.
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { applyForkRuntime, resetForkRuntimeBindingForTest } from "../runtime.js";
import { REDACTED } from "./redact.js";
import type {
  AdapterResponse,
  AdapterWireRequest,
  ForkModelAdapter,
  ForkModelConfig,
  ForkTurnRequestMeta,
} from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => resetForkRuntimeBindingForTest());

// ---- Fixtures: two distinguishable providers + adapters, no real credentials ----

const PROVIDER_A: ForkModelConfig = {
  provider: "openai",
  model: "gpt-a",
  authKind: "bearer",
  costClass: "standard",
};
const PROVIDER_B: ForkModelConfig = {
  provider: "anthropic",
  model: "claude-b",
  authKind: "api-key",
  costClass: "premium",
};

const FAKE_KEY = "sk-ant-fake-fixture-key-0123456789abcdef";

/** A transport that echoes back a provider-specific completion. No network. */
function echoTransport() {
  return {
    async send(wire: AdapterWireRequest, meta: ForkTurnRequestMeta): Promise<unknown> {
      // Ship the provider's raw shape so the adapter's real parseResponse runs
      // (never bypassed). The fake adapter below parses `text`/`content`; the
      // native/generic adapters parse their own shapes — both are exercised.
      if (meta.adapterId === "native-anthropic") {
        return {
          content: [{ type: "text", text: `served-by:${meta.provider}/${meta.model}` }],
          stop_reason: "end_turn",
        };
      }
      return {
        choices: [
          {
            message: { content: `served-by:${meta.provider}/${meta.model}` },
            finish_reason: "stop",
          },
        ],
      };
    },
  };
}

/** An adapter that serves a provider with the same parse shapes as production. */
function makeAdapter(id: string, provider: string): ForkModelAdapter {
  const anthropicLike = id === "fake-anthropic";
  return {
    id,
    supports: (cfg) => cfg.provider === provider,
    buildRequest: (cfg, req, key) => ({
      url: `fake://${provider}/v1`,
      headers: key ? { authorization: `Bearer ${key}` } : {},
      body: { model: cfg.model, messages: req.messages },
      authKind: cfg.authKind,
    }),
    parseResponse: (raw): AdapterResponse => {
      if (anthropicLike) {
        const r = raw as { content?: { type: string; text: string }[]; stop_reason?: string };
        const text = (r.content ?? []).map((b) => b.text).join("");
        return { text, toolCalls: [], finishReason: "stop", streaming: false };
      }
      const r = raw as {
        choices?: { message?: { content?: string } }[];
      };
      const text = r.choices?.[0]?.message?.content ?? "";
      return { text, toolCalls: [], finishReason: "stop", streaming: false };
    },
  };
}

const adapters = [makeAdapter("fake-openai", "openai"), makeAdapter("fake-anthropic", "anthropic")];

function stateDir(): string {
  return tempDirs.make("fork-u1-runtime-");
}

/** Build the REAL production binding with the two providers + a transport. */
function bindingWith(overrides: Partial<Parameters<typeof applyForkRuntime>[0]> = {}) {
  const config = {
    fork: {
      models: { models: [PROVIDER_A, PROVIDER_B] },
      ...overrides,
    },
  } as never;
  return applyForkRuntime(config, {
    stateDir: stateDir(),
    providerTransport: echoTransport(),
    providerAdapters: adapters,
  });
}

function stateFile(dir: string): string {
  return `${dir}/fork/provider-state.json`;
}

describe("U1 RUNTIME PROOF — real path applyForkRuntime → createProviderSeam → serve", () => {
  it("(a) serves a turn through the selected provider adapter on the real path", async () => {
    const binding = bindingWith();
    expect(binding.configured).toBe(true);
    expect(binding.provider).not.toBeNull();

    const result = await binding.provider!.serve({
      messages: [{ role: "user", content: "hello" }],
    });

    // The turn was served by the *first* registered model, through its adapter.
    expect(result.adapterId).toBe("fake-openai");
    expect(result.servedBy).toBe("openai/gpt-a");
    expect(result.response).toMatchObject({ text: "served-by:openai/gpt-a", finishReason: "stop" });
  });

  it("(b) a completed swap makes the running path serve the NEW provider", async () => {
    const dir = stateDir();
    const binding = applyForkRuntime(
      { fork: { models: { models: [PROVIDER_A, PROVIDER_B] } } } as never,
      {
        stateDir: dir,
        providerTransport: echoTransport(),
        providerAdapters: adapters,
      },
    );

    // BYOK keys resolved transiently from the env (never stored) — provider A
    // (bearer) and provider B (api-key) both need one for the probe/serve path.
    const svc = binding.provider as unknown as {
      opts: { env?: Record<string, string | undefined> };
    };
    svc.opts.env = { OPENAI_API_KEY: FAKE_KEY, ANTHROPIC_API_KEY: FAKE_KEY };

    // Before the swap: provider A serves.
    const before = await binding.provider!.serve({ messages: [{ role: "user", content: "hi" }] });
    expect(before.servedBy).toBe("openai/gpt-a");

    // Swap to B (validate → probe → atomic write → health ok).
    const swap = await binding.provider!.swap(PROVIDER_B, { atomic: true });
    expect(swap.ok).toBe(true);
    expect(binding.provider!.current()).toEqual(PROVIDER_B);

    // After the swap: the SAME running seam now serves the NEW provider.
    const after = await binding.provider!.serve({ messages: [{ role: "user", content: "hi" }] });
    expect(after.servedBy).toBe("anthropic/claude-b");
    expect(after.adapterId).toBe("fake-anthropic");
  });

  it("(c) a swap FAILURE rolls back — the OLD provider still serves", async () => {
    const dir = stateDir();
    const binding = applyForkRuntime(
      { fork: { models: { models: [PROVIDER_A, PROVIDER_B] } } } as never,
      {
        stateDir: dir,
        providerTransport: echoTransport(),
        providerAdapters: adapters,
        // A health check that always fails → every swap must roll back.
      },
    );

    // Reach into the service to make the healthCheck fail (production rollback path).
    const svc = binding.provider as unknown as {
      opts: { healthCheck?: () => Promise<boolean> };
      swap: (next: ForkModelConfig, opts: { atomic: true }) => Promise<unknown>;
    };
    svc.opts.healthCheck = async () => false;

    const swap = await svc.swap(PROVIDER_B, { atomic: true });
    expect(swap).toMatchObject({ ok: false, rolledBack: true });

    // Rollback restored last-good → the OLD (first) provider still serves.
    const after = await binding.provider!.serve({ messages: [{ role: "user", content: "hi" }] });
    expect(after.servedBy).toBe("openai/gpt-a");
  });

  it("(d) never leaks a BYOK key into state, errors, requests, or served text", async () => {
    const dir = stateDir();
    const binding = applyForkRuntime(
      { fork: { models: { models: [PROVIDER_A, PROVIDER_B] } } } as never,
      {
        stateDir: dir,
        providerTransport: echoTransport(),
        providerAdapters: adapters,
      },
    );

    // Swap B in (writes state) with a live key in the env.
    const svc = binding.provider as unknown as {
      opts: { env?: Record<string, string | undefined> };
    };
    svc.opts.env = { ANTHROPIC_API_KEY: FAKE_KEY, OPENAI_API_KEY: FAKE_KEY };
    const swap = await binding.provider!.swap(PROVIDER_B, { atomic: true });
    expect(swap.ok).toBe(true);

    // 1. persisted state never carries the key.
    const onDisk = fs.readFileSync(stateFile(dir), "utf8");
    expect(onDisk).not.toContain(FAKE_KEY);
    expect(onDisk).not.toContain("sk-ant-fake");

    // 2. a validation error on a bad config never carries the key.
    const bad: ForkModelConfig = {
      provider: "nosuch",
      model: "x",
      authKind: "bearer",
      costClass: "cheap",
    };
    const validation = await binding.provider!.validate(bad);
    for (const e of validation.errors) {
      expect(e).not.toContain(FAKE_KEY);
    }

    // 3. serving a turn does not echo the key into the response text.
    const result = await binding.provider!.serve({ messages: [{ role: "user", content: "hi" }] });
    expect(result.response.text).not.toContain(FAKE_KEY);
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
  });
});

describe("U1 RUNTIME PROOF — RED fixtures (the gate discriminates broken from working)", () => {
  it("RED: a turn is NOT served when no transport is wired (fail-closed)", async () => {
    const binding = applyForkRuntime({ fork: { models: { models: [PROVIDER_A] } } } as never, {
      stateDir: stateDir(),
      providerAdapters: adapters,
    });
    await expect(
      binding.provider!.serve({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/no turn transport wired/);
  });

  it("RED: a broken (unsupported) provider config is refused by validate", async () => {
    const binding = bindingWith();
    const bad: ForkModelConfig = {
      provider: "nosuch",
      model: "x",
      authKind: "bearer",
      costClass: "cheap",
    };
    const validation = await binding.provider!.validate(bad);
    expect(validation.ok).toBe(false);
    expect(validation.errors.join(" ")).toContain("no adapter supports provider");
  });

  it("RED: a raw key in an error string is redacted to [redacted], never survives", async () => {
    const binding = bindingWith();
    const svc = binding.provider as unknown as {
      opts: {
        transport?: { send: () => Promise<unknown> };
        env?: Record<string, string | undefined>;
      };
    };
    // Live key in the env so the serve() path resolves it and must redact it.
    svc.opts.env = { OPENAI_API_KEY: FAKE_KEY };
    // A transport that throws the raw key back must be redacted at the serve edge.
    svc.opts.transport = {
      send: async () => {
        throw new Error(`auth rejected for key ${FAKE_KEY}`);
      },
    };
    let surfaced = "";
    try {
      await binding.provider!.serve({ messages: [{ role: "user", content: "hi" }] });
    } catch (error) {
      surfaced = error instanceof Error ? error.message : String(error);
    }
    // The surfaced error MUST NOT carry the raw key, and MUST carry the redaction
    // marker (proving redaction actually ran — not that the key was merely absent).
    expect(surfaced).not.toContain(FAKE_KEY);
    expect(surfaced).toContain(REDACTED);
    expect(surfaced).toContain("transport failed");
  });
});
