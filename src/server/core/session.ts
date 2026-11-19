import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ChatMessage,
  Conversation,
  ConversationSummary,
  PlanState,
  ProviderId,
  SandboxMode,
  TodoItem,
  TokenUsage,
  ToolEvent,
} from "../../shared/types.js";
import type { LlmMessage, LlmToolCall } from "../providers/types.js";

export interface SessionMeta {
  id: string;
  title: string;
  provider: ProviderId;
  model: string;
  instructions: string;
  sandboxMode: SandboxMode;
  workspaceRoot: string;
  createdAt: string;
  updatedAt: string;
}

export type SessionEvent =
  | { seq: number; ts: string; type: "session/meta"; data: Partial<SessionMeta> }
  | { seq: number; ts: string; type: "turn/start"; data: { turn: number } }
  | { seq: number; ts: string; type: "turn/end"; data: { turn: number; reason: "completed" | "aborted" | "error" } }
  | { seq: number; ts: string; type: "step/start"; data: { turn: number; step: number } }
  | { seq: number; ts: string; type: "step/end"; data: { turn: number; step: number; usage?: TokenUsage } }
  | { seq: number; ts: string; type: "user/message"; data: { id: string; content: string; source?: "user" | "inject" | "compaction" } }
  | {
      seq: number;
      ts: string;
      type: "assistant/message";
      data: {
        id: string;
        turn: number;
        step: number;
        content: string;
        reasoning?: string;
        toolCalls?: LlmToolCall[];
        usage?: TokenUsage;
        provider?: ProviderId;
        model?: string;
      };
    }
  | { seq: number; ts: string; type: "tool/call"; data: { turn: number; step: number; callId: string; name: string; arguments: string } }
  | {
      seq: number;
      ts: string;
      type: "tool/result";
      data: {
        turn: number;
        step: number;
        callId: string;
        name: string;
        output: string;
        summary: string;
        isError: boolean;
        durationMs: number;
      };
    }
  | { seq: number; ts: string; type: "plan/mode"; data: { active: boolean } }
  | { seq: number; ts: string; type: "plan/todos"; data: { todos: TodoItem[] } }
  | {
      seq: number;
      ts: string;
      type: "compaction/checkpoint";
      data: {
        summary: string;
        shadowedThroughSeq: number;
        prunedCount: number;
      };
    };

export type SessionEventInput =
  | { type: "session/meta"; data: Partial<SessionMeta> }
  | { type: "turn/start"; data: { turn: number } }
  | { type: "turn/end"; data: { turn: number; reason: "completed" | "aborted" | "error" } }
  | { type: "step/start"; data: { turn: number; step: number } }
  | { type: "step/end"; data: { turn: number; step: number; usage?: TokenUsage } }
  | { type: "user/message"; data: { id: string; content: string; source?: "user" | "inject" | "compaction" } }
  | {
      type: "assistant/message";
      data: {
        id: string;
        turn: number;
        step: number;
        content: string;
        reasoning?: string;
        toolCalls?: LlmToolCall[];
        usage?: TokenUsage;
        provider?: ProviderId;
        model?: string;
      };
    }
  | { type: "tool/call"; data: { turn: number; step: number; callId: string; name: string; arguments: string } }
  | {
      type: "tool/result";
      data: {
        turn: number;
        step: number;
        callId: string;
        name: string;
        output: string;
        summary: string;
        isError: boolean;
        durationMs: number;
      };
    }
  | { type: "plan/mode"; data: { active: boolean } }
  | { type: "plan/todos"; data: { todos: TodoItem[] } }
  | {
      type: "compaction/checkpoint";
      data: {
        summary: string;
        shadowedThroughSeq: number;
        prunedCount: number;
      };
    };

/**
 * Append-only event-sourced session log inspired by DeepSeek Harness's SessionEvent model.
 * All LLM messages, plan state, and UI conversation views are deterministically derived from events.
 */
export class EventSession {
  readonly meta: SessionMeta;
  readonly #events: SessionEvent[] = [];
  readonly #filePath: string;
  #writeQueue = Promise.resolve();

  constructor(meta: SessionMeta, filePath: string, initialEvents: SessionEvent[] = []) {
    this.meta = { ...meta };
    this.#filePath = filePath;
    this.#events.push(...initialEvents);
  }

  get id(): string {
    return this.meta.id;
  }

  get events(): readonly SessionEvent[] {
    return this.#events;
  }

  nextTurnNumber(): number {
    let maxTurn = 0;
    for (const ev of this.#events) {
      if (ev.type === "turn/start" && ev.data.turn > maxTurn) maxTurn = ev.data.turn;
    }
    return maxTurn + 1;
  }

  async append(input: SessionEventInput): Promise<SessionEvent> {
    const pending = this.#writeQueue.then(async () => {
      const event = {
        seq: this.#events.length,
        ts: new Date().toISOString(),
        ...input,
      } as SessionEvent;
      this.#events.push(event);
      this.meta.updatedAt = event.ts;

      if (event.type === "session/meta") {
        Object.assign(this.meta, event.data);
      } else if (
        event.type === "user/message" &&
        event.data.source !== "compaction" &&
        this.meta.title === "New conversation"
      ) {
        this.meta.title = event.data.content.replace(/\s+/g, " ").trim().slice(0, 60) || "New conversation";
      }

      await mkdir(path.dirname(this.#filePath), { recursive: true });
      await appendFile(this.#filePath, `${JSON.stringify(event)}\n`, "utf8");
      return event;
    });
    this.#writeQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  derivePlanState(): PlanState {
    let active = false;
    let todos: TodoItem[] = [];
    for (const ev of this.#events) {
      if (ev.type === "plan/mode") active = ev.data.active;
      if (ev.type === "plan/todos") todos = ev.data.todos;
    }
    return { active, todos };
  }

  /**
   * Derive the exact LLM message sequence from the append-only log,
   * respecting the latest compaction checkpoint if present.
   */
  deriveLlmMessages(): LlmMessage[] {
    let lastCheckpointIndex = -1;
    let checkpointSummary = "";
    let shadowedThroughSeq = -1;

    for (let i = 0; i < this.#events.length; i += 1) {
      const ev = this.#events[i];
      if (ev?.type === "compaction/checkpoint") {
        lastCheckpointIndex = i;
        checkpointSummary = ev.data.summary;
        shadowedThroughSeq = ev.data.shadowedThroughSeq;
      }
    }

    const messages: LlmMessage[] = [];
    if (lastCheckpointIndex >= 0 && checkpointSummary) {
      messages.push({
        role: "user",
        content: `[Conversation Summary — compacted earlier context]\n${checkpointSummary}`,
      });
    }

    for (const ev of this.#events) {
      if (ev.seq <= shadowedThroughSeq) continue;
      if (ev.type === "user/message") {
        messages.push({ role: "user", content: ev.data.content });
      } else if (ev.type === "assistant/message") {
        messages.push({
          role: "assistant",
          content: ev.data.content,
          reasoning: ev.data.reasoning,
          toolCalls: ev.data.toolCalls,
        });
      } else if (ev.type === "tool/result") {
        messages.push({
          role: "tool",
          toolCallId: ev.data.callId,
          toolName: ev.data.name,
          content: ev.data.output,
          isError: ev.data.isError,
        });
      }
    }

    return messages;
  }

  /**
   * Derive the UI-friendly Conversation representation from the append-only log.
   */
  toConversation(): Conversation {
    const messages: ChatMessage[] = [];
    let currentAssistant: ChatMessage | null = null;
    const toolMap = new Map<string, ToolEvent>();

    for (const ev of this.#events) {
      if (ev.type === "user/message" && ev.data.source !== "compaction") {
        currentAssistant = null;
        toolMap.clear();
        messages.push({
          id: ev.data.id,
          role: "user",
          content: ev.data.content,
          createdAt: ev.ts,
          status: "complete",
        });
      } else if (ev.type === "assistant/message") {
        if (!currentAssistant) {
          currentAssistant = {
            id: ev.data.id,
            role: "assistant",
            content: ev.data.content,
            reasoning: ev.data.reasoning,
            createdAt: ev.ts,
            status: "complete",
            toolEvents: [],
            usage: ev.data.usage,
            provider: ev.data.provider,
            model: ev.data.model,
          };
          messages.push(currentAssistant);
        } else {
          if (ev.data.content) {
            currentAssistant.content = currentAssistant.content
              ? `${currentAssistant.content}\n\n${ev.data.content}`
              : ev.data.content;
          }
          if (ev.data.reasoning) {
            currentAssistant.reasoning = currentAssistant.reasoning
              ? `${currentAssistant.reasoning}\n\n${ev.data.reasoning}`
              : ev.data.reasoning;
          }
          if (ev.data.usage) {
            const prev = currentAssistant.usage;
            currentAssistant.usage = prev
              ? {
                  inputTokens: prev.inputTokens + ev.data.usage.inputTokens,
                  outputTokens: prev.outputTokens + ev.data.usage.outputTokens,
                  totalTokens: prev.totalTokens + ev.data.usage.totalTokens,
                  reasoningTokens: (prev.reasoningTokens ?? 0) + (ev.data.usage.reasoningTokens ?? 0),
                }
              : ev.data.usage;
          }
        }
      } else if (ev.type === "tool/call") {
        if (!currentAssistant) {
          currentAssistant = {
            id: randomUUID(),
            role: "assistant",
            content: "",
            createdAt: ev.ts,
            status: "complete",
            toolEvents: [],
          };
          messages.push(currentAssistant);
        }
        const toolEv: ToolEvent = {
          id: ev.data.callId,
          name: ev.data.name,
          arguments: ev.data.arguments,
          status: "running",
        };
        currentAssistant.toolEvents ??= [];
        currentAssistant.toolEvents.push(toolEv);
        toolMap.set(ev.data.callId, toolEv);
      } else if (ev.type === "tool/result") {
        const toolEv = toolMap.get(ev.data.callId);
        if (toolEv) {
          toolEv.status = ev.data.isError ? "error" : "complete";
          toolEv.summary = ev.data.summary;
          toolEv.durationMs = ev.data.durationMs;
        }
      }
    }

    return {
      id: this.meta.id,
      title: this.meta.title,
      provider: this.meta.provider,
      model: this.meta.model,
      instructions: this.meta.instructions,
      sandboxMode: this.meta.sandboxMode,
      workspaceRoot: this.meta.workspaceRoot,
      plan: this.derivePlanState(),
      createdAt: this.meta.createdAt,
      updatedAt: this.meta.updatedAt,
      messages,
    };
  }

  toSummary(): ConversationSummary {
    const conv = this.toConversation();
    const { messages, ...rest } = conv;
    return {
      ...rest,
      messageCount: messages.length,
      preview: messages.at(-1)?.content.slice(0, 100) || "New conversation",
    };
  }
}

export interface CreateSessionInput {
  id?: string;
  provider: ProviderId;
  model: string;
  instructions: string;
  sandboxMode: SandboxMode;
  workspaceRoot: string;
  title?: string;
}

/**
 * Durable JSONL-backed SessionStore.
 * Each session is stored as `<dataDir>/sessions/<id>.jsonl` with an atomic index fallback.
 */
export class SessionStore {
  readonly #sessionsDir: string;
  readonly #cache = new Map<string, EventSession>();

  constructor(dataDirectory: string) {
    this.#sessionsDir = path.join(dataDirectory, "sessions");
  }

  #fileFor(id: string): string {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) {
      throw new Error(`Invalid session id: ${id}`);
    }
    return path.join(this.#sessionsDir, `${id}.jsonl`);
  }

  async create(input: CreateSessionInput): Promise<EventSession> {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    const meta: SessionMeta = {
      id,
      title: input.title ?? "New conversation",
      provider: input.provider,
      model: input.model,
      instructions: input.instructions,
      sandboxMode: input.sandboxMode,
      workspaceRoot: input.workspaceRoot,
      createdAt: now,
      updatedAt: now,
    };
    const filePath = this.#fileFor(id);
    const session = new EventSession(meta, filePath);
    await session.append({ type: "session/meta", data: meta });
    this.#cache.set(id, session);
    return session;
  }

  async get(id: string): Promise<EventSession | undefined> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) return undefined;
    const cached = this.#cache.get(id);
    if (cached) return cached;

    const filePath = this.#fileFor(id);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }

    const events: SessionEvent[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed) as SessionEvent);
      } catch {
        // Ignore truncated trailing line after an unclean shutdown
      }
    }
    if (events.length === 0) return undefined;

    const meta: SessionMeta = {
      id,
      title: "New conversation",
      provider: "openai",
      model: "gpt-4o-mini",
      instructions: "",
      sandboxMode: "workspace-write",
      workspaceRoot: process.cwd(),
      createdAt: events[0]?.ts ?? new Date().toISOString(),
      updatedAt: events.at(-1)?.ts ?? new Date().toISOString(),
    };

    for (const ev of events) {
      if (ev.type === "session/meta") Object.assign(meta, ev.data);
      if (ev.type === "user/message" && ev.data.source !== "compaction" && meta.title === "New conversation") {
        meta.title = ev.data.content.replace(/\s+/g, " ").trim().slice(0, 60) || "New conversation";
      }
      meta.updatedAt = ev.ts;
    }

    const session = new EventSession(meta, filePath, events);
    this.#cache.set(id, session);
    return session;
  }

  async list(): Promise<ConversationSummary[]> {
    await mkdir(this.#sessionsDir, { recursive: true });
    const entries = await readdir(this.#sessionsDir);
    const summaries: ConversationSummary[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const id = entry.slice(0, -".jsonl".length);
      const session = await this.get(id);
      if (session) summaries.push(session.toSummary());
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async delete(id: string): Promise<boolean> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) return false;
    this.#cache.delete(id);
    const filePath = this.#fileFor(id);
    try {
      await rm(filePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async exportJson(id: string): Promise<string | undefined> {
    const session = await this.get(id);
    if (!session) return undefined;
    return JSON.stringify({ meta: session.meta, events: session.events }, null, 2);
  }

  async compactRewrite(id: string): Promise<void> {
    const session = await this.get(id);
    if (!session) return;
    const filePath = this.#fileFor(id);
    const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    const body = session.events.map((ev) => JSON.stringify(ev)).join("\n") + "\n";
    await writeFile(temp, body, "utf8");
    await rename(temp, filePath);
  }
}
