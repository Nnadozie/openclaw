// @fork-seam U1 — provider adapters (native + generic OpenAI-compatible).
//
// Adapters are pure shape-mappers: they do not perform I/O and never store keys.
// The conformance suite asserts every adapter yields the SAME AdapterResponse
// shape for the same semantic fixture (1:1 behaviour-preserving swap).
import { REDACTED } from "./redact.js";
import type {
  AdapterResponse,
  AdapterWireRequest,
  ForkModelAdapter,
  ForkModelConfig,
} from "./types.js";

function joinBaseURL(baseURL: string | undefined, path: string): string | undefined {
  if (!baseURL) {
    return undefined;
  }
  return `${baseURL.replace(/\/+$/, "")}${path}`;
}

function authHeaders(cfg: ForkModelConfig, key: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (!key) {
    return headers;
  }
  switch (cfg.authKind) {
    case "api-key":
      // Anthropic-style key header; the value is transient, never persisted.
      headers["x-api-key"] = key;
      break;
    case "bearer":
    case "oauth":
      headers.authorization = `Bearer ${key}`;
      break;
    default:
      break;
  }
  return headers;
}

/** Anthropic native Messages API shape. */
export const nativeAnthropicAdapter: ForkModelAdapter = {
  id: "native-anthropic",
  supports(cfg) {
    return cfg.provider === "anthropic";
  },
  buildRequest(cfg, req, key) {
    const system = req.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    const messages = req.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: [{ type: "text", text: m.content }] }));
    const body: Record<string, unknown> = {
      model: cfg.model,
      max_tokens: 1024,
      messages,
      stream: Boolean(req.stream),
    };
    if (system) {
      body.system = system;
    }
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        input_schema: { type: "object" },
      }));
    }
    return {
      url: joinBaseURL(cfg.baseURL, "/v1/messages"),
      headers: authHeaders(cfg, key),
      body,
      authKind: cfg.authKind,
    };
  },
  parseResponse(raw) {
    return parseAnthropicResponse(raw);
  },
};

/** Generic OpenAI Chat Completions-compatible shape (OpenAI, DeepSeek, Together, self-host). */
export const openAiCompatibleAdapter: ForkModelAdapter = {
  id: "openai-compatible",
  supports() {
    return true; // universal fallback
  },
  buildRequest(cfg, req, key) {
    const body: Record<string, unknown> = {
      model: cfg.model,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      stream: Boolean(req.stream),
    };
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description ?? "" },
      }));
    }
    return {
      url: joinBaseURL(cfg.baseURL, "/v1/chat/completions"),
      headers: authHeaders(cfg, key),
      body,
      authKind: cfg.authKind,
    };
  },
  parseResponse(raw) {
    return parseOpenAiCompatibleResponse(raw);
  },
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Normalize an Anthropic Messages response into the shared shape. */
function parseAnthropicResponse(raw: unknown): AdapterResponse {
  const root = asRecord(raw);
  const content = Array.isArray(root.content) ? root.content : [];
  let text = "";
  const toolCalls: AdapterResponse["toolCalls"] = [];
  for (const block of content) {
    const b = asRecord(block);
    if (b.type === "text" && typeof b.text === "string") {
      text += b.text;
    } else if (b.type === "tool_use") {
      toolCalls.push({
        name: typeof b.name === "string" ? b.name : "",
        arguments: JSON.stringify(b.input ?? {}),
      });
    }
  }
  return {
    text,
    toolCalls,
    finishReason: mapFinishReason(root.stop_reason, toolCalls.length > 0),
    streaming: false,
  };
}

/** Normalize an OpenAI Chat Completions response into the shared shape. */
function parseOpenAiCompatibleResponse(raw: unknown): AdapterResponse {
  const root = asRecord(raw);
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const first = asRecord(choices[0]);
  const message = asRecord(first.message);
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.map((tc) => {
        const t = asRecord(tc);
        const fn = asRecord(t.function);
        return {
          name: typeof fn.name === "string" ? fn.name : "",
          arguments: typeof fn.arguments === "string" ? fn.arguments : "{}",
        };
      })
    : [];
  return {
    text: typeof message.content === "string" ? message.content : "",
    toolCalls,
    finishReason: mapFinishReason(first.finish_reason, toolCalls.length > 0),
    streaming: false,
  };
}

function mapFinishReason(raw: unknown, hasToolCalls: boolean): AdapterResponse["finishReason"] {
  if (hasToolCalls) {
    return "tool_calls";
  }
  switch (raw) {
    case "end_turn":
    case "stop":
      return "stop";
    case "max_tokens":
    case "length":
      return "length";
    case "tool_use":
    case "tool_calls":
      return "tool_calls";
    default:
      return "stop";
  }
}

/** Ordered adapter registry used by the seam: native first, generic last. */
export const DEFAULT_ADAPTERS: readonly ForkModelAdapter[] = [
  nativeAnthropicAdapter,
  openAiCompatibleAdapter,
];

/** Pick the first adapter that supports the config (generic always matches). */
export function selectAdapter(
  cfg: ForkModelConfig,
  adapters: readonly ForkModelAdapter[] = DEFAULT_ADAPTERS,
): ForkModelAdapter | undefined {
  return adapters.find((adapter) => adapter.supports(cfg));
}

/** Exposed for tests: assert a request produces no raw key in any field. */
export function wireRequestHasNoKey(wire: AdapterWireRequest, key: string): boolean {
  const serialized = JSON.stringify(wire);
  return key.length > 0 && !serialized.includes(key) ? true : key.length === 0;
}

/** Exposed for tests: the redaction marker re-exported for assertions. */
export { REDACTED };
