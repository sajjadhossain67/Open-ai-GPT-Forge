import type {
  Conversation,
  ConversationSummary,
  McpServerStatus,
  MemoryEntry,
  ProviderId,
  ProviderInfo,
  SandboxMode,
  StreamEvent,
  ToolInfo,
} from "../shared/types";

export interface HealthResponse {
  status: string;
  provider: ProviderId;
  model: string;
  workspaceRoot?: string;
  sandboxMode?: SandboxMode;
  providers?: ProviderInfo[];
  toolCount?: number;
  mcpServers?: McpServerStatus[];
}

export interface CreateConversationPayload {
  provider?: ProviderId;
  model: string;
  instructions: string;
  sandboxMode?: SandboxMode;
}

export interface PatchConversationPayload {
  provider?: ProviderId;
  model?: string;
  instructions?: string;
  sandboxMode?: SandboxMode;
  planActive?: boolean;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({ error: response.statusText }))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  health: () => json<HealthResponse>("/api/health"),
  tools: () => json<ToolInfo[]>("/api/tools"),
  memoryList: () => json<MemoryEntry[]>("/api/memory"),
  memorySave: (key: string, content: string, tags: string[] = []) =>
    json<MemoryEntry>("/api/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, content, tags }),
    }),
  memoryDelete: async (key: string) => {
    const res = await fetch(`/api/memory/${encodeURIComponent(key)}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) throw new Error("Could not delete memory entry");
  },
  list: () => json<ConversationSummary[]>("/api/conversations"),
  get: (id: string) => json<Conversation>(`/api/conversations/${encodeURIComponent(id)}`),
  create: (payload: CreateConversationPayload | string, legacyInstructions?: string) => {
    const body =
      typeof payload === "string"
        ? { model: payload, instructions: legacyInstructions ?? "" }
        : payload;
    return json<Conversation>("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  },
  patch: (id: string, payload: PatchConversationPayload) =>
    json<Conversation>(`/api/conversations/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  compact: (id: string) =>
    json<{ compacted: boolean; prunedMessages: number; estimatedTokensBefore: number; estimatedTokensAfter: number }>(
      `/api/conversations/${encodeURIComponent(id)}/compact`,
      { method: "POST" },
    ),
  remove: async (id: string) => {
    const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!response.ok && response.status !== 404) throw new Error("Could not delete conversation");
  },
  send: async (id: string, content: string, onEvent: (event: StreamEvent) => void, signal: AbortSignal) => {
    const response = await fetch(`/api/conversations/${encodeURIComponent(id)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
      signal,
    });
    if (!response.ok || !response.body) {
      const body = (await response.json().catch(() => ({ error: "Could not send message" }))) as { error?: string };
      throw new Error(body.error ?? "Could not send message");
    }
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      buffer += value ?? "";
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) onEvent(JSON.parse(line) as StreamEvent);
      if (done) break;
    }
    if (buffer.trim()) onEvent(JSON.parse(buffer) as StreamEvent);
  },
};
