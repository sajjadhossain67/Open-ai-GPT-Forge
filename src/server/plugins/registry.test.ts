import { describe, expect, it } from "vitest";
import { PluginRegistry } from "./registry.js";

const tool = { name: "example", description: "Example", parameters: {}, execute: async () => "ok" };
describe("PluginRegistry", () => {
  it("registers and resolves tools", () => { const registry = new PluginRegistry(); registry.register(tool); expect(registry.get("example")).toBe(tool); });
  it("rejects duplicate names", () => { const registry = new PluginRegistry(); registry.register(tool); expect(() => registry.register(tool)).toThrow("Duplicate"); });
  it("rejects unsafe names", () => { const registry = new PluginRegistry(); expect(() => registry.register({ ...tool, name: "Bad Tool" })).toThrow("Invalid"); });
});
