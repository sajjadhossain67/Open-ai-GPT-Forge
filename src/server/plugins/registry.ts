import type { ToolPlugin } from "./types.js";

export class PluginRegistry {
  readonly #tools = new Map<string, ToolPlugin>();

  register(tool: ToolPlugin): void {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(tool.name)) {
      throw new Error(`Invalid tool name: ${tool.name}`);
    }
    if (this.#tools.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
    this.#tools.set(tool.name, tool);
  }

  get(name: string): ToolPlugin | undefined {
    return this.#tools.get(name);
  }

  all(): ToolPlugin[] {
    return [...this.#tools.values()];
  }
}
