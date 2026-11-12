import { statSync } from "node:fs";
import { posix } from "node:path";

import { z } from "zod";

import { SftpOperationError } from "./errors.js";
import { batchResult, mapLimit, ok, wrap } from "./mcp-results.js";
import { ensureRemoteDirectory, isNotFound, walkLocal, walkRemote } from "./sftp-operations.js";
import type { ToolDependencies, ToolHandler } from "./tool-types.js";

const writeManySchema = z.object({
  files: z.array(z.object({ remotePath: z.string(), content: z.string() })).min(1),
  createDirs: z.boolean().optional(),
  concurrency: z.int().positive().optional(),
});
const deleteManySchema = z.object({
  remotePaths: z.array(z.string()).min(1),
  concurrency: z.int().positive().optional(),
});
const uploadManySchema = z.object({
  files: z.array(z.object({ localPath: z.string(), remotePath: z.string() })).min(1),
  createDirs: z.boolean().optional(),
  concurrency: z.int().positive().optional(),
});
const syncSchema = z.object({
  localDir: z.string(),
  remoteDir: z.string(),
  delete: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  concurrency: z.int().positive().optional(),
});

export function createBatchTools(deps: ToolDependencies): Readonly<Record<string, ToolHandler>> {
  return {
    sftp_write_many: wrap(async (input) => {
      const { files, createDirs, concurrency } = writeManySchema.parse(input);
      const prepared = files.map((file) => ({
        ...file,
        remotePath: deps.guards.guardWrite(file.remotePath),
      }));
      const results = await mapLimit(
        prepared,
        concurrency ?? deps.config.maxConcurrency,
        async (file) => {
          if (createDirs === true) {
            await ensureRemoteDirectory(deps.provider, deps.guards, posix.dirname(file.remotePath));
          }
          await deps.provider.writeFile(file.remotePath, Buffer.from(file.content, "utf8"));
          return file.remotePath;
        },
      );
      return batchResult("write_many", files, results, (file) => file.remotePath);
    }),
    sftp_delete_many: wrap(async (input) => {
      const { remotePaths, concurrency } = deleteManySchema.parse(input);
      const paths = remotePaths.map((remotePath) => deps.guards.guardDestructive(remotePath));
      const results = await mapLimit(
        paths,
        concurrency ?? deps.config.maxConcurrency,
        async (remotePath) => {
          await deps.provider.unlink(remotePath);
          return remotePath;
        },
      );
      return batchResult("delete_many", remotePaths, results, (remotePath) => remotePath);
    }),
    sftp_upload_many: wrap(async (input) => {
      const { files, createDirs, concurrency } = uploadManySchema.parse(input);
      const prepared = files.map((file) => ({
        ...file,
        remotePath: deps.guards.guardWrite(file.remotePath),
      }));
      const results = await mapLimit(
        prepared,
        concurrency ?? deps.config.maxConcurrency,
        async (file) => {
          if (createDirs === true) {
            await ensureRemoteDirectory(deps.provider, deps.guards, posix.dirname(file.remotePath));
          }
          await deps.provider.fastPut(file.localPath, file.remotePath, deps.config.transfer);
          return file.remotePath;
        },
      );
      return batchResult(
        "upload_many",
        files,
        results,
        (file) => `${file.localPath} → ${file.remotePath}`,
      );
    }),
    sftp_sync_dir: wrap(async (input) => {
      const {
        localDir,
        remoteDir,
        delete: deleteRemote,
        dryRun,
        concurrency,
      } = syncSchema.parse(input);
      const base =
        dryRun === true
          ? deps.guards.guardWrite(remoteDir)
          : deps.guards.guardDestructive(remoteDir);
      const localStats = statSync(localDir);
      if (!localStats.isDirectory()) {
        throw new SftpOperationError(`localDir is not a directory: ${localDir}`);
      }
      const localFiles = walkLocal(localDir);
      const guardedLocalFiles = localFiles.map((file) => {
        const remotePath = deps.guards.guardWrite(posix.join(base, file.relativePath));
        return { file, remotePath: deps.guards.guardRead(remotePath) };
      });
      const limit = concurrency ?? deps.config.maxConcurrency;
      const decisions = await mapLimit(guardedLocalFiles, limit, async ({ file, remotePath }) => {
        try {
          const remoteStats = await deps.provider.stat(remotePath);
          const reason =
            remoteStats.size !== file.size
              ? "size"
              : file.modifiedAt / 1000 > (remoteStats.mtime ?? 0) + 2
                ? "newer"
                : undefined;
          return { file, remotePath, reason };
        } catch (error) {
          if (isNotFound(error)) {
            return { file, remotePath, reason: "missing" };
          }
          throw error;
        }
      });
      const uploads = decisions.flatMap((decision) =>
        decision.ok && decision.value.reason !== undefined ? [decision.value] : [],
      );
      const comparisonErrors = decisions.filter((decision) => !decision.ok);
      const skipped = decisions.filter(
        (decision) => decision.ok && decision.value.reason === undefined,
      ).length;
      const remoteFiles =
        deleteRemote === true ? await walkRemote(deps.provider, deps.guards, base) : [];
      const localRemotePaths = new Set(guardedLocalFiles.map((file) => file.remotePath));
      const deletions = remoteFiles.filter((remotePath) => !localRemotePaths.has(remotePath));
      if (dryRun === true) {
        const plan = [
          `sync_dir DRY RUN ${localDir} → ${base}`,
          `  upload: ${uploads.length}`,
          ...uploads
            .slice(0, 50)
            .map((upload) => `    + ${upload.file.relativePath} (${upload.reason})`),
          `  skip:   ${skipped}`,
          `  delete: ${deletions.length}${deleteRemote === true ? "" : " (delete disabled)"}`,
          ...deletions.slice(0, 50).map((deletion) => `    - ${deletion}`),
          ...(comparisonErrors.length === 0
            ? []
            : [`  compare errors: ${comparisonErrors.length}`]),
        ];
        return ok(plan.join("\n"));
      }
      const uploadResults = await mapLimit(uploads, limit, async (upload) => {
        await ensureRemoteDirectory(deps.provider, deps.guards, posix.dirname(upload.remotePath));
        await deps.provider.fastPut(
          upload.file.absolutePath,
          upload.remotePath,
          deps.config.transfer,
        );
        return upload.remotePath;
      });
      const deleteResults = await mapLimit(deletions, limit, async (remotePath) => {
        await deps.provider.unlink(deps.guards.guardWrite(remotePath));
        return remotePath;
      });
      const uploadSuccesses = uploadResults.filter((result) => result.ok).length;
      const deleteSuccesses = deleteResults.filter((result) => result.ok).length;
      const errorCount =
        comparisonErrors.length +
        uploadResults.filter((result) => !result.ok).length +
        deleteResults.filter((result) => !result.ok).length;
      const errorLines = [
        ...decisions.flatMap((result) => (result.ok ? [] : [`  compare FAIL: ${result.error}`])),
        ...uploadResults.flatMap((result, index) => {
          if (result.ok) {
            return [];
          }
          const upload = uploads[index];
          return upload === undefined
            ? [`  upload FAIL: ${result.error}`]
            : [`  upload FAIL ${upload.file.relativePath}: ${result.error}`];
        }),
        ...deleteResults.flatMap((result, index) => {
          if (result.ok) {
            return [];
          }
          const deletion = deletions[index];
          return [`  delete FAIL ${deletion ?? "unknown"}: ${result.error}`];
        }),
      ].slice(0, 50);
      const text = `sync_dir ${localDir} → ${base}: uploaded ${uploadSuccesses}, skipped ${skipped}, deleted ${deleteSuccesses}${
        errorCount === 0 ? "" : `, errors ${errorCount}`
      }${errorLines.length === 0 ? "" : `\n${errorLines.join("\n")}`}`;
      return errorCount === 0 ? ok(text) : { content: [{ type: "text", text }], isError: true };
    }),
  };
}
