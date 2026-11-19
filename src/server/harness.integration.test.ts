import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderInfo, StreamEvent } from "../shared/types.js";
import { createHarnessApp } from "./app.js";
import { ForgeHarness } from "./harness.js";
import { ProviderRegistry } from "./providers/registry.js";
import { LlmFailure, type LlmAdapter, type LlmRequest, type LlmStreamChunk } from "./providers/types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

class ScriptedAdapter implements LlmAdapter {
  readonly id = "deepseek" as const;
  readonly label = "Scripted DeepSeek";
  readonly defaultModel = "deepseek-chat";
  readonly models = ["deepseek-chat"];
  readonly supportsReasoning = true;
  readonly supportsTools = true;
  readonly #steps: Array<(req: LlmRequest) => AsyncGenerator<LlmStreamChunk, void, void>>;
  #callIndex = 0;

  constructor(steps: Array<(req: LlmRequest) => AsyncGenerator<LlmStreamChunk, void, void>>) {
    this.#steps = steps;
  }

  isConfigured(): boolean {
    return true;
  }

  info(): ProviderInfo {
    return {
      id: this.id,
      label: this.label,
      configured: true,
      defaultModel: this.defaultModel,
      models: this.models,
      supportsReasoning: true,
      supportsTools: true,
    };
  }

  async *stream(request: LlmRequest): AsyncGenerator<LlmStreamChunk, void, void> {
    const handler = this.#steps[this.#callIndex++];
    if (!handler) {
      yield { type: "text-delta", text: "Done." };
      yield { type: "finish", reason: "stop" };
      return;
    }
    yield* handler(request);
  }
}

describe("ForgeHarness end-to-end integration", () => {
  it("executes multi-step tool calling, retries transient errors, delegates subagents, and streams NDJSON over HTTP", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "forge-e2e-ws-"));
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "forge-e2e-data-"));
    tempDirs.push(workspace, dataDir);

    let failedOnce = false;
    const adapter = new ScriptedAdapter([
      // Step 1: transient retryable failure
      async function* () {
        if (!failedOnce) {
          failedOnce = true;
          throw new LlmFailure("deepseek", "Temporary 503", { code: "HTTP_ERROR", status: 503, retryable: true });
        }
        yield { type: "finish", reason: "stop" };
      },
      // Step 1 retry: call write_file, manage_todos, and memory_save
      async function* () {
        yield { type: "reasoning-delta", text: "Writing artifact and updating plan." };
        yield {
          type: "tool-call",
          call: { id: "c1", name: "write_file", arguments: JSON.stringify({ path: "hello.txt", content: "Forge works!" }) },
        };
        yield {
          type: "tool-call",
          call: {
            id: "c2",
            name: "manage_todos",
            arguments: JSON.stringify({ todos: [{ id: "t1", title: "Create hello.txt", status: "completed" }] }),
          },
        };
        yield {
          type: "tool-call",
          call: { id: "c3", name: "memory_save", arguments: JSON.stringify({ key: "project", content: "OpenGPT Forge" }) },
        };
        yield { type: "finish", reason: "tool-calls" };
      },
      // Step 2: delegate_task to subagent
      async function* () {
        yield {
          type: "tool-call",
          call: { id: "c4", name: "delegate_task", arguments: JSON.stringify({ task: "Read hello.txt", role: "Verifier" }) },
        };
        yield { type: "finish", reason: "tool-calls" };
      },
      // Subagent Step 1: reads hello.txt
      async function* () {
        yield { type: "tool-call", call: { id: "sc1", name: "read_file", arguments: JSON.stringify({ path: "hello.txt" }) } };
        yield { type: "finish", reason: "tool-calls" };
      },
      // Subagent Step 2: returns report
      async function* (req) {
        const lastTool = req.messages.at(-1);
        expect(lastTool?.role).toBe("tool");
        expect(lastTool?.content).toContain("Forge works!");
        yield { type: "text-delta", text: "Verified hello.txt contains Forge works!" };
        yield { type: "finish", reason: "stop" };
      },
      // Parent Step 3: final answer
      async function* (req) {
        const lastTool = req.messages.at(-1);
        expect(lastTool?.content).toContain("Verified hello.txt");
        yield { type: "text-delta", text: "All tasks completed and verified." };
        yield { type: "usage", usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } };
        yield { type: "finish", reason: "stop" };
      },
    ]);

    const providers = new ProviderRegistry();
    providers.register(adapter);
    providers.setDefault("deepseek");

    const harness = new ForgeHarness({ workspaceRoot: workspace, dataDir, providers });
    await harness.init();
    const app = createHarnessApp(harness);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}`;

    try {
      const health = (await (await fetch(`${url}/api/health`)).json()) as { status: string; toolCount: number };
      expect(health.status).toBe("ok");
      expect(health.toolCount).toBeGreaterThanOrEqual(12);

      const created = (await (
        await fetch(`${url}/api/conversations`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: "deepseek", model: "deepseek-chat", instructions: "Test" }),
        })
      ).json()) as { id: string };

      const msgRes = await fetch(`${url}/api/conversations/${created.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Create and verify hello.txt" }),
      });
      expect(msgRes.status).toBe(200);
      const rawLines = (await msgRes.text()).trim().split("\n");
      const events = rawLines.map((l) => JSON.parse(l) as StreamEvent);

      expect(events.some((e) => e.type === "reasoning.delta")).toBe(true);
      expect(events.some((e) => e.type === "tool.end" && e.name === "write_file" && !e.error)).toBe(true);
      expect(events.some((e) => e.type === "plan.update")).toBe(true);
      expect(events.some((e) => e.type === "subagent.event" && e.status === "completed")).toBe(true);
      const endEv = events.find((e) => e.type === "message.end");
      expect(endEv?.type === "message.end" && endEv.conversation.messages.at(-1)?.content).toContain(
        "All tasks completed and verified.",
      );

      // Verify file written on disk and memory persisted
      expect(await readFile(path.join(workspace, "hello.txt"), "utf8")).toBe("Forge works!");
      const mems = (await (await fetch(`${url}/api/memory?q=Forge`)).json()) as Array<{ key: string }>;
      expect(mems.some((m) => m.key === "project")).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await harness.dispose();
    }
  });
});
