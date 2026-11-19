import { z } from "zod";
import type { TodoItem } from "../../shared/types.js";
import type { HarnessTool } from "./types.js";

const todoItemSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  status: z.enum(["pending", "in_progress", "completed", "blocked"]),
  notes: z.string().max(500).optional(),
});

export const manageTodosTool: HarnessTool = {
  name: "manage_todos",
  category: "planning",
  concurrencySafe: false,
  requiredSandboxMode: "read-only",
  description:
    "Create, update, or replace the structured task plan for the current session to decompose complex work and track progress.",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "Complete ordered list of task items.",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            status: { type: "string", enum: ["pending", "in_progress", "completed", "blocked"] },
            notes: { type: "string" },
          },
          required: ["id", "title", "status"],
          additionalProperties: false,
        },
      },
    },
    required: ["todos"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const parsed = z.object({ todos: z.array(todoItemSchema).max(50) }).parse(input);
    const todos: TodoItem[] = parsed.todos;
    await ctx.session.append({ type: "plan/todos", data: { todos } });
    const plan = ctx.session.derivePlanState();
    ctx.emit({ type: "plan.update", plan });
    return { count: todos.length, plan };
  },
  summarize(result) {
    const r = result as { count: number };
    return `Updated task plan (${r.count} items)`;
  },
};

export const setPlanModeTool: HarnessTool = {
  name: "set_plan_mode",
  category: "planning",
  concurrencySafe: false,
  requiredSandboxMode: "read-only",
  description: "Enable or exit Plan Mode for the current session.",
  parameters: {
    type: "object",
    properties: {
      active: { type: "boolean", description: "True to enter plan mode, false to exit." },
    },
    required: ["active"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const { active } = z.object({ active: z.boolean() }).parse(input);
    await ctx.session.append({ type: "plan/mode", data: { active } });
    const plan = ctx.session.derivePlanState();
    ctx.emit({ type: "plan.update", plan });
    return { active, plan };
  },
  summarize(result) {
    const r = result as { active: boolean };
    return r.active ? "Entered Plan Mode" : "Exited Plan Mode";
  },
};

export const planTools: HarnessTool[] = [manageTodosTool, setPlanModeTool];
