import type { ForgePlugin } from "../src/server/core/plugin-host.js";
import type { ToolRegistry } from "../src/server/tools/registry.js";

/**
 * Example custom plugin demonstrating OpenGPT Forge's disposable plugin lifecycle.
 * Registers a custom tool and a `tools/post-execute` observation hook.
 */
export const wordCountPlugin: ForgePlugin = {
  name: "example-word-count",
  version: "1.0.0",
  setup(ctx) {
    const tools = ctx.requireService<ToolRegistry>("tools");

    const unregisterTool = tools.register({
      name: "word_count",
      category: "plugin",
      concurrencySafe: true,
      requiredSandboxMode: "read-only",
      source: "plugin",
      description: "Count words, lines, and characters in a text string.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to analyze." },
        },
        required: ["text"],
        additionalProperties: false,
      },
      async execute(input) {
        const text = String((input as { text?: string }).text ?? "");
        const words = text.trim() ? text.trim().split(/\s+/).length : 0;
        const lines = text ? text.split(/\r?\n/).length : 0;
        return { words, lines, chars: text.length };
      },
      summarize(result) {
        const r = result as { words: number; lines: number };
        return `Counted ${r.words} words across ${r.lines} line(s)`;
      },
    });

    ctx.onDispose(unregisterTool);

    ctx.onHook("tools/post-execute", async (outcome, next) => {
      ctx.logger.debug("Observed tool completion", { outcome });
      return next(outcome);
    });
  },
};
