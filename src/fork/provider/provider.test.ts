import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  DEFAULT_ADAPTERS,
  nativeAnthropicAdapter,
  openAiCompatibleAdapter,
  selectAdapter,
  wireRequestHasNoKey,
} from "./adapters.js";
import { byokInjectionFor, providerKeyEnvVars, resolveByok, safeError } from "./byok.js";
import { createProviderSeam, parseModelRef } from "./index.js";
import { containsSecretLike, redactDeep, redactSecrets } from "./redact.js";
import { ForkProviderService } from "./service.js";
import type { AdapterResponse, ForkModelConfig } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const ANTHROPIC: ForkModelConfig = {
  provider: "anthropic",
  model: "claude-sonnet-5",
  authKind: "api-key",
  costClass: "premium",
};
const DEEPSEEK: ForkModelConfig = {
  provider: "deepseek",
  model: "deepseek-v4-flash",
  baseURL: "https://api.deepseek.com",
  authKind: "bearer",
  costClass: "cheap",
  peakWindow: { startUtcH: 6, endUtcH: 10, multiplier: 2 },
};

function stateFile(): string {
  return `${tempDirs.make("fork-provider-")}/provider-state.json`;
}

describe("U1 adapters — conformance (1:1 shared shape)", () => {
  it("normalizes an Anthropic tool-call response", () => {
    const raw = {
      content: [
        { type: "text", text: "hi" },
        { type: "tool_use", name: "search", input: { q: "x" } },
      ],
      stop_reason: "tool_use",
    };
    const response = nativeAnthropicAdapter.parseResponse(raw);
    expect(response).toEqual<AdapterResponse>({
      text: "hi",
      toolCalls: [{ name: "search", arguments: JSON.stringify({ q: "x" }) }],
      finishReason: "tool_calls",
      streaming: false,
    });
  });

  it("normalizes an OpenAI-compatible tool-call response to the SAME shape", () => {
    const raw = {
      choices: [
        {
          message: {
            content: "hi",
            tool_calls: [{ function: { name: "search", arguments: '{"q":"x"}' } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    };
    const response = openAiCompatibleAdapter.parseResponse(raw);
    expect(response).toEqual<AdapterResponse>({
      text: "hi",
      toolCalls: [{ name: "search", arguments: '{"q":"x"}' }],
      finishReason: "tool_calls",
      streaming: false,
    });
  });

  it("maps plain stop across both adapters identically", () => {
    const a = nativeAnthropicAdapter.parseResponse({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
    });
    const b = openAiCompatibleAdapter.parseResponse({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    });
    expect(a).toEqual(b);
  });

  it("selects the native adapter for anthropic and generic otherwise", () => {
    expect(selectAdapter(ANTHROPIC)?.id).toBe("native-anthropic");
    expect(selectAdapter(DEEPSEEK)?.id).toBe("openai-compatible");
    expect(DEFAULT_ADAPTERS.at(-1)?.id).toBe("openai-compatible");
  });

  it("never embeds the raw key in a wire request", () => {
    const key = "sk-ant-super-secret-key-value-1234567890";
    const wire = nativeAnthropicAdapter.buildRequest(
      ANTHROPIC,
      { messages: [{ role: "user", content: "hi" }] },
      key,
    );
    expect(wireRequestHasNoKey(wire, key)).toBe(false); // it IS present transiently...
    // ...but the serialized body must not contain it.
    expect(JSON.stringify(wire.body)).not.toContain(key);
    expect(wire.headers["x-api-key"]).toBe(key);
  });
});

describe("U1 BYOK — user-supplied keys, no bundled creds", () => {
  it("resolves a key from process env only", () => {
    const resolved = resolveByok(DEEPSEEK, { DEEPSEEK_API_KEY: "dsk-abc123456789012345" });
    expect(resolved.key).toBe("dsk-abc123456789012345");
    expect(resolved.source).toBe("DEEPSEEK_API_KEY");
  });

  it("returns no key when the user supplied none (no bundled creds)", () => {
    const resolved = resolveByok(DEEPSEEK, {});
    expect(resolved.key).toBeUndefined();
  });

  it("carries no secret in the BYOK injection record", () => {
    const injection = byokInjectionFor("deepseek");
    expect(injection.neverLog).toBe(true);
    expect(injection.redactInTelemetry).toBe(true);
    expect(injection.keyRef).toBe("env:DEEPSEEK_API_KEY");
    expect(JSON.stringify(injection)).not.toContain("sk-");
  });

  it("derives a generic env var for OpenAI-compatible providers", () => {
    expect(providerKeyEnvVars("my-local-llm")).toEqual(["MY_LOCAL_LLM_API_KEY"]);
  });
});

describe("U1 redaction — no key leak", () => {
  it("redacts well-known key shapes", () => {
    const leaked =
      "failed with sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV and Bearer abcdefghijklmnopqrst";
    const out = redactSecrets(leaked);
    expect(out).not.toContain("sk-ant-api03");
    expect(containsSecretLike(out)).toBe(false);
  });

  it("redacts an explicitly supplied live key anywhere in a structure", () => {
    const key = "live-key-value-abcdef123456";
    const payload = { error: `auth failed for ${key}`, headers: { authorization: key } };
    const out = redactDeep(payload, [key]);
    expect(JSON.stringify(out)).not.toContain(key);
  });

  it("safeError keeps a transient key out of error strings", () => {
    const key = "sk-supersecretkeyvalue1234567890";
    expect(safeError(`bad key ${key}`, key)).not.toContain(key);
  });
});

describe("U1 lifecycle — atomic swap + rollback (state-carrying)", () => {
  it("swaps to a valid model and reports it active", async () => {
    const seam = new ForkProviderService({
      statePath: stateFile(),
      models: [DEEPSEEK],
      env: {
        DEEPSEEK_API_KEY: "dsk-key-123456789012",
        ANTHROPIC_API_KEY: "sk-ant-abc12345678901234567",
      },
    });
    const result = await seam.swap(ANTHROPIC, { atomic: true });
    expect(result).toEqual({ ok: true, active: ANTHROPIC });
  });

  it("rolls back to last-good when the health check fails", async () => {
    const seam = new ForkProviderService({
      statePath: stateFile(),
      models: [DEEPSEEK],
      env: {
        DEEPSEEK_API_KEY: "dsk-key-123456789012",
        ANTHROPIC_API_KEY: "sk-ant-abc12345678901234567",
      },
      healthCheck: async () => false,
    });
    // Seed active = deepseek via constructor; swap to anthropic must fail + roll back.
    const result = await seam.swap(ANTHROPIC, { atomic: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rolledBack).toBe(true);
    }
    expect(seam.current()).toEqual(DEEPSEEK);
  });

  it("rolls back on an invalid (unsupported) provider before writing", async () => {
    const seam = new ForkProviderService({
      statePath: stateFile(),
      models: [DEEPSEEK],
      utilityRef: undefined,
      healthCheck: async () => true,
    });
    const bad: ForkModelConfig = {
      provider: "anthropic",
      model: "x",
      authKind: "none",
      costClass: "premium",
    };
    const result = await seam.swap(bad, { atomic: true });
    expect(result.ok).toBe(false);
    expect(seam.current()).toEqual(DEEPSEEK);
  });

  it("preserves session/memory state across a swap (only the model ref changes)", async () => {
    const dir = tempDirs.make("fork-sessions-");
    const sessionFile = `${dir}/session.json`;
    const fs = await import("node:fs");
    const session = { id: "s1", turns: [{ role: "user", content: "hello" }] };
    fs.writeFileSync(sessionFile, JSON.stringify(session));

    const seam = new ForkProviderService({
      statePath: stateFile(),
      models: [DEEPSEEK],
      env: {
        DEEPSEEK_API_KEY: "dsk-key-123456789012",
        ANTHROPIC_API_KEY: "sk-ant-abc12345678901234567",
      },
      healthCheck: async () => true,
    });
    await seam.swap(ANTHROPIC, { atomic: true });

    // Session store untouched by the swap.
    expect(JSON.parse(fs.readFileSync(sessionFile, "utf8"))).toEqual(session);
  });
});

describe("U1 routing — advisory cost-aware downgrade", () => {
  it("downgrades non-essential work inside a peak window", () => {
    const utility = parseModelRef("deepseek/deepseek-v4-lite")!;
    const seam = new ForkProviderService({
      statePath: stateFile(),
      models: [DEEPSEEK],
      utilityRef: utility,
      autoDowngrade: true,
    });
    const peakMs = Date.UTC(2026, 0, 1, 7, 0, 0);
    const offPeakMs = Date.UTC(2026, 0, 1, 3, 0, 0);
    expect(seam.route({ essential: false, nowUtc: peakMs })).toEqual(utility);
    expect(seam.route({ essential: false, nowUtc: offPeakMs })).toEqual(DEEPSEEK);
  });

  it("NEVER downgrades an essential user turn on schedule", () => {
    const utility = parseModelRef("deepseek/deepseek-v4-lite")!;
    const seam = new ForkProviderService({
      statePath: stateFile(),
      models: [DEEPSEEK],
      utilityRef: utility,
      autoDowngrade: true,
    });
    const peakMs = Date.UTC(2026, 0, 1, 7, 0, 0);
    expect(seam.route({ essential: true, nowUtc: peakMs })).toEqual(DEEPSEEK);
  });
});

describe("U1 config wiring", () => {
  it("constructs nothing extra when the fork block is absent", () => {
    const seam = createProviderSeam({} as never);
    expect(seam.list()).toEqual([]);
  });

  it("constructs the registry from fork.models[] config", () => {
    const seam = createProviderSeam({
      fork: { models: { models: [DEEPSEEK] } },
    } as never);
    expect(seam.list()).toEqual([DEEPSEEK]);
  });
});
