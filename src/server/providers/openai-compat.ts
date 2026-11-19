import type { ProviderId, ProviderInfo, TokenUsage } from "../../shared/types.js";
import { parseSseStream } from "./sse.js";
import { LlmFailure, type LlmAdapter, type LlmMessage, type LlmRequest, type LlmStreamChunk, type LlmToolCall } from "./types.js";

export interface OpenAICompatConfig {
  id: ProviderId;
  label: string;
  baseUrl: string;
  apiKey?: string;
  requireApiKey?: boolean;
  defaultModel: string;
  models: string[];
  supportsReasoning?: boolean;
  extraHeaders?: Record<string, string>;
}

interface OpenAIChatChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

function toWireMessages(systemPrompt: string, messages: LlmMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  if (systemPrompt.trim()) {
    out.push({ role: "system", content: systemPrompt });
  }
  for (const msg of messages) {
    if (msg.role === "user") {
      out.push({ role: "user", content: msg.content });
    } else if (msg.role === "assistant") {
      const entry: Record<string, unknown> = {
        role: "assistant",
        content: msg.content || null,
      };
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        entry.tool_calls = msg.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        }));
      }
      out.push(entry);
    } else if (msg.role === "tool") {
      out.push({
        role: "tool",
        tool_call_id: msg.toolCallId,
        content: msg.content,
      });
    }
  }
  return out;
}

/**
 * Native streaming adapter for OpenAI-compatible Chat Completions endpoints:
 * - OpenAI (`https://api.openai.com/v1`)
 * - DeepSeek (`https://api.deepseek.com/v1`, including `reasoning_content`)
 * - Local LLMs (Ollama `http://127.0.0.1:11434/v1`, LM Studio, vLLM, etc.)
 */
export class OpenAICompatAdapter implements LlmAdapter {
  readonly id: ProviderId;
  readonly label: string;
  readonly defaultModel: string;
  readonly models: string[];
  readonly supportsReasoning: boolean;
  readonly supportsTools = true;
  readonly #baseUrl: string;
  readonly #apiKey?: string;
  readonly #requireApiKey: boolean;
  readonly #extraHeaders: Record<string, string>;

  constructor(config: OpenAICompatConfig) {
    this.id = config.id;
    this.label = config.label;
    this.#baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.#apiKey = config.apiKey?.trim() || undefined;
    this.#requireApiKey = config.requireApiKey ?? true;
    this.defaultModel = config.defaultModel;
    this.models = config.models;
    this.supportsReasoning = config.supportsReasoning ?? false;
    this.#extraHeaders = config.extraHeaders ?? {};
  }

  isConfigured(): boolean {
    return !this.#requireApiKey || Boolean(this.#apiKey);
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
    if (!this.isConfigured()) {
      throw new LlmFailure(this.id, `${this.label} API key is not configured.`, {
        code: "NOT_CONFIGURED",
        status: 401,
      });
    }

    const body: Record<string, unknown> = {
      model: request.model || this.defaultModel,
      messages: toWireMessages(request.systemPrompt, request.messages),
      stream: true,
    };
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
    }
    if (this.id === "openai" || this.id === "deepseek") {
      body.stream_options = { include_usage: true };
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.#extraHeaders,
    };
    if (this.#apiKey) {
      headers.Authorization = `Bearer ${this.#apiKey}`;
    }

    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}/chat/completions`, {
        method: "POST",
        headers,
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
        `Failed to connect to ${this.label}: ${error instanceof Error ? error.message : String(error)}`,
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
            : /context|token|length/i.test(errorText)
              ? "CONTEXT_OVERFLOW"
              : "HTTP_ERROR";
      throw new LlmFailure(this.id, `${this.label} returned ${response.status}: ${errorText.slice(0, 400)}`, {
        code,
        status: response.status,
        retryable,
      });
    }

    const pendingCalls = new Map<number, { id: string; name: string; arguments: string }>();
    let finishReason: "stop" | "tool-calls" | "length" | "error" | "aborted" = "stop";
    let usage: TokenUsage | undefined;

    for await (const frame of parseSseStream(response.body, request.signal)) {
      if (frame.data === "[DONE]") break;
      let parsed: OpenAIChatChunk;
      try {
        parsed = JSON.parse(frame.data) as OpenAIChatChunk;
      } catch {
        continue;
      }

      if (parsed.usage) {
        usage = {
          inputTokens: parsed.usage.prompt_tokens ?? 0,
          outputTokens: parsed.usage.completion_tokens ?? 0,
          totalTokens:
            parsed.usage.total_tokens ??
            (parsed.usage.prompt_tokens ?? 0) + (parsed.usage.completion_tokens ?? 0),
          reasoningTokens: parsed.usage.completion_tokens_details?.reasoning_tokens,
        };
      }

      const choice = parsed.choices?.[0];
      if (!choice) continue;

      const delta = choice.delta;
      if (delta?.reasoning_content) {
        yield { type: "reasoning-delta", text: delta.reasoning_content };
      } else if (delta?.reasoning) {
        yield { type: "reasoning-delta", text: delta.reasoning };
      }
      if (delta?.content) {
        yield { type: "text-delta", text: delta.content };
      }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const existing = pendingCalls.get(tc.index) ?? {
            id: tc.id ?? `call_${tc.index}`,
            name: "",
            arguments: "",
          };
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name += tc.function.name;
          if (tc.function?.arguments) existing.arguments += tc.function.arguments;
          pendingCalls.set(tc.index, existing);
        }
      }

      if (choice.finish_reason === "tool_calls") finishReason = "tool-calls";
      else if (choice.finish_reason === "length") finishReason = "length";
      else if (choice.finish_reason === "stop") finishReason = "stop";
    }

    if (request.signal.aborted) {
      yield { type: "finish", reason: "aborted" };
      return;
    }

    const sortedCalls: LlmToolCall[] = [...pendingCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => ({
        id: call.id,
        name: call.name,
        arguments: call.arguments || "{}",
      }));

    for (const call of sortedCalls) {
      yield { type: "tool-call", call };
    }
    if (sortedCalls.length > 0) finishReason = "tool-calls";
    if (usage) yield { type: "usage", usage };
    yield { type: "finish", reason: finishReason };
  }
}
