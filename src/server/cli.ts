#!/usr/bin/env node
import "dotenv/config";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { ProviderId, SandboxMode, StreamEvent } from "../shared/types.js";
import { ForgeHarness } from "./harness.js";

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function renderStreamEvent(event: StreamEvent): void {
  if (event.type === "reasoning.delta") {
    output.write(`\x1b[2m${event.delta}\x1b[0m`);
  } else if (event.type === "message.delta") {
    output.write(event.delta);
  } else if (event.type === "tool.start") {
    output.write(`\n\x1b[36m[tool:start] ${event.name}\x1b[0m\n`);
  } else if (event.type === "tool.end") {
    const color = event.error ? "\x1b[31m" : "\x1b[32m";
    output.write(`${color}[tool:${event.error ? "error" : "done"}] ${event.name}: ${event.summary}\x1b[0m\n`);
  } else if (event.type === "compaction.done") {
    output.write(`\n\x1b[33m[compaction] Summarized ${event.prunedMessages} messages\x1b[0m\n`);
  } else if (event.type === "subagent.event") {
    output.write(`\n\x1b[35m[subagent:${event.status}] ${event.subagentId}: ${event.summary ?? event.task}\x1b[0m\n`);
  } else if (event.type === "error") {
    output.write(`\n\x1b[31m[error] ${event.message}\x1b[0m\n`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "help";

  if (command === "help" || command === "--help" || command === "-h") {
    console.log(`OpenGPT Forge CLI

Usage:
  forge run "<prompt>" [--provider <id>] [--model <name>] [--sandbox <mode>] [--workspace <dir>]
  forge chat [--provider <id>] [--model <name>] [--sandbox <mode>] [--workspace <dir>]
  forge models
  forge tools
  forge help

Providers: deepseek | openai | anthropic | gemini | local
Sandbox modes: read-only | workspace-write | danger-full-access`);
    return;
  }

  const workspaceRoot = parseFlag(args, "--workspace");
  const sandboxFlag = parseFlag(args, "--sandbox") as SandboxMode | undefined;
  const providerFlag = parseFlag(args, "--provider") as ProviderId | undefined;
  const modelFlag = parseFlag(args, "--model");

  const harness = new ForgeHarness({
    workspaceRoot,
    defaultSandboxMode: sandboxFlag,
  });
  await harness.init();

  try {
    if (command === "models") {
      const def = harness.getDefaultRoute();
      console.log(`Default route: ${def.provider}/${def.model}\n`);
      for (const p of harness.providers.listInfo()) {
        console.log(
          `- ${p.id.padEnd(10)} ${p.configured ? "[configured]    " : "[not configured]"} default=${p.defaultModel} | models: ${p.models.join(", ")}`,
        );
      }
      return;
    }

    if (command === "tools") {
      for (const tool of harness.tools.listInfo()) {
        console.log(
          `- ${tool.name.padEnd(18)} [${tool.category}] sandbox=${tool.requiredSandboxMode} parallel=${tool.concurrencySafe} :: ${tool.description}`,
        );
      }
      return;
    }

    const defaultRoute = harness.getDefaultRoute();
    const provider = providerFlag ?? defaultRoute.provider;
    const adapter = harness.providers.require(provider);
    const model = modelFlag ?? adapter.defaultModel;
    const sandboxMode = sandboxFlag ?? harness.defaultSandboxMode;

    if (command === "run") {
      const promptParts: string[] = [];
      for (let i = 1; i < args.length; i += 1) {
        const token = args[i]!;
        if (token.startsWith("--")) {
          i += 1;
          continue;
        }
        promptParts.push(token);
      }
      const prompt = promptParts.join(" ").trim();
      if (!prompt) {
        console.error('Error: Provide a prompt, e.g. `forge run "Inspect the repository"`');
        process.exitCode = 1;
        return;
      }

      const session = await harness.sessions.create({
        provider,
        model,
        instructions: "",
        sandboxMode,
        workspaceRoot: harness.workspaceRoot,
      });

      const controller = new AbortController();
      process.once("SIGINT", () => controller.abort(new Error("Interrupted")));

      await harness.loop.runTurn({
        session,
        userContent: prompt,
        emit: renderStreamEvent,
        signal: controller.signal,
      });
      output.write("\n");
      return;
    }

    if (command === "chat") {
      const session = await harness.sessions.create({
        provider,
        model,
        instructions: "",
        sandboxMode,
        workspaceRoot: harness.workspaceRoot,
      });
      console.log(`OpenGPT Forge Interactive Session (${session.meta.provider}/${session.meta.model})`);
      console.log(`Workspace: ${session.meta.workspaceRoot} | Sandbox: ${session.meta.sandboxMode}`);
      console.log("Commands: /plan [on|off], /compact, /tools, /exit\n");

      const rl = readline.createInterface({ input, output });
      try {
        while (true) {
          const line = (await rl.question("\nforge> ")).trim();
          if (!line) continue;
          if (line === "/exit" || line === "/quit") break;
          if (line === "/tools") {
            console.log(harness.tools.all().map((t) => t.name).join(", "));
            continue;
          }
          if (line === "/compact") {
            const res = await harness.compaction.compact(session, { adapter, model, force: true });
            console.log(`Compacted=${res.compacted}, pruned=${res.prunedMessages}, tokens ${res.estimatedTokensBefore} -> ${res.estimatedTokensAfter}`);
            continue;
          }
          if (line.startsWith("/plan")) {
            const active = !line.endsWith("off");
            await session.append({ type: "plan/mode", data: { active } });
            console.log(`Plan mode: ${active ? "ON" : "OFF"}`);
            continue;
          }

          const controller = new AbortController();
          await harness.loop.runTurn({
            session,
            userContent: line,
            emit: renderStreamEvent,
            signal: controller.signal,
          });
          output.write("\n");
        }
      } finally {
        rl.close();
      }
      return;
    }

    console.error(`Unknown command: ${command}. Run "forge help" for usage.`);
    process.exitCode = 1;
  } finally {
    await harness.dispose();
  }
}

void main();
