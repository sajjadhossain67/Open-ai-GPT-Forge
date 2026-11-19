import { z } from "zod";
import type { ToolPlugin } from "./types.js";

const calculatorInput = z.object({ expression: z.string().min(1).max(200) });

function calculate(expression: string): number {
  if (!/^[0-9+\-*/().%\s]+$/.test(expression)) throw new Error("Expression contains unsupported characters");
  const tokens = expression.match(/\d+(?:\.\d+)?|[()+\-*/%]/g);
  if (!tokens || tokens.join("") !== expression.replace(/\s/g, "")) throw new Error("Invalid expression");
  let index = 0;
  const parsePrimary = (): number => {
    const token = tokens[index++];
    if (token === "(") {
      const value = parseExpression();
      if (tokens[index++] !== ")") throw new Error("Missing closing parenthesis");
      return value;
    }
    if (token === "+") return parsePrimary();
    if (token === "-") return -parsePrimary();
    const value = Number(token);
    if (!Number.isFinite(value)) throw new Error("Expected a number");
    return value;
  };
  const parseTerm = (): number => {
    let value = parsePrimary();
    while (["*", "/", "%"].includes(tokens[index] ?? "")) {
      const op = tokens[index++];
      const right = parsePrimary();
      if ((op === "/" || op === "%") && right === 0) throw new Error("Division by zero");
      value = op === "*" ? value * right : op === "/" ? value / right : value % right;
    }
    return value;
  };
  const parseExpression = (): number => {
    let value = parseTerm();
    while (["+", "-"].includes(tokens[index] ?? "")) {
      const op = tokens[index++];
      const right = parseTerm();
      value = op === "+" ? value + right : value - right;
    }
    return value;
  };
  const result = parseExpression();
  if (index !== tokens.length || !Number.isFinite(result)) throw new Error("Invalid expression");
  return result;
}

export const calculatorTool: ToolPlugin = {
  name: "calculator",
  description: "Evaluate a basic arithmetic expression safely.",
  parameters: {
    type: "object",
    properties: { expression: { type: "string", description: "Arithmetic using numbers, parentheses, +, -, *, /, and %." } },
    required: ["expression"],
    additionalProperties: false,
  },
  async execute(input) {
    return { result: calculate(calculatorInput.parse(input).expression) };
  },
  summarize(result) {
    return `Calculated ${String((result as { result: number }).result)}`;
  },
};

export const currentTimeTool: ToolPlugin = {
  name: "current_time",
  description: "Return the current date and time for an IANA time zone.",
  parameters: {
    type: "object",
    properties: { timeZone: { type: "string", description: "IANA time zone, for example Asia/Dhaka." } },
    required: ["timeZone"],
    additionalProperties: false,
  },
  async execute(input) {
    const { timeZone } = z.object({ timeZone: z.string().min(1).max(100) }).parse(input);
    const formatted = new Intl.DateTimeFormat("en-US", { dateStyle: "full", timeStyle: "long", timeZone }).format(new Date());
    return { timeZone, formatted };
  },
  summarize(result) {
    return `Read time in ${(result as { timeZone: string }).timeZone}`;
  },
};

export { calculate };
