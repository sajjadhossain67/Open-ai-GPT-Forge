import type { ProviderInfo, TokenUsage } from "../../shared/types.js";
import { parseSseStream } from "./sse.js";
import { LlmFailure, type LlmAdapter, type LlmMessage, type LlmRequest, type LlmStreamChunk, type LlmToolCall } from "./types.js";

export interface AnthropicConfig {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  models?: string[];
}

function toAnthropicMessages(messages: LlmMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      out.push({ role: "user", content: msg.content });
    } else if (msg.role === "assistant") {
      const blocks: Array<Record<string, unknown>> = [];
      if (msg.content) blocks.push({ type: "text", text: msg.content });
      for (const call of msg.toolCalls ?? []) {
        let parsedInput: unknown = {};
        try {
          parsedInput = JSON.parse(call.arguments || "{}");
        } catch {
          parsedInput = {};
        }
        blocks.push({ type: "tool_use", id: call.id, name: call.name, input: parsedInput });
      }
      out.push({ role: "assistant", content: blocks.length > 0 ? blocks : [{ type: "text", text: "" }] });
    } else if (msg.role === "tool") {
      const resultBlock = {
        type: "tool_result",
        tool_use_id: msg.toolCallId,
        content: msg.content,
        ...(msg.isError ? { is_error: true } : {}),
      };
      const prev = out.at(-1);
      if (prev && prev.role === "user" && Array.isArray(prev.content)) {
        (prev.content as Array<Record<string, unknown>>).push(resultBlock);
      } else {
        out.push({ role: "user", content: [resultBlock] });
      }
    }
  }
  return out;
}

/**
 * Native streaming adapter for Anthropic Messages API (`/v1/messages`).
 * Supports text deltas, extended thinking deltas, and tool_use streaming blocks.
 */
export class AnthropicAdapter implements LlmAdapter {
  readonly id = "anthropic" as const;
  readonly label = "Anthropic";
  readonly defaultModel: string;
  readonly models: string[];
  readonly supportsReasoning = true;
  readonly supportsTools = true;
  readonly #apiKey?: string;
  readonly #baseUrl: string;

  constructor(config: AnthropicConfig = {}) {
    this.#apiKey = config.apiKey?.trim() || undefined;
    this.#baseUrl = (config.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/+$/, "");
    this.defaultModel = config.defaultModel ?? "claude-sonnet-4-20250514";
    this.models = config.models ?? [
      "claude-sonnet-4-20250514",
      "claude-3-7-sonnet-20250219",
      "claude-3-5-haiku-20241022",
    ];
  }

  isConfigured(): boolean {
    return Boolean(this.#apiKey);
  }

  info(): ProviderInfo {
    return {
      id: this.id,
      label: this.label,
      configured: this.isConfigured(),
      defaultModel: this.defaultModel,
      models: this.models,
      supportsReasoning: this.supportsReasoning,
      supportsTools: this.supportsTools,
    };
  }

  async *stream(request: LlmRequest): AsyncGenerator<LlmStreamChunk, void, void> {
    if (!this.#apiKey) {
      throw new LlmFailure(this.id, "Anthropic API key is not configured (set ANTHROPIC_API_KEY).", {
        code: "NOT_CONFIGURED",
        status: 401,
      });
    }

    const body: Record<string, unknown> = {
      model: request.model || this.defaultModel,
      max_tokens: request.maxTokens ?? 4096,
      stream: true,
      messages: toAnthropicMessages(request.messages),
    };
    if (request.systemPrompt.trim()) body.system = request.systemPrompt;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      }));
    }

    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.#apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal: request.signal,
      });
    } catch (error) {
      if (request.signal.aborted) {
        yield { type: "finish", reason: "aborted" };
        return;
      }
      throw new LlmFailure(
        this.id,
        `Failed to connect to Anthropic: ${error instanceof Error ? error.message : String(error)}`,
        { code: "NETWORK_ERROR", retryable: true, cause: error },
      );
    }

    if (!response.ok || !response.body) {
      const errorText = await response.text().catch(() => response.statusText);
      const retryable = response.status === 429 || response.status >= 500;
      const code =
        response.status === 401
          ? "AUTH_FAILED"
          : response.status === 429
            ? "RATE_LIMITED"
            : /prompt is too long|context|token/i.test(errorText)
              ? "CONTEXT_OVERFLOW"
              : "HTTP_ERROR";
      throw new LlmFailure(this.id, `Anthropic returned ${response.status}: ${errorText.slice(0, 400)}`, {
        code,
        status: response.status,
        retryable,
      });
    }

    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason: "stop" | "tool-calls" | "length" | "error" | "aborted" = "stop";

    for await (const frame of parseSseStream(response.body, request.signal)) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(frame.data) as Record<string, unknown>;
      } catch {
        continue;
      }

      const type = String(data.type ?? frame.event ?? "");
      if (type === "message_start") {
        const msg = data.message as { usage?: { input_tokens?: number } } | undefined;
        inputTokens = msg?.usage?.input_tokens ?? 0;
      } else if (type === "content_block_start") {
        const index = Number(data.index ?? 0);
        const block = data.content_block as { type?: string; id?: string; name?: string } | undefined;
        if (block?.type === "tool_use") {
          toolCalls.set(index, {
            id: block.id ?? `toolu_${index}`,
            name: block.name ?? "",
            arguments: "",
          });
        }
      } else if (type === "content_block_delta") {
        const index = Number(data.index ?? 0);
        const delta = data.delta as { type?: string; text?: string; thinking?: string; partial_json?: string } | undefined;
        if (delta?.type === "text_delta" && delta.text) {
          yield { type: "text-delta", text: delta.text };
        } else if (delta?.type === "thinking_delta" && delta.thinking) {
          yield { type: "reasoning-delta", text: delta.thinking };
        } else if (delta?.type === "input_json_delta" && delta.partial_json) {
          const call = toolCalls.get(index);
          if (call) call.arguments += delta.partial_json;
        }
      } else if (type === "message_delta") {
        const delta = data.delta as { stop_reason?: string } | undefined;
        const usage = data.usage as { output_tokens?: number } | undefined;
        if (usage?.output_tokens !== undefined) outputTokens = usage.output_tokens;
        if (delta?.stop_reason === "tool_use") finishReason = "tool-calls";
        else if (delta?.stop_reason === "max_tokens") finishReason = "length";
      } else if (type === "error") {
        const err = data.error as { message?: string } | undefined;
        throw new LlmFailure(this.id, err?.message ?? "Anthropic stream error", { code: "STREAM_ERROR" });
      }
    }

    if (request.signal.aborted) {
      yield { type: "finish", reason: "aborted" };
      return;
    }

    const orderedCalls: LlmToolCall[] = [...toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => ({
        id: call.id,
        name: call.name,
        arguments: call.arguments || "{}",
      }));

    for (const call of orderedCalls) {
      yield { type: "tool-call", call };
    }
    if (orderedCalls.length > 0) finishReason = "tool-calls";

    if (inputTokens > 0 || outputTokens > 0) {
      const usage: TokenUsage = {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      };
      yield { type: "usage", usage };
    }
    yield { type: "finish", reason: finishReason };
  }
}
