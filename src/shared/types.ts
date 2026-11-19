export type MessageRole = "user" | "assistant";

export type ProviderId = "openai" | "deepseek" | "anthropic" | "gemini" | "local";

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
}

export interface ToolEvent {
  id: string;
  name: string;
  status: "running" | "complete" | "error";
  arguments?: string;
  summary?: string;
  durationMs?: number;
}

export interface TodoItem {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
  notes?: string;
}

export interface PlanState {
  active: boolean;
  todos: TodoItem[];
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  reasoning?: string;
  createdAt: string;
  status?: "streaming" | "complete" | "error";
  toolEvents?: ToolEvent[];
  usage?: TokenUsage;
  provider?: ProviderId;
  model?: string;
}

export interface Conversation {
  id: string;
  title: string;
  provider?: ProviderId;
  model: string;
  instructions: string;
  sandboxMode?: SandboxMode;
  workspaceRoot?: string;
  plan?: PlanState;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

export interface ConversationSummary extends Omit<Conversation, "messages"> {
  messageCount: number;
  preview: string;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  configured: boolean;
  defaultModel: string;
  models: string[];
  supportsReasoning: boolean;
  supportsTools: boolean;
}

export interface ToolInfo {
  name: string;
  description: string;
  category: string;
  concurrencySafe: boolean;
  requiredSandboxMode: SandboxMode;
  source: "builtin" | "mcp" | "plugin";
}

export interface MemoryEntry {
  id: string;
  key: string;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface McpServerStatus {
  name: string;
  command: string;
  connected: boolean;
  toolCount: number;
  error?: string;
}

export type StreamEvent =
  | { type: "message.start"; messageId: string; provider?: ProviderId; model?: string }
  | { type: "message.delta"; delta: string }
  | { type: "reasoning.delta"; delta: string }
  | { type: "step.start"; turn: number; step: number }
  | { type: "step.end"; turn: number; step: number; usage?: TokenUsage }
  | { type: "tool.start"; id: string; name: string; arguments?: string }
  | { type: "tool.end"; id: string; name: string; summary: string; error?: boolean; durationMs?: number }
  | { type: "plan.update"; plan: PlanState }
  | { type: "compaction.done"; prunedMessages: number; summaryLength: number }
  | { type: "subagent.event"; subagentId: string; task: string; status: "started" | "completed" | "error"; summary?: string }
  | { type: "message.end"; conversation: Conversation }
  | { type: "error"; message: string };
