import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { SandboxMode } from "../../shared/types.js";

const MODE_RANK: Record<SandboxMode, number> = {
  "read-only": 0,
  "workspace-write": 1,
  "danger-full-access": 2,
};

export interface SandboxExecutionPolicy {
  readonly mode: SandboxMode;
  readonly workspaceRoot: string;
  readonly additionalWritableRoots?: readonly string[];
}

export class SandboxViolationError extends Error {
  readonly code: string;

  constructor(message: string, code = "SANDBOX_VIOLATION") {
    super(message);
    this.name = "SandboxViolationError";
    this.code = code;
  }
}

export function isModePermitted(current: SandboxMode, required: SandboxMode): boolean {
  return MODE_RANK[current] >= MODE_RANK[required];
}

export function assertModePermitted(current: SandboxMode, required: SandboxMode, action: string): void {
  if (!isModePermitted(current, required)) {
    throw new SandboxViolationError(
      `Action "${action}" requires sandbox mode "${required}", but current mode is "${current}".`,
      "SANDBOX_MODE_DENIED",
    );
  }
}

function isInsideRoot(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function resolveNearestExistingRealpath(targetPath: string): Promise<string> {
  const normalized = path.resolve(targetPath);
  try {
    return await realpath(normalized);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = path.dirname(normalized);
    if (parent === normalized) return normalized;
    const parentReal = await resolveNearestExistingRealpath(parent);
    return path.join(parentReal, path.basename(normalized));
  }
}

/**
 * Resolves a user/model-supplied path against `policy.workspaceRoot` and guarantees
 * that neither lexical `..` segments nor symlinks escape the permitted roots.
 */
export async function resolveConfinedPath(
  policy: SandboxExecutionPolicy,
  requestedPath: string,
  access: "read" | "write",
): Promise<string> {
  if (access === "write") {
    assertModePermitted(policy.mode, "workspace-write", `write "${requestedPath}"`);
  }

  const candidate = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(policy.workspaceRoot, requestedPath);

  if (policy.mode === "danger-full-access") {
    return candidate;
  }

  const canonicalRoot = await resolveNearestExistingRealpath(policy.workspaceRoot);
  const canonicalTarget = await resolveNearestExistingRealpath(candidate);

  const allowedRoots = [canonicalRoot];
  if (access === "write" && policy.additionalWritableRoots) {
    for (const extra of policy.additionalWritableRoots) {
      allowedRoots.push(await resolveNearestExistingRealpath(extra));
    }
  }

  // Reject dangling symlinks that point outside the workspace
  try {
    const stat = await lstat(candidate);
    if (stat.isSymbolicLink()) {
      const linkReal = await realpath(candidate);
      if (!allowedRoots.some((root) => isInsideRoot(root, linkReal))) {
        throw new SandboxViolationError(
          `Symlink "${requestedPath}" resolves outside the permitted workspace root.`,
          "SYMLINK_ESCAPE",
        );
      }
    }
  } catch (error) {
    if (error instanceof SandboxViolationError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new SandboxViolationError(
        `Unable to inspect path "${requestedPath}": ${(error as Error).message}`,
        "PATH_ACCESS_ERROR",
      );
    }
  }

  if (!allowedRoots.some((root) => isInsideRoot(root, canonicalTarget))) {
    throw new SandboxViolationError(
      `Path "${requestedPath}" escapes the permitted workspace root "${policy.workspaceRoot}".`,
      "PATH_ESCAPE",
    );
  }

  return canonicalTarget;
}
