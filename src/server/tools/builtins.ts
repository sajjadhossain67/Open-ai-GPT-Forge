import { calculatorTool, currentTimeTool } from "../plugins/builtins.js";
import type { HarnessTool } from "./types.js";

export const builtinUtilityTools: HarnessTool[] = [
  {
    name: calculatorTool.name,
    description: calculatorTool.description,
    parameters: calculatorTool.parameters,
    category: "utility",
    concurrencySafe: true,
    requiredSandboxMode: "read-only",
    source: "builtin",
    execute: (input, ctx) => calculatorTool.execute(input, { signal: ctx.signal }),
    summarize: calculatorTool.summarize,
  },
  {
    name: currentTimeTool.name,
    description: currentTimeTool.description,
    parameters: currentTimeTool.parameters,
    category: "utility",
    concurrencySafe: true,
    requiredSandboxMode: "read-only",
    source: "builtin",
    execute: (input, ctx) => currentTimeTool.execute(input, { signal: ctx.signal }),
    summarize: currentTimeTool.summarize,
  },
];
