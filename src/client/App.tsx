import { FormEvent, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import type {
  ChatMessage,
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
import { api } from "./api";

const DEFAULT_INSTRUCTIONS =
  "You are OpenGPT Forge, an autonomous AI engineering agent. Think carefully, use workspace tools accurately, and verify your work.";

export function App() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [active, setActive] = useState<Conversation | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<"config" | "tools" | "memory">("config");

  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [provider, setProvider] = useState<ProviderId>("openai");
  const [model, setModel] = useState("gpt-4o-mini");
  const [sandboxMode, setSandboxMode] = useState<SandboxMode>("workspace-write");
  const [instructions, setInstructions] = useState(DEFAULT_INSTRUCTIONS);
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerStatus[]>([]);
  const [memKey, setMemKey] = useState("");
  const [memContent, setMemContent] = useState("");

  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const refresh = async () => setConversations(await api.list());
  const refreshMemory = async () => setMemories(await api.memoryList());

  useEffect(() => {
    refresh().catch((e: Error) => setError(e.message));
    api
      .health()
      .then((h) => {
        setProvider(h.provider);
        setModel(h.model);
        if (h.sandboxMode) setSandboxMode(h.sandboxMode);
        if (h.workspaceRoot) setWorkspaceRoot(h.workspaceRoot);
        if (h.providers) setProviders(h.providers);
        if (h.mcpServers) setMcpServers(h.mcpServers);
      })
      .catch(() => undefined);
    api.tools().then(setTools).catch(() => undefined);
    refreshMemory().catch(() => undefined);
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [active?.messages]);

  function onProviderChange(nextProvider: ProviderId) {
    setProvider(nextProvider);
    const info = providers.find((p) => p.id === nextProvider);
    if (info) setModel(info.defaultModel);
  }

  async function newChat() {
    try {
      const conversation = await api.create({ provider, model, instructions, sandboxMode });
      setActive(conversation);
      setSidebarOpen(false);
      setSettingsOpen(false);
      setError(null);
      await refresh();
    } catch (e) {
      setError(asMessage(e));
    }
  }

  async function openChat(id: string) {
    try {
      const conv = await api.get(id);
      setActive(conv);
      if (conv.provider) setProvider(conv.provider);
      setModel(conv.model);
      if (conv.sandboxMode) setSandboxMode(conv.sandboxMode);
      setSidebarOpen(false);
      setError(null);
    } catch (e) {
      setError(asMessage(e));
    }
  }

  async function deleteChat(id: string) {
    try {
      await api.remove(id);
      if (active?.id === id) setActive(null);
      await refresh();
    } catch (e) {
      setError(asMessage(e));
    }
  }

  async function applySettings() {
    try {
      if (active) {
        const updated = await api.patch(active.id, { provider, model, instructions, sandboxMode });
        setActive(updated);
      }
      setSettingsOpen(false);
    } catch (e) {
      setError(asMessage(e));
    }
  }

  async function togglePlanMode() {
    if (!active) return;
    try {
      const nextActive = !(active.plan?.active ?? false);
      const updated = await api.patch(active.id, { planActive: nextActive });
      setActive(updated);
    } catch (e) {
      setError(asMessage(e));
    }
  }

  async function triggerCompact() {
    if (!active || busy) return;
    try {
      const res = await api.compact(active.id);
      setStatusNote(
        res.compacted
          ? `Compacted ${res.prunedMessages} messages (${res.estimatedTokensBefore} → ${res.estimatedTokensAfter} est. tokens)`
          : "Context is already compact enough.",
      );
      setTimeout(() => setStatusNote(null), 4000);
    } catch (e) {
      setError(asMessage(e));
    }
  }

  async function addMemory(event: FormEvent) {
    event.preventDefault();
    if (!memKey.trim() || !memContent.trim()) return;
    try {
      await api.memorySave(memKey.trim(), memContent.trim());
      setMemKey("");
      setMemContent("");
      await refreshMemory();
    } catch (e) {
      setError(asMessage(e));
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || busy) return;
    setDraft("");
    setBusy(true);
    setError(null);
    let conversation = active;
    try {
      if (!conversation) {
        conversation = await api.create({ provider, model, instructions, sandboxMode });
        setActive(conversation);
      }
      const user: ChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content,
        createdAt: new Date().toISOString(),
        status: "complete",
      };
      setActive((current) => (current ? { ...current, messages: [...current.messages, user] } : current));
      const controller = new AbortController();
      abortRef.current = controller;
      await api.send(
        conversation.id,
        content,
        (streamEvent) => applyStreamEvent(streamEvent, setActive, setError, setStatusNote),
        controller.signal,
      );
      await refresh();
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError(asMessage(e));
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  const activeProviderInfo = providers.find((p) => p.id === (active?.provider ?? provider));

  return (
    <div className="shell">
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="brand">
          <Logo />
          <div>
            <strong>OpenGPT Forge</strong>
            <span>Autonomous Agent Harness</span>
          </div>
        </div>
        <button className="new-chat" onClick={newChat}>
          <span>＋</span> New session <kbd>⌘ K</kbd>
        </button>
        <div className="history-label">Sessions</div>
        <nav className="history" aria-label="Conversations">
          {conversations.length === 0 && <p className="empty-history">Your agent sessions will appear here.</p>}
          {conversations.map((item) => (
            <div className={`history-row ${active?.id === item.id ? "selected" : ""}`} key={item.id}>
              <button onClick={() => openChat(item.id)}>
                <span>{item.title}</span>
                <small>
                  {item.provider ?? "openai"}/{item.model} · {item.preview}
                </small>
              </button>
              <button className="delete" aria-label={`Delete ${item.title}`} onClick={() => deleteChat(item.id)}>
                ×
              </button>
            </div>
          ))}
        </nav>
        <button
          className="settings-link"
          onClick={() => {
            setInspectorTab("config");
            setSettingsOpen(true);
          }}
        >
          <span>⚙</span>
          <div>
            Harness &amp; Tools
            <small>
              {active?.provider ?? provider}/{active?.model ?? model} · {tools.length} tools
            </small>
          </div>
        </button>
      </aside>
      {sidebarOpen && <button className="backdrop" aria-label="Close menu" onClick={() => setSidebarOpen(false)} />}
      <main>
        <header>
          <button className="mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="Open menu">
            ☰
          </button>
          <div className="chat-title">
            <strong>{active?.title ?? "New session"}</strong>
            <span>
              <i /> {activeProviderInfo?.label ?? provider} · {active?.sandboxMode ?? sandboxMode}
              {mcpServers.length > 0 ? ` · ${mcpServers.filter((s) => s.connected).length} MCP` : ""}
            </span>
          </div>
          <div className="header-actions">
            {active && (
              <>
                <button
                  className={`pill-btn ${active.plan?.active ? "active" : ""}`}
                  onClick={togglePlanMode}
                  title="Toggle Plan Mode"
                >
                  Plan {active.plan?.active ? "ON" : "OFF"}
                </button>
                <button className="pill-btn" onClick={triggerCompact} disabled={busy} title="Compact session context">
                  Compact
                </button>
              </>
            )}
            <button
              className="model-pill"
              onClick={() => {
                setInspectorTab("config");
                setSettingsOpen(true);
              }}
            >
              {active?.provider ?? provider}/{active?.model ?? model} <span>⌄</span>
            </button>
          </div>
        </header>

        {active?.plan && active.plan.todos.length > 0 && (
          <div className="todo-strip">
            <strong>Task Plan</strong>
            <div className="todo-items">
              {active.plan.todos.map((t) => (
                <span key={t.id} className={`todo-chip ${t.status}`}>
                  {t.status === "completed" ? "✓" : t.status === "in_progress" ? "◌" : "○"} {t.title}
                </span>
              ))}
            </div>
          </div>
        )}

        <section className="messages" aria-live="polite">
          {!active?.messages.length ? (
            <Welcome onPrompt={setDraft} workspaceRoot={workspaceRoot} toolCount={tools.length} />
          ) : (
            active.messages.map((message) => <Message key={message.id} message={message} />)
          )}
          {statusNote && <div className="status-banner">{statusNote}</div>}
          {error && (
            <div className="error-banner" role="alert">
              {error}
              <button onClick={() => setError(null)}>Dismiss</button>
            </div>
          )}
          <div ref={endRef} />
        </section>

        <div className="composer-wrap">
          <form className="composer" onSubmit={submit}>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="Ask the agent to inspect files, plan tasks, run code, or delegate subtasks…"
              rows={1}
              disabled={busy}
              aria-label="Message"
            />
            <div className="composer-actions">
              <div>
                <span>
                  {tools.length} tools · {active?.sandboxMode ?? sandboxMode}
                </span>
              </div>
              {busy ? (
                <button
                  type="button"
                  className="send stop"
                  onClick={() => abortRef.current?.abort()}
                  aria-label="Stop"
                >
                  ■
                </button>
              ) : (
                <button className="send" disabled={!draft.trim()} aria-label="Send">
                  ↑
                </button>
              )}
            </div>
          </form>
          <p>OpenGPT Forge — Event-sourced multi-provider AI agent harness.</p>
        </div>
      </main>

      {settingsOpen && (
        <div className="modal-layer" role="dialog" aria-modal="true" aria-labelledby="settings-title">
          <button className="backdrop" aria-label="Close settings" onClick={() => setSettingsOpen(false)} />
          <div className="modal modal-wide">
            <div className="modal-head">
              <div>
                <span>HARNESS CONTROL PLANE</span>
                <h2 id="settings-title">OpenGPT Forge Settings</h2>
              </div>
              <button onClick={() => setSettingsOpen(false)}>×</button>
            </div>

            <div className="modal-tabs">
              <button className={inspectorTab === "config" ? "active" : ""} onClick={() => setInspectorTab("config")}>
                Model &amp; Sandbox
              </button>
              <button className={inspectorTab === "tools" ? "active" : ""} onClick={() => setInspectorTab("tools")}>
                Tools ({tools.length})
              </button>
              <button className={inspectorTab === "memory" ? "active" : ""} onClick={() => setInspectorTab("memory")}>
                Memory ({memories.length})
              </button>
            </div>

            {inspectorTab === "config" && (
              <>
                <label>
                  Provider
                  <select value={provider} onChange={(e) => onProviderChange(e.target.value as ProviderId)}>
                    {providers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label} {p.configured ? "✓" : "(API key missing)"}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Model
                  <input value={model} onChange={(e) => setModel(e.target.value)} maxLength={120} />
                </label>
                <label>
                  Sandbox policy
                  <select value={sandboxMode} onChange={(e) => setSandboxMode(e.target.value as SandboxMode)}>
                    <option value="read-only">read-only (inspect &amp; plan only)</option>
                    <option value="workspace-write">workspace-write (confined file edits &amp; execution)</option>
                    <option value="danger-full-access">danger-full-access (unconfined)</option>
                  </select>
                </label>
                <label>
                  System instructions
                  <textarea
                    value={instructions}
                    onChange={(e) => setInstructions(e.target.value)}
                    rows={5}
                    maxLength={20000}
                  />
                </label>
                <p>Workspace root: {workspaceRoot || "(server cwd)"}. API keys remain server-only in .env.</p>
                <button className="save" onClick={applySettings}>
                  Save configuration
                </button>
              </>
            )}

            {inspectorTab === "tools" && (
              <div className="inspector-list">
                {tools.map((tool) => (
                  <div key={tool.name} className="inspector-item">
                    <div>
                      <strong>{tool.name}</strong>
                      <small>{tool.description}</small>
                    </div>
                    <span className="badge">{tool.category}</span>
                  </div>
                ))}
              </div>
            )}

            {inspectorTab === "memory" && (
              <div>
                <form className="memory-form" onSubmit={addMemory}>
                  <input
                    placeholder="Key (e.g. coding_style)"
                    value={memKey}
                    onChange={(e) => setMemKey(e.target.value)}
                  />
                  <input
                    placeholder="Fact to remember across sessions"
                    value={memContent}
                    onChange={(e) => setMemContent(e.target.value)}
                  />
                  <button type="submit">Save</button>
                </form>
                <div className="inspector-list">
                  {memories.length === 0 && <p className="empty-history">No persistent memories saved yet.</p>}
                  {memories.map((entry) => (
                    <div key={entry.id} className="inspector-item">
                      <div>
                        <strong>{entry.key}</strong>
                        <small>{entry.content}</small>
                      </div>
                      <button
                        className="delete-mem"
                        onClick={async () => {
                          await api.memoryDelete(entry.key);
                          await refreshMemory();
                        }}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function applyStreamEvent(
  event: StreamEvent,
  setActive: React.Dispatch<React.SetStateAction<Conversation | null>>,
  setError: (value: string) => void,
  setStatusNote: (value: string | null) => void,
) {
  if (event.type === "error") return setError(event.message);
  if (event.type === "message.end") return setActive(event.conversation);
  if (event.type === "compaction.done") {
    setStatusNote(`Auto-compacted ${event.prunedMessages} earlier messages.`);
    setTimeout(() => setStatusNote(null), 4000);
    return;
  }
  if (event.type === "plan.update") {
    setActive((conv) => (conv ? { ...conv, plan: event.plan } : conv));
    return;
  }
  setActive((conversation) => {
    if (!conversation) return conversation;
    const messages = [...conversation.messages];
    if (event.type === "message.start") {
      messages.push({
        id: event.messageId,
        role: "assistant",
        content: "",
        reasoning: "",
        createdAt: new Date().toISOString(),
        status: "streaming",
        toolEvents: [],
        provider: event.provider,
        model: event.model,
      });
    }
    const last = messages.at(-1);
    if (!last || last.role !== "assistant") return conversation;
    const updated = { ...last, toolEvents: [...(last.toolEvents ?? [])] };
    if (event.type === "message.delta") updated.content += event.delta;
    if (event.type === "reasoning.delta") updated.reasoning = (updated.reasoning ?? "") + event.delta;
    if (event.type === "tool.start") {
      updated.toolEvents.push({ id: event.id, name: event.name, arguments: event.arguments, status: "running" });
    }
    if (event.type === "tool.end") {
      const tool = updated.toolEvents.find((item) => item.id === event.id);
      if (tool) {
        Object.assign(tool, {
          status: event.error ? "error" : "complete",
          summary: event.summary,
          durationMs: event.durationMs,
        });
      }
    }
    messages[messages.length - 1] = updated;
    return { ...conversation, messages };
  });
}

function Welcome({
  onPrompt,
  workspaceRoot,
  toolCount,
}: {
  onPrompt: (prompt: string) => void;
  workspaceRoot: string;
  toolCount: number;
}) {
  const prompts = [
    ["◇", "Inspect repository", "Give me an overview of this workspace structure, git status, and key modules."],
    ["⌁", "Plan & decompose", "Enter plan mode and break down a feature implementation into a tracked task list."],
    ["◎", "Run & verify code", "Write and run a quick JavaScript snippet to benchmark sorting 10,000 numbers."],
  ];
  return (
    <div className="welcome">
      <div className="orb">
        <Logo />
      </div>
      <p>OPENGPT FORGE · {toolCount} TOOLS READY</p>
      <h1>Build with autonomous agents.</h1>
      <span>
        Multi-provider harness inspired by DeepSeek Harness — event-sourced sessions, sandboxed tools, memory, and MCP.
        {workspaceRoot ? ` Workspace: ${workspaceRoot}` : ""}
      </span>
      <div className="prompt-grid">
        {prompts.map(([icon, title, prompt]) => (
          <button key={title} onClick={() => onPrompt(prompt)}>
            <b>{icon}</b>
            <div>
              <strong>{title}</strong>
              <small>{prompt}</small>
            </div>
            <i>→</i>
          </button>
        ))}
      </div>
    </div>
  );
}

function Message({ message }: { message: ChatMessage }) {
  return (
    <article className={`message ${message.role}`}>
      <div className="avatar">{message.role === "assistant" ? <Logo /> : "You"}</div>
      <div className="message-body">
        <div className="message-meta">
          {message.role === "assistant" ? `Forge${message.model ? ` · ${message.model}` : ""}` : "You"}
          <time>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
          {message.usage && (
            <span className="usage-tag">
              {message.usage.inputTokens} in / {message.usage.outputTokens} out
            </span>
          )}
        </div>
        {message.reasoning && (
          <details className="reasoning-box">
            <summary>Reasoning trace ({message.reasoning.length} chars)</summary>
            <pre>{message.reasoning}</pre>
          </details>
        )}
        {message.toolEvents?.map((tool) => (
          <div className={`tool ${tool.status}`} key={tool.id}>
            <span>{tool.status === "running" ? "◌" : tool.status === "complete" ? "✓" : "!"}</span>
            <div>
              <strong>
                {tool.name.replaceAll("_", " ")}
                {tool.durationMs !== undefined ? ` · ${tool.durationMs}ms` : ""}
              </strong>
              {tool.summary && <small>{tool.summary}</small>}
            </div>
          </div>
        ))}
        <div className="markdown">
          <ReactMarkdown>{message.content || (message.status === "streaming" ? "Thinking…" : "")}</ReactMarkdown>
        </div>
      </div>
    </article>
  );
}

function Logo() {
  return (
    <svg viewBox="0 0 40 40" aria-hidden="true">
      <path d="M20 3 34.7 11.5v17L20 37 5.3 28.5v-17L20 3Z" fill="none" stroke="currentColor" strokeWidth="2" />
      <path
        d="m12 15 8-4.5 8 4.5v10l-8 4.5-8-4.5V15Zm8-4.5v19M12 15l16 10m0-10L12 25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}

function asMessage(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong";
}
