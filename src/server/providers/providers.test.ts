import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AnthropicAdapter } from "./anthropic.js";
import { GeminiAdapter } from "./gemini.js";
import { OpenAICompatAdapter } from "./openai-compat.js";
import { LlmFailure, type LlmStreamChunk } from "./types.js";

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? "";

    if (url.startsWith("/error-429")) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Rate limit exceeded" } }));
      return;
    }

    if (url.startsWith("/error-overflow")) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "maximum context length exceeded" } }));
      return;
    }

    if (url === "/openai/chat/completions") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "Thinking..." } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Answer: " } }] })}\n\n`);
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "calc", arguments: '{"x":' } }] } }],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "42}" } }] }, finish_reason: "tool_calls" }],
        })}\n\n`,
      );
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    if (url === "/anthropic/messages") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 12 } } })}\n\n`);
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Step 1" } })}\n\n`);
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hello Claude" } })}\n\n`);
      res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "read_file" } })}\n\n`);
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"path":"README.md"}' } })}\n\n`);
      res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 8 } })}\n\n`);
      res.end();
      return;
    }

    if (url.includes(":streamGenerateContent")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          candidates: [{ content: { parts: [{ thought: true, text: "Inspecting" }, { text: "Hello Gemini" }] } }],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          candidates: [{ content: { parts: [{ functionCall: { name: "calculator", args: { expression: "2+2" } } }] } }],
          usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4, totalTokenCount: 13 },
        })}\n\n`,
      );
      res.end();
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function collect(gen: AsyncGenerator<LlmStreamChunk>): Promise<LlmStreamChunk[]> {
  const out: LlmStreamChunk[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

describe("Multi-provider streaming adapters", () => {
  it("streams reasoning, text, tool calls, and usage for DeepSeek/OpenAI-compatible APIs", async () => {
    const adapter = new OpenAICompatAdapter({
      id: "deepseek",
      label: "DeepSeek",
      baseUrl: `${baseUrl}/openai`,
      apiKey: "test-key",
      defaultModel: "deepseek-reasoner",
      models: ["deepseek-reasoner"],
      supportsReasoning: true,
    });

    const chunks = await collect(
      adapter.stream({
        model: "deepseek-reasoner",
        systemPrompt: "Sys",
        messages: [{ role: "user", content: "Hi" }],
        tools: [],
        signal: new AbortController().signal,
      }),
    );

    expect(chunks.find((c) => c.type === "reasoning-delta")).toEqual({ type: "reasoning-delta", text: "Thinking..." });
    expect(chunks.find((c) => c.type === "text-delta")).toEqual({ type: "text-delta", text: "Answer: " });
    expect(chunks.find((c) => c.type === "tool-call")).toEqual({
      type: "tool-call",
      call: { id: "call_1", name: "calc", arguments: '{"x":42}' },
    });
    expect(chunks.find((c) => c.type === "usage")).toEqual({
      type: "usage",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, reasoningTokens: undefined },
    });
  });

  it("streams thinking, text, and tool_use for Anthropic Messages API", async () => {
    const adapter = new AnthropicAdapter({ apiKey: "test-key", baseUrl: `${baseUrl}/anthropic` });
    const chunks = await collect(
      adapter.stream({
        model: "claude-sonnet-4-20250514",
        systemPrompt: "Sys",
        messages: [{ role: "user", content: "Hi" }],
        tools: [],
        signal: new AbortController().signal,
      }),
    );

    expect(chunks.find((c) => c.type === "reasoning-delta")).toEqual({ type: "reasoning-delta", text: "Step 1" });
    expect(chunks.find((c) => c.type === "text-delta")).toEqual({ type: "text-delta", text: "Hello Claude" });
    expect(chunks.find((c) => c.type === "tool-call")).toEqual({
      type: "tool-call",
      call: { id: "toolu_1", name: "read_file", arguments: '{"path":"README.md"}' },
    });
  });

  it("streams thought parts, text, and functionCall for Gemini API", async () => {
    const adapter = new GeminiAdapter({ apiKey: "test-key", baseUrl });
    const chunks = await collect(
      adapter.stream({
        model: "gemini-2.5-flash",
        systemPrompt: "Sys",
        messages: [{ role: "user", content: "Hi" }],
        tools: [],
        signal: new AbortController().signal,
      }),
    );

    expect(chunks.find((c) => c.type === "reasoning-delta")).toEqual({ type: "reasoning-delta", text: "Inspecting" });
    expect(chunks.find((c) => c.type === "text-delta")).toEqual({ type: "text-delta", text: "Hello Gemini" });
    const toolChunk = chunks.find((c) => c.type === "tool-call");
    expect(toolChunk?.type === "tool-call" && toolChunk.call.name).toBe("calculator");
  });

  it("normalizes rate-limit and context-overflow HTTP errors into typed LlmFailure", async () => {
    const rateLimited = new OpenAICompatAdapter({
      id: "openai",
      label: "OpenAI",
      baseUrl: `${baseUrl}/error-429`,
      apiKey: "k",
      defaultModel: "gpt-4o-mini",
      models: ["gpt-4o-mini"],
    });
    await expect(
      collect(
        rateLimited.stream({
          model: "gpt-4o-mini",
          systemPrompt: "",
          messages: [{ role: "user", content: "hi" }],
          tools: [],
          signal: new AbortController().signal,
        }),
      ),
    ).rejects.toMatchObject({ code: "RATE_LIMITED", retryable: true });

    const overflow = new OpenAICompatAdapter({
      id: "openai",
      label: "OpenAI",
      baseUrl: `${baseUrl}/error-overflow`,
      apiKey: "k",
      defaultModel: "gpt-4o-mini",
      models: ["gpt-4o-mini"],
    });
    try {
      await collect(
        overflow.stream({
          model: "gpt-4o-mini",
          systemPrompt: "",
          messages: [{ role: "user", content: "hi" }],
          tools: [],
          signal: new AbortController().signal,
        }),
      );
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(LlmFailure);
      expect((err as LlmFailure).code).toBe("CONTEXT_OVERFLOW");
    }
  });
});
