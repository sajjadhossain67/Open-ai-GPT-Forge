import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createHarnessApp } from "./app.js";
import { ForgeHarness } from "./harness.js";

const port = Number(process.env.PORT ?? 3080);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be a valid TCP port");
}

const host = process.env.HOST ?? "127.0.0.1";
const harness = new ForgeHarness();
await harness.init();

const app = createHarnessApp(harness);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist");
app.use(express.static(root, { index: false, maxAge: "1h" }));
app.get("/{*path}", (_request, response) => response.sendFile(path.join(root, "index.html")));

const server = app.listen(port, host, () => {
  const route = harness.getDefaultRoute();
  const configured = harness.providers
    .listInfo()
    .filter((p) => p.configured)
    .map((p) => p.id)
    .join(", ");
  console.log(`OpenGPT Forge listening at http://${host}:${port}`);
  console.log(`Default route: ${route.provider}/${route.model} | Configured providers: ${configured || "none (local fallback)"}`);
  console.log(`Workspace: ${harness.workspaceRoot} | Sandbox: ${harness.defaultSandboxMode} | Tools: ${harness.tools.all().length}`);
});

const shutdown = async (signal: string) => {
  console.log(`\n${signal}: shutting down`);
  const forceTimer = setTimeout(() => process.exit(1), 10_000);
  forceTimer.unref();
  await harness.dispose();
  server.close(() => process.exit(0));
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
