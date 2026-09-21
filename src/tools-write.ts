import { posix } from "node:path";

import { z } from "zod";

import { ok, wrap } from "./mcp-results.js";
import { ensureRemoteDirectory, removeRemoteDirectory } from "./sftp-operations.js";
import type { ToolDependencies, ToolHandler } from "./tool-types.js";

const writeSchema = z.object({
  remotePath: z.string(),
  content: z.string(),
  createDirs: z.boolean().optional(),
});
const pathSchema = z.object({ remotePath: z.string() });
const mkdirSchema = pathSchema.extend({ recursive: z.boolean().optional() });
const rmdirSchema = pathSchema.extend({ recursive: z.boolean().optional() });
const renameSchema = z.object({ fromPath: z.string(), toPath: z.string() });
const uploadSchema = z.object({
  localPath: z.string(),
  remotePath: z.string(),
  createDirs: z.boolean().optional(),
});

export function createWriteTools(deps: ToolDependencies): Readonly<Record<string, ToolHandler>> {
  return {
    sftp_write: wrap(async (input) => {
      const { remotePath, content, createDirs } = writeSchema.parse(input);
      const path = deps.guards.guardWrite(remotePath);
      if (createDirs === true) {
        await ensureRemoteDirectory(deps.provider, deps.guards, posix.dirname(path));
      }
      await deps.provider.writeFile(path, Buffer.from(content, "utf8"));
      return ok(`wrote ${Buffer.byteLength(content, "utf8")} bytes → ${path}`);
    }),
    sftp_delete: wrap(async (input) => {
      const { remotePath } = pathSchema.parse(input);
      const path = deps.guards.guardDestructive(remotePath);
      await deps.provider.unlink(path);
      return ok(`deleted ${path}`);
    }),
    sftp_mkdir: wrap(async (input) => {
      const { remotePath, recursive } = mkdirSchema.parse(input);
      const path = deps.guards.guardWrite(remotePath);
      if (recursive === false) {
        await deps.provider.mkdir(path);
      } else {
        await ensureRemoteDirectory(deps.provider, deps.guards, path);
      }
      return ok(`created dir ${path}`);
    }),
    sftp_rmdir: wrap(async (input) => {
      const { remotePath, recursive } = rmdirSchema.parse(input);
      const path = deps.guards.guardDestructive(remotePath);
      if (recursive === true) {
        await removeRemoteDirectory(deps.provider, deps.guards, path);
      } else {
        await deps.provider.rmdir(path);
      }
      return ok(`removed dir ${path}${recursive === true ? " (recursive)" : ""}`);
    }),
    sftp_rename: wrap(async (input) => {
      const { fromPath, toPath } = renameSchema.parse(input);
      const from = deps.guards.guardDestructive(fromPath);
      const to = deps.guards.guardDestructive(toPath);
      await deps.provider.rename(from, to);
      return ok(`renamed ${from} → ${to}`);
    }),
    sftp_upload: wrap(async (input) => {
      const { localPath, remotePath, createDirs } = uploadSchema.parse(input);
      const path = deps.guards.guardWrite(remotePath);
      if (createDirs === true) {
        await ensureRemoteDirectory(deps.provider, deps.guards, posix.dirname(path));
      }
      await deps.provider.fastPut(localPath, path, deps.config.transfer);
      return ok(`uploaded ${localPath} → ${path}`);
    }),
  };
}
