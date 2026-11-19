import type { EventSession } from "./session.js";

export interface PromptSectionContext {
  session: EventSession;
  baseInstructions: string;
}

export interface PromptSection {
  readonly id: string;
  readonly order: number;
  render(context: PromptSectionContext): string | undefined | Promise<string | undefined>;
}

/**
 * Modular system-prompt assembler inspired by DeepSeek Harness's `ctx.systemPrompt`.
 * Plugins contribute ordered sections (base persona, workspace info, plan mode, memory, MCP instructions).
 */
export class PromptAssembler {
  readonly #sections = new Map<string, PromptSection>();

  register(section: PromptSection): () => void {
    this.#sections.set(section.id, section);
    return () => {
      if (this.#sections.get(section.id) === section) {
        this.#sections.delete(section.id);
      }
    };
  }

  async assemble(context: PromptSectionContext): Promise<string> {
    const ordered = [...this.#sections.values()].sort((a, b) => a.order - b.order);
    const parts: string[] = [];
    for (const section of ordered) {
      const rendered = await section.render(context);
      if (rendered && rendered.trim()) {
        parts.push(rendered.trim());
      }
    }
    return parts.join("\n\n");
  }
}

export function createDefaultPromptAssembler(options: {
  getMemorySnippet?: () => Promise<string | undefined>;
  getMcpInstructions?: () => string | undefined;
} = {}): PromptAssembler {
  const assembler = new PromptAssembler();

  assembler.register({
    id: "core:base",
    order: 10,
    render: ({ baseInstructions }) =>
      baseInstructions.trim() ||
      "You are OpenGPT Forge, an autonomous AI engineering agent. Think carefully, use tools accurately, verify your work, and keep responses clear and concise.",
  });

  assembler.register({
    id: "core:workspace",
    order: 20,
    render: ({ session }) =>
      [
        "## Execution Environment",
        `- Workspace root: ${session.meta.workspaceRoot}`,
        `- Sandbox mode: ${session.meta.sandboxMode}`,
        `- Platform: ${process.platform}`,
        "Always respect workspace boundaries and verify file edits or commands before concluding.",
      ].join("\n"),
  });

  assembler.register({
    id: "core:plan-mode",
    order: 40,
    render: ({ session }) => {
      const plan = session.derivePlanState();
      const lines: string[] = [];
      if (plan.active) {
        lines.push(
          "## Plan Mode Active",
          "You are currently in Plan Mode. Focus on research, architecture, task decomposition, and proposing a clear step-by-step plan before making destructive edits.",
        );
      }
      if (plan.todos.length > 0) {
        lines.push("## Current Task Plan");
        for (const todo of plan.todos) {
          lines.push(`- [${todo.status}] (${todo.id}) ${todo.title}${todo.notes ? ` — ${todo.notes}` : ""}`);
        }
      }
      return lines.length > 0 ? lines.join("\n") : undefined;
    },
  });

  if (options.getMemorySnippet) {
    const getMemorySnippet = options.getMemorySnippet;
    assembler.register({
      id: "core:memory",
      order: 60,
      render: () => getMemorySnippet(),
    });
  }

  if (options.getMcpInstructions) {
    const getMcpInstructions = options.getMcpInstructions;
    assembler.register({
      id: "core:mcp",
      order: 70,
      render: () => getMcpInstructions(),
    });
  }

  return assembler;
}
