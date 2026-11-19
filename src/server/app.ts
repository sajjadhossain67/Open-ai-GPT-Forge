import { randomUUID } from "node:crypto";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { z } from "zod";
import type { ChatMessage, ProviderId, SandboxMode, StreamEvent, ToolEvent } from "../shared/types.js";
import type { ForgeHarness } from "./harness.js";
import type { ModelProvider } from "./plugins/types.js";
import { LlmFailure } from "./providers/types.js";
import type { ConversationStore } from "./store.js";

const providerEnum = z.enum(["openai", "deepseek", "anthropic", "gemini", "local"]);
const sandboxEnum = z.enum(["read-only", "workspace-write", "danger-full-access"]);

const createConversationSchema = z.object({
  provider: providerEnum.optional(),
  model: z.string().trim().min(1).max(120).optional(),
  instructions: z.string().max(20_000).default(""),
  sandboxMode: sandboxEnum.optional(),
});

const patchConversationSchema = z.object({
  provider: providerEnum.optional(),
  model: z.string().trim().min(1).max(120).optional(),
  instructions: z.string().max(20_000).optional(),
  sandboxMode: sandboxEnum.optional(),
  planActive: z.boolean().optional(),
});

const messageSchema = z.object({ content: z.string().trim().min(1).max(100_000) });

const memoryUpsertSchema = z.object({
  key: z.string().trim().min(1).max(120),
  content: z.string().trim().min(1).max(10_000),
  tags: z.array(z.string().max(40)).max(10).default([]),
});

/**
 * Primary Express API for OpenGPT Forge Harness.
 * Preserves full `/api/conversations` contract while exposing multi-provider,
 * sandbox, tool, memory, MCP, event log, and compaction endpoints.
 */
export function createHarnessApp(harness: ForgeHarness) {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/ }));
  app.use(express.json({ limit: "512kb" }));

  app.get("/api/health", (_req, res) => {
    const route = harness.getDefaultRoute();
    res.json({
      status: "ok",
      provider: route.provider,
      model: route.model,
      workspaceRoot: harness.workspaceRoot,
      sandboxMode: harness.defaultSandboxMode,
      providers: harness.providers.listInfo(),
      toolCount: harness.tools.all().length,
      mcpServers: harness.mcp.listStatuses(),
    });
  });

  app.get("/api/providers", (_req, res) => {
    res.json({
      default: harness.getDefaultRoute(),
      providers: harness.providers.listInfo(),
    });
  });

  app.get("/api/tools", (_req, res) => {
    res.json(harness.tools.listInfo());
  });

  app.get("/api/mcp", (_req, res) => {
    res.json(harness.mcp.listStatuses());
  });

  app.get("/api/memory", async (req, res, next) => {
    try {
      const q = typeof req.query.q === "string" ? req.query.q : "";
      const tag = typeof req.query.tag === "string" ? req.query.tag : undefined;
      const entries = q || tag ? await harness.memory.search(q, tag) : await harness.memory.list();
      res.json(entries);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/memory", async (req, res, next) => {
    try {
      const input = memoryUpsertSchema.parse(req.body);
      const entry = await harness.memory.upsert(input.key, input.content, input.tags);
      res.status(201).json(entry);
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/memory/:key", async (req, res, next) => {
    try {
      const deleted = await harness.memory.delete(req.params.key);
      deleted ? res.status(204).end() : res.status(404).json({ error: "Memory entry not found" });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/conversations", async (_req, res, next) => {
    try {
      res.json(await harness.sessions.list());
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/conversations/:id", async (req, res, next) => {
    try {
      const session = await harness.sessions.get(req.params.id);
      session ? res.json(session.toConversation()) : res.status(404).json({ error: "Conversation not found" });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/conversations/:id/events", async (req, res, next) => {
    try {
      const session = await harness.sessions.get(req.params.id);
      session ? res.json(session.events) : res.status(404).json({ error: "Conversation not found" });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/conversations", async (req, res, next) => {
    try {
      const input = createConversationSchema.parse(req.body ?? {});
      const defaultRoute = harness.getDefaultRoute();
      const provider: ProviderId = input.provider ?? defaultRoute.provider;
      const adapter = harness.providers.require(provider);
      const model = input.model ?? adapter.defaultModel;
      const sandboxMode: SandboxMode = input.sandboxMode ?? harness.defaultSandboxMode;
      const session = await harness.sessions.create({
        provider,
        model,
        instructions: input.instructions,
        sandboxMode,
        workspaceRoot: harness.workspaceRoot,
      });
      res.status(201).json(session.toConversation());
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/conversations/:id", async (req, res, next) => {
    try {
      const session = await harness.sessions.get(req.params.id);
      if (!session) return res.status(404).json({ error: "Conversation not found" });
      const patch = patchConversationSchema.parse(req.body ?? {});
      const metaUpdate: Record<string, unknown> = {};
      if (patch.provider) {
        harness.providers.require(patch.provider);
        metaUpdate.provider = patch.provider;
      }
      if (patch.model) metaUpdate.model = patch.model;
      if (patch.instructions !== undefined) metaUpdate.instructions = patch.instructions;
      if (patch.sandboxMode) metaUpdate.sandboxMode = patch.sandboxMode;
      if (Object.keys(metaUpdate).length > 0) {
        await session.append({ type: "session/meta", data: metaUpdate });
      }
      if (patch.planActive !== undefined) {
        await session.append({ type: "plan/mode", data: { active: patch.planActive } });
      }
      res.json(session.toConversation());
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/conversations/:id", async (req, res, next) => {
    try {
      (await harness.sessions.delete(req.params.id))
        ? res.status(204).end()
        : res.status(404).json({ error: "Conversation not found" });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/conversations/:id/compact", async (req, res, next) => {
    try {
      const session = await harness.sessions.get(req.params.id);
      if (!session) return res.status(404).json({ error: "Conversation not found" });
      const adapter = harness.providers.get(session.meta.provider);
      const outcome = await harness.compaction.compact(session, {
        adapter,
        model: session.meta.model,
        force: true,
      });
      res.json(outcome);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/conversations/:id/messages", async (req, res, next) => {
    try {
      const { content } = messageSchema.parse(req.body);
      const session = await harness.sessions.get(req.params.id);
      if (!session) return res.status(404).json({ error: "Conversation not found" });

      res.status(200).set({
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Content-Type-Options": "nosniff",
      });
      res.flushHeaders();

      const send = (event: StreamEvent) => {
        if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
      };

      const controller = new AbortController();
      req.on("close", () => {
        if (!res.writableEnded) controller.abort(new Error("Client disconnected"));
      });

      try {
        await harness.loop.runTurn({
          session,
          userContent: content,
          emit: send,
          signal: controller.signal,
        });
        send({ type: "message.end", conversation: session.toConversation() });
      } catch (error) {
        if (!controller.signal.aborted) {
          send({ type: "error", message: publicError(error) });
        }
      } finally {
        if (!res.writableEnded) res.end();
      }
    } catch (error) {
      next(error);
    }
  });

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        error: "Invalid request",
        details: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      });
    }
    harness.logger.error("HTTP request error", { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: publicError(error) });
  });

  return app;
}

/**
 * Backwards-compatible factory preserved from the initial OpenAI Chat Forge slice.
 */
export function createApp(store: ConversationStore, provider: ModelProvider, defaultModel: string) {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/ }));
  app.use(express.json({ limit: "256kb" }));

  app.get("/api/health", (_request, response) =>
    response.json({ status: "ok", provider: provider.id, model: defaultModel }),
  );
  app.get("/api/conversations", async (_request, response, next) => {
    try {
      response.json(await store.list());
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/conversations/:id", async (request, response, next) => {
    try {
      const item = await store.get(request.params.id);
      item ? response.json(item) : response.status(404).json({ error: "Conversation not found" });
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/conversations", async (request, response, next) => {
    try {
      const input = z
        .object({ model: z.string().trim().min(1).max(100), instructions: z.string().max(20_000).default("") })
        .parse({ model: request.body.model ?? defaultModel, instructions: request.body.instructions ?? "" });
      response.status(201).json(await store.create(input.model, input.instructions));
    } catch (error) {
      next(error);
    }
  });
  app.delete("/api/conversations/:id", async (request, response, next) => {
    try {
      (await store.delete(request.params.id))
        ? response.status(204).end()
        : response.status(404).json({ error: "Conversation not found" });
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/conversations/:id/messages", async (request, response, next) => {
    try {
      const { content } = messageSchema.parse(request.body);
      const conversation = await store.get(request.params.id);
      if (!conversation) return response.status(404).json({ error: "Conversation not found" });
      const userMessage: ChatMessage = {
        id: randomUUID(),
        role: "user",
        content,
        createdAt: new Date().toISOString(),
        status: "complete",
      };
      const updated = await store.addMessage(conversation.id, userMessage);
      response.status(200).set({
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Content-Type-Options": "nosniff",
      });
      response.flushHeaders();
      const send = (event: StreamEvent) => response.write(`${JSON.stringify(event)}\n`);
      const messageId = randomUUID();
      send({ type: "message.start", messageId });
      let assistantContent = "";
      const toolEvents: ToolEvent[] = [];
      const controller = new AbortController();
      request.on("close", () => controller.abort(new Error("Client disconnected")));
      try {
        for await (const event of provider.run({
          model: updated.model,
          instructions: updated.instructions,
          messages: updated.messages.map(({ role, content: text }) => ({ role, content: text })),
          signal: controller.signal,
        })) {
          if (event.type === "text") {
            assistantContent += event.delta;
            send({ type: "message.delta", delta: event.delta });
          }
          if (event.type === "tool.start") {
            toolEvents.push({ id: event.id, name: event.name, status: "running" });
            send({ type: "tool.start", id: event.id, name: event.name });
          }
          if (event.type === "tool.end") {
            const tool = toolEvents.find((item) => item.id === event.id);
            if (tool) Object.assign(tool, { status: event.error ? "error" : "complete", summary: event.summary });
            send({ type: "tool.end", id: event.id, name: event.name, summary: event.summary, error: event.error });
          }
        }
        if (!assistantContent.trim()) {
          assistantContent = "I completed the requested tool work, but no text response was produced.";
        }
        const finalConversation = await store.addMessage(conversation.id, {
          id: messageId,
          role: "assistant",
          content: assistantContent,
          createdAt: new Date().toISOString(),
          status: "complete",
          toolEvents,
        });
        send({ type: "message.end", conversation: finalConversation });
      } catch (error) {
        if (!controller.signal.aborted) send({ type: "error", message: publicError(error) });
      } finally {
        response.end();
      }
    } catch (error) {
      next(error);
    }
  });

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof z.ZodError) {
      return response.status(400).json({
        error: "Invalid request",
        details: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      });
    }
    console.error(error);
    response.status(500).json({ error: publicError(error) });
  });
  return app;
}

function publicError(error: unknown): string {
  if (error instanceof LlmFailure) {
    if (error.code === "NOT_CONFIGURED" || error.code === "AUTH_FAILED") {
      return `${error.provider} authentication failed. Configure the corresponding API key in .env.`;
    }
    if (error.code === "RATE_LIMITED") {
      return `${error.provider} rate limit reached. Please wait and try again.`;
    }
    return error.message;
  }
  if (error instanceof Error && /api key|401|authentication/i.test(error.message)) {
    return "Provider authentication failed. Check your API key on the server.";
  }
  if (error instanceof Error && /rate|429/i.test(error.message)) {
    return "Provider rate limit reached. Please wait and try again.";
  }
  return error instanceof Error ? error.message : "Unexpected server error";
}
