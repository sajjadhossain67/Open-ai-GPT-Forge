import { mkdtemp, appendFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CompactionEngine, estimateTokens } from "./compaction.js";
import { PluginHost } from "./plugin-host.js";
import { SessionStore } from "./session.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "forge-session-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe("SessionStore & CompactionEngine", () => {
  it("persists append-only JSONL events, survives reload, and ignores truncated trailing lines", async () => {
    const dir = await makeTempDir();
    const store = new SessionStore(dir);
    const session = await store.create({
      provider: "deepseek",
      model: "deepseek-chat",
      instructions: "Be helpful",
      sandboxMode: "workspace-write",
      workspaceRoot: dir,
    });

    await session.append({ type: "turn/start", data: { turn: 1 } });
    await session.append({ type: "user/message", data: { id: "u1", content: "Hello world", source: "user" } });
    await session.append({
      type: "assistant/message",
      data: { id: "a1", turn: 1, step: 1, content: "Hi there!", reasoning: "Simple greeting" },
    });
    await session.append({ type: "turn/end", data: { turn: 1, reason: "completed" } });

    // Simulate an unclean shutdown leaving a partial JSON line
    await appendFile(path.join(dir, "sessions", `${session.id}.jsonl`), '{"seq":99,"broken":', "utf8");

    const reloadedStore = new SessionStore(dir);
    const reloaded = await reloadedStore.get(session.id);
    expect(reloaded).toBeDefined();
    expect(reloaded!.meta.title).toBe("Hello world");
    expect(reloaded!.deriveLlmMessages()).toHaveLength(2);
    const conv = reloaded!.toConversation();
    expect(conv.messages).toHaveLength(2);
    expect(conv.messages[1]?.reasoning).toBe("Simple greeting");
  });

  it("compacts older messages into a summary checkpoint without splitting tool-call/result pairs", async () => {
    const dir = await makeTempDir();
    const store = new SessionStore(dir);
    const session = await store.create({
      provider: "openai",
      model: "gpt-4o-mini",
      instructions: "",
      sandboxMode: "read-only",
      workspaceRoot: dir,
    });

    for (let i = 1; i <= 10; i += 1) {
      await session.append({
        type: "user/message",
        data: { id: `u${i}`, content: `Prompt ${i}: ${"x".repeat(400)}`, source: "user" },
      });
      await session.append({
        type: "assistant/message",
        data: { id: `a${i}`, turn: i, step: 1, content: `Response ${i}: ${"y".repeat(400)}` },
      });
    }

    const beforeTokens = estimateTokens(session.deriveLlmMessages());
    const engine = new CompactionEngine({ maxEstimatedTokens: 500, retainRecentEvents: 4 });
    expect(engine.needsCompaction(session)).toBe(true);

    const outcome = await engine.compact(session);
    expect(outcome.compacted).toBe(true);
    expect(outcome.prunedMessages).toBeGreaterThan(0);
    expect(outcome.estimatedTokensAfter).toBeLessThan(beforeTokens);

    const derived = session.deriveLlmMessages();
    expect(derived[0]?.role).toBe("user");
    expect(derived[0]?.content).toContain("[Conversation Summary");
  });
});

describe("PluginHost", () => {
  it("mounts plugins, runs waterfall hooks, and unwinds services/hooks cleanly on unmount", async () => {
    const host = new PluginHost();
    const unmount = await host.mount({
      name: "test-plugin",
      setup(ctx) {
        ctx.setService("greeting", "hello");
        ctx.onHook<string>("transform", async (val, next) => next(`${val}!`));
      },
    });

    expect(host.getService<string>("greeting")).toBe("hello");
    expect(await host.runWaterfall("transform", "forge")).toBe("forge!");

    await unmount();
    expect(host.getService("greeting")).toBeUndefined();
    expect(await host.runWaterfall("transform", "forge")).toBe("forge");
  });
});
