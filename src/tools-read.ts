import { z } from "zod";

import { batchResult, fail, mapLimit, ok, wrap } from "./mcp-results.js";
import {
  ensureLocalParent,
  formatDirectoryEntry,
  isNotFound,
  statOutput,
  typeFromMode,
} from "./sftp-operations.js";
import type { ToolDependencies, ToolHandler } from "./tool-types.js";

const pathSchema = z.object({ remotePath: z.string() });
const downloadSchema = z.object({ remotePath: z.string(), localPath: z.string() });
const downloadManySchema = z.object({
  files: z.array(downloadSchema).min(1),
  concurrency: z.int().positive().optional(),
});

export function createReadTools(deps: ToolDependencies): Readonly<Record<string, ToolHandler>> {
  return {
    sftp_list: wrap(async (input) => {
      const { remotePath } = pathSchema.parse(input);
      const path = deps.guards.guardRead(remotePath);
      const entries = await deps.provider.readdir(path);
      if (entries.length === 0) {
        return ok(`(empty) ${path}`);
      }
      const body = entries
        .map((entry) => ({
          name: entry.filename,
          type: typeFromMode(entry.attrs.mode),
          size: entry.attrs.size,
          modifyTime: (entry.attrs.mtime ?? 0) * 1000,
        }))
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(formatDirectoryEntry)
        .join("\n");
      return ok(`${path} (${entries.length})\n${body}`);
    }),
    sftp_read: wrap(async (input) => {
      const { remotePath } = pathSchema.parse(input);
      const path = deps.guards.guardRead(remotePath);
      const stats = await deps.provider.stat(path);
      const size = stats.size ?? 0;
      if (size > deps.config.maxReadBytes) {
        return fail(
          `file is ${size} bytes (> ${deps.config.maxReadBytes}); use sftp_download instead`,
        );
      }
      const contents = await deps.provider.readFile(path);
      return ok(Buffer.isBuffer(contents) ? contents.toString("utf8") : contents);
    }),
    sftp_download: wrap(async (input) => {
      const { remotePath, localPath } = downloadSchema.parse(input);
      const path = deps.guards.guardRead(remotePath);
      ensureLocalParent(localPath);
      await deps.provider.fastGet(path, localPath, deps.config.transfer);
      return ok(`downloaded ${path} → ${localPath}`);
    }),
    sftp_stat: wrap(async (input) => {
      const { remotePath } = pathSchema.parse(input);
      const path = deps.guards.guardRead(remotePath);
      return ok(statOutput(path, await deps.provider.stat(path)));
    }),
    sftp_exists: wrap(async (input) => {
      const { remotePath } = pathSchema.parse(input);
      const path = deps.guards.guardRead(remotePath);
      try {
        return ok(typeFromMode((await deps.provider.lstat(path)).mode));
      } catch (error) {
        if (isNotFound(error)) {
          return ok("false");
        }
        throw error;
      }
    }),
    sftp_sha256: wrap(async (input) => {
      const { remotePath } = pathSchema.parse(input);
      const path = deps.guards.guardRead(remotePath);
      const { digest, method } = await deps.provider.sha256(path, deps.config.transfer);
      const how =
        method === "remote"
          ? "computed on server via sha256sum"
          : "streamed over SFTP, hashed locally";
      return ok(`${digest}  ${path}\n(${how})`);
    }),
    sftp_download_many: wrap(async (input) => {
      const { files, concurrency } = downloadManySchema.parse(input);
      const prepared = files.map((file) => ({
        ...file,
        remotePath: deps.guards.guardRead(file.remotePath),
      }));
      const results = await mapLimit(
        prepared,
        concurrency ?? deps.config.maxConcurrency,
        async (file) => {
          ensureLocalParent(file.localPath);
          await deps.provider.fastGet(file.remotePath, file.localPath, deps.config.transfer);
          return file.localPath;
        },
      );
      return batchResult(
        "download_many",
        files,
        results,
        (file) => `${file.remotePath} → ${file.localPath}`,
      );
    }),
  };
}
