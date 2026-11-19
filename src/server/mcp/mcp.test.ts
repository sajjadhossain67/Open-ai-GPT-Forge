import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "../core/session.js";
import { ToolRegistry } from "../tools/registry.js";
import { McpManager } from "./client.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

const MINI_MCP_SERVER = `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  if (req.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: req.id,
      result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mini", version: "1.0.0" } }
    }) + "\\n");
  } else if (req.method === "tools/list") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        tools: [{
          name: "echo_upper",
          description: "Uppercases input text",
          inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }
        }]
      }
    }) + "\\n");
  } else if (req.method === "tools/call") {
    const text = String(req.params?.arguments?.text ?? "").toUpperCase();
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: req.id,
      result: { content: [{ type: "text", text }] }
    }) + "\\n");
  }
});
`;

describe("McpManager stdio client", () => {
  it("connects to a real stdio MCP server, discovers tools, invokes them, and cleans up on dispose", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "forge-mcp-test-"));
    tempDirs.push(dir);
    const serverScript = path.join(dir, "mini-mcp.mjs");
    await writeFile(serverScript, MINI_MCP_SERVER, "utf8");

    const registry = new ToolRegistry();
    const manager = new McpManager(registry);
    const status = await manager.addServer({
      name: "demo",
      command: process.execPath,
      args: [serverScript],
    });

    expect(status.connected).toBe(true);
    expect(status.toolCount).toBe(1);
    expect(registry.get("mcp__demo__echo_upper")).toBeDefined();

    const sessions = new SessionStore(dir);
    const session = await sessions.create({
      provider: "openai",
      model: "gpt-4o-mini",
      instructions: "",
      sandboxMode: "read-only",
      workspaceRoot: dir,
    });

    const outcome = await registry.executeSingle(
      { id: "c1", name: "mcp__demo__echo_upper", arguments: JSON.stringify({ text: "hello forge" }) },
      {
        signal: new AbortController().signal,
        session,
        sandbox: { mode: "read-only", workspaceRoot: dir },
        emit: () => undefined,
      },
    );

    expect(outcome.isError).toBe(false);
    expect(JSON.parse(outcome.output)).toEqual({ content: [{ type: "text", text: "HELLO FORGE" }] });

    await manager.disposeAll();
    expect(registry.get("mcp__demo__echo_upper")).toBeUndefined();
  });
});
