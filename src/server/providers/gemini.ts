import { randomUUID } from "node:crypto";
import type { ProviderInfo, TokenUsage } from "../../shared/types.js";
import { parseSseStream } from "./sse.js";
import { LlmFailure, type LlmAdapter, type LlmMessage, type LlmRequest, type LlmStreamChunk, type LlmToolCall } from "./types.js";

export interface GeminiConfig {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  models?: string[];
}

function toGeminiContents(messages: LlmMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      out.push({ role: "user", parts: [{ text: msg.content }] });
    } else if (msg.role === "assistant") {
      const parts: Array<Record<string, unknown>> = [];
      if (msg.content) parts.push({ text: msg.content });
      for (const call of msg.toolCalls ?? []) {
        let args: unknown = {};
        try {
          args = JSON.parse(call.arguments || "{}");
        } catch {
          args = {};
        }
        parts.push({ functionCall: { name: call.name, args } });
      }
      out.push({ role: "model", parts: parts.length > 0 ? parts : [{ text: "" }] });
    } else if (msg.role === "tool") {
      let responseObj: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(msg.content);
        responseObj =
          parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : { result: parsed };
      } catch {
        responseObj = { result: msg.content };
      }
      const part = { functionResponse: { name: msg.toolName, response: responseObj } };
      const prev = out.at(-1);
      if (prev && prev.role === "user" && Array.isArray(prev.parts)) {
        (prev.parts as Array<Record<string, unknown>>).push(part);
      } else {
        out.push({ role: "user", parts: [part] });
      }
    }
  }
  return out;
}

/**
 * Native streaming adapter for Google Gemini (`streamGenerateContent?alt=sse`).
 */
export class GeminiAdapter implements LlmAdapter {
  readonly id = "gemini" as const;
  readonly label = "Google Gemini";
  readonly defaultModel: string;
  readonly models: string[];
  readonly supportsReasoning = true;
  readonly supportsTools = true;
  readonly #apiKey?: string;
  readonly #baseUrl: string;

  constructor(config: GeminiConfig = {}) {
    this.#apiKey = config.apiKey?.trim() || undefined;
    this.#baseUrl = (config.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
    this.defaultModel = config.defaultModel ?? "gemini-2.5-flash";
    this.models = config.models ?? ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"];
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
      throw new LlmFailure(this.id, "Gemini API key is not configured (set GEMINI_API_KEY).", {
        code: "NOT_CONFIGURED",
        status: 401,
      });
    }

    const model = request.model || this.defaultModel;
    const body: Record<string, unknown> = {
      contents: toGeminiContents(request.messages),
    };
    if (request.systemPrompt.trim()) {
      body.systemInstruction = { parts: [{ text: request.systemPrompt }] };
    }
    const generationConfig: Record<string, unknown> = {};
    if (request.maxTokens !== undefined) generationConfig.maxOutputTokens = request.maxTokens;
    if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
    if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;

    if (request.tools.length > 0) {
      body.tools = [
        {
          functionDeclarations: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })),
        },
      ];
    }

    const url = `${this.#baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.#apiKey,
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
        `Failed to connect to Gemini: ${error instanceof Error ? error.message : String(error)}`,
        { code: "NETWORK_ERROR", retryable: true, cause: error },
      );
    }

    if (!response.ok || !response.body) {
      const errorText = await response.text().catch(() => response.statusText);
      const retryable = response.status === 429 || response.status >= 500;
      const code =
        response.status === 401 || response.status === 403
          ? "AUTH_FAILED"
          : response.status === 429
            ? "RATE_LIMITED"
            : /token|context|too large/i.test(errorText)
              ? "CONTEXT_OVERFLOW"
              : "HTTP_ERROR";
      throw new LlmFailure(this.id, `Gemini returned ${response.status}: ${errorText.slice(0, 400)}`, {
        code,
        status: response.status,
        retryable,
      });
    }

    const calls: LlmToolCall[] = [];
    let usage: TokenUsage | undefined;
    let finishReason: "stop" | "tool-calls" | "length" | "error" | "aborted" = "stop";

    for await (const frame of parseSseStream(response.body, request.signal)) {
      let data: {
        candidates?: Array<{
          content?: {
            parts?: Array<{
              text?: string;
              thought?: boolean;
              functionCall?: { name: string; args?: Record<string, unknown> };
            }>;
          };
          finishReason?: string;
        }>;
        usageMetadata?: {
          promptTokenCount?: number;
          candidatesTokenCount?: number;
          totalTokenCount?: number;
          thoughtsTokenCount?: number;
        };
      };
      try {
        data = JSON.parse(frame.data) as typeof data;
      } catch {
        continue;
      }

      if (data.usageMetadata) {
        usage = {
          inputTokens: data.usageMetadata.promptTokenCount ?? 0,
          outputTokens: data.usageMetadata.candidatesTokenCount ?? 0,
          totalTokens: data.usageMetadata.totalTokenCount ?? 0,
          reasoningTokens: data.usageMetadata.thoughtsTokenCount,
        };
      }

      const candidate = data.candidates?.[0];
      const parts = candidate?.content?.parts ?? [];
      for (const part of parts) {
        if (part.thought && part.text) {
          yield { type: "reasoning-delta", text: part.text };
        } else if (part.text) {
          yield { type: "text-delta", text: part.text };
        } else if (part.functionCall) {
          calls.push({
            id: `gemini_${randomUUID().slice(0, 8)}`,
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args ?? {}),
          });
        }
      }

      if (candidate?.finishReason === "MAX_TOKENS") finishReason = "length";
    }

    if (request.signal.aborted) {
      yield { type: "finish", reason: "aborted" };
      return;
    }

    for (const call of calls) {
      yield { type: "tool-call", call };
    }
    if (calls.length > 0) finishReason = "tool-calls";
    if (usage) yield { type: "usage", usage };
    yield { type: "finish", reason: finishReason };
  }
}
