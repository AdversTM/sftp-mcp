import { posix } from "node:path";

import { AuthorizationError } from "./errors.js";

export { AuthorizationError } from "./errors.js";

export type PathGuardConfig = {
  readonly readOnly: boolean;
  readonly destructiveActionsAllowed: boolean;
  readonly allowedReadPrefix?: string;
  readonly allowedWritePrefix?: string;
};

export type PathGuards = {
  readonly normalize: (input: string) => string;
  readonly guardRead: (input: string) => string;
  readonly guardWrite: (input: string) => string;
  readonly guardDestructive: (input: string) => string;
};

export function normalizeRemotePath(input: string): string {
  if (input.length === 0) {
    throw new AuthorizationError("path is required");
  }
  const normalized = posix.normalize(input);
  if (!normalized.startsWith("/")) {
    throw new AuthorizationError(`path must be absolute: '${input}'`);
  }
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function withinPrefix(path: string, prefix: string): boolean {
  return prefix === "/" || path === prefix || path.startsWith(`${prefix}/`);
}

function guardPrefix(path: string, prefix: string | undefined, kind: "read" | "write"): string {
  if (prefix !== undefined && !withinPrefix(path, prefix)) {
    const variable = kind === "read" ? "SFTP_ALLOWED_READ_PREFIX" : "SFTP_ALLOWED_WRITE_PREFIX";
    throw new AuthorizationError(`${kind} denied: '${path}' is outside ${variable} '${prefix}'`);
  }
  return path;
}

export function createPathGuards(config: Partial<PathGuardConfig> = {}): PathGuards {
  const readOnly = config.readOnly ?? false;
  const destructiveActionsAllowed = config.destructiveActionsAllowed ?? true;

  return {
    normalize: normalizeRemotePath,
    guardRead(input: string): string {
      return guardPrefix(normalizeRemotePath(input), config.allowedReadPrefix, "read");
    },
    guardWrite(input: string): string {
      if (readOnly) {
        throw new AuthorizationError("write denied: server is read-only (SFTP_READ_ONLY=true)");
      }
      return guardPrefix(normalizeRemotePath(input), config.allowedWritePrefix, "write");
    },
    guardDestructive(input: string): string {
      const path = this.guardWrite(input);
      if (!destructiveActionsAllowed) {
        throw new AuthorizationError("destructive action denied: SFTP_ALLOW_DESTRUCTIVE=false");
      }
      return path;
    },
  };
}
