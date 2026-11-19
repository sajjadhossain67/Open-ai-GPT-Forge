import type { ProviderId, ProviderInfo, TokenUsage } from "../../shared/types.js";

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type LlmMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; reasoning?: string; toolCalls?: LlmToolCall[] }
  | { role: "tool"; toolCallId: string; toolName: string; content: string; isError?: boolean };

export interface LlmToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmRequest {
  model: string;
  systemPrompt: string;
  messages: LlmMessage[];
  tools: LlmToolSchema[];
  maxTokens?: number;
  temperature?: number;
  signal: AbortSignal;
}

export type LlmStreamChunk =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call"; call: LlmToolCall }
  | { type: "usage"; usage: TokenUsage }
  | { type: "finish"; reason: "stop" | "tool-calls" | "length" | "error" | "aborted" };

export class LlmFailure extends Error {
  readonly code: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly provider: ProviderId;

  constructor(
    provider: ProviderId,
    message: string,
    options: { code?: string; status?: number; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "LlmFailure";
    this.provider = provider;
    this.code = options.code ?? "LLM_ERROR";
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}

export interface LlmAdapter {
  readonly id: ProviderId;
  readonly label: string;
  readonly defaultModel: string;
  readonly models: string[];
  readonly supportsReasoning: boolean;
  readonly supportsTools: boolean;
  isConfigured(): boolean;
  info(): ProviderInfo;
  stream(request: LlmRequest): AsyncGenerator<LlmStreamChunk, void, void>;
}
