export interface ToolContext {
  signal: AbortSignal;
}

export interface ToolPlugin<TInput = unknown> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(input: TInput, context: ToolContext): Promise<unknown>;
  summarize?(result: unknown): string;
}

export interface ProviderMessage {
  role: "user" | "assistant";
  content: string;
}

export type ProviderEvent =
  | { type: "text"; delta: string }
  | { type: "tool.start"; id: string; name: string }
  | { type: "tool.end"; id: string; name: string; summary: string; error?: boolean };

export interface ProviderRequest {
  model: string;
  instructions: string;
  messages: ProviderMessage[];
  signal: AbortSignal;
}

export interface ModelProvider {
  readonly id: string;
  run(request: ProviderRequest): AsyncGenerator<ProviderEvent, void, void>;
}
