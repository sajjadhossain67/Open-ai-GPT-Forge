import OpenAI from "openai";
import type { ResponseInputItem, ResponseFunctionToolCall } from "openai/resources/responses/responses";
import type { ModelProvider, ProviderEvent, ProviderRequest } from "./plugins/types.js";
import { PluginRegistry } from "./plugins/registry.js";

const MAX_TOOL_ROUNDS = 8;

export class OpenAIProvider implements ModelProvider {
  readonly id = "openai";
  readonly #client: OpenAI;
  readonly #plugins: PluginRegistry;

  constructor(apiKey: string, plugins: PluginRegistry) {
    this.#client = new OpenAI({ apiKey, timeout: 120_000, maxRetries: 2 });
    this.#plugins = plugins;
  }

  async *run(request: ProviderRequest): AsyncGenerator<ProviderEvent, void, void> {
    let input: ResponseInputItem[] = request.messages.map((message) => ({ role: message.role, content: message.content }));
    let previousResponseId: string | undefined;

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
      if (request.signal.aborted) throw request.signal.reason;
      const stream = await this.#client.responses.create({
        model: request.model,
        instructions: request.instructions || undefined,
        input,
        previous_response_id: previousResponseId,
        tools: this.#plugins.all().map((tool) => ({ type: "function" as const, name: tool.name, description: tool.description, parameters: tool.parameters, strict: true })),
        stream: true,
      }, { signal: request.signal });

      const calls: ResponseFunctionToolCall[] = [];
      let responseId: string | undefined;
      for await (const event of stream) {
        if (event.type === "response.created") responseId = event.response.id;
        if (event.type === "response.output_text.delta") yield { type: "text", delta: event.delta };
        if (event.type === "response.output_item.done" && event.item.type === "function_call") calls.push(event.item);
        if (event.type === "response.failed") throw new Error(event.response.error?.message ?? "OpenAI response failed");
      }
      if (calls.length === 0) return;
      if (round === MAX_TOOL_ROUNDS) throw new Error("Tool loop limit reached");

      const outputs: ResponseInputItem[] = [];
      for (const call of calls) {
        const plugin = this.#plugins.get(call.name);
        yield { type: "tool.start", id: call.call_id, name: call.name };
        try {
          if (!plugin) throw new Error(`Unknown tool: ${call.name}`);
          const args: unknown = JSON.parse(call.arguments);
          const result = await plugin.execute(args, { signal: request.signal });
          const summary = plugin.summarize?.(result) ?? `${call.name} completed`;
          yield { type: "tool.end", id: call.call_id, name: call.name, summary };
          outputs.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result) });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Tool execution failed";
          yield { type: "tool.end", id: call.call_id, name: call.name, summary: message, error: true };
          outputs.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ error: message }) });
        }
      }
      if (!responseId) throw new Error("OpenAI response did not provide an id");
      previousResponseId = responseId;
      input = outputs;
    }
  }
}
