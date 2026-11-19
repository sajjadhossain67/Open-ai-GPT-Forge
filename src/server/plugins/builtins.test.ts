import { describe, expect, it } from "vitest";
import { calculate } from "./builtins.js";

describe("calculator", () => {
  it("respects precedence and parentheses", () => expect(calculate("2 + 3 * (4 - 1)")).toBe(11));
  it("supports unary values", () => expect(calculate("-5 + +2")).toBe(-3));
  it("rejects executable input", () => expect(() => calculate("process.exit()" )).toThrow("unsupported"));
  it("rejects division by zero", () => expect(() => calculate("4 / 0")).toThrow("Division by zero"));
});
