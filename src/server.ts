import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { SftpConfig } from "./config.js";
import type { McpResult } from "./mcp-results.js";
import { fail } from "./mcp-results.js";
import { createPathGuards } from "./paths.js";
import type { SftpProvider } from "./sftp-types.js";
import { toolNames } from "./tool-catalog.js";
import type { ToolName } from "./tool-catalog.js";
import type { ToolConfig, ToolHandler } from "./tool-types.js";
import { createBatchTools } from "./tools-batch.js";
import { createReadTools } from "./tools-read.js";
import { createWriteTools } from "./tools-write.js";

export type { ToolName } from "./tool-catalog.js";

export const toolDescriptions = {
  sftp_list: "List a remote directory (read-only). Returns type/size/mtime/name per entry.",
  sftp_read: "Read a remote text file (read-only). Refuses files larger than SFTP_MAX_READ_BYTES.",
  sftp_write: "Write/overwrite a remote text file from inline content.",
  sftp_delete: "Delete a remote file.",
  sftp_mkdir: "Create a remote directory.",
  sftp_rmdir: "Remove a remote directory.",
  sftp_rename: "Rename or move a remote file/directory (destination is guarded).",
  sftp_upload: "Upload a local file to the remote host (for binary/large files).",
  sftp_download: "Download a remote file to a local path (read-only).",
  sftp_stat: "Stat a remote path (read-only).",
  sftp_exists: "Check whether a remote path exists (read-only). Returns false | 'd' | '-' | 'l'.",
  sftp_write_many:
    "Write many remote text files in parallel on one connection. Much faster than N sequential writes across a high-latency link.",
  sftp_delete_many: "Delete many remote files in parallel on one connection.",
  sftp_upload_many: "Upload many local files in parallel on one connection.",
  sftp_download_many: "Download many remote files in parallel on one connection.",
  sftp_sync_dir:
    "Sync a local directory to a remote directory: upload files that are missing, size-different, or newer (parallel). Optionally delete remote files not present locally. Use dryRun to preview.",
} satisfies Record<ToolName, string>;

export type ServerOptions = {
  readonly provider: SftpProvider;
  readonly config: Partial<
    Pick<
      SftpConfig,
      | "readOnly"
      | "destructiveActionsAllowed"
      | "allowedReadPrefix"
      | "allowedWritePrefix"
      | "disabledTools"
    >
  > &
    Partial<ToolConfig>;
};

export type ToolRegistry = {
  readonly invoke: (name: ToolName, input: unknown) => Promise<McpResult>;
  readonly handlers: Readonly<Record<string, ToolHandler>>;
};

function toolConfig(config: ServerOptions["config"]): ToolConfig {
  return {
    maxReadBytes: config.maxReadBytes ?? 1024 * 1024,
    maxConcurrency: config.maxConcurrency ?? 8,
    transfer: config.transfer ?? { concurrency: 64, chunkSize: 32768 },
  };
}

export function createToolRegistry(options: ServerOptions): ToolRegistry {
  const dependencies = {
    provider: options.provider,
    guards: createPathGuards(options.config),
    config: toolConfig(options.config),
  };
  const handlers = {
    ...createReadTools(dependencies),
    ...createWriteTools(dependencies),
    ...createBatchTools(dependencies),
  };
  return {
    handlers,
    async invoke(name: ToolName, input: unknown) {
      const handler = handlers[name];
      return handler === undefined ? fail(`unknown tool: ${name}`) : handler(input);
    },
  };
}

const schemas: Readonly<Record<ToolName, z.ZodObject<z.ZodRawShape>>> = {
  sftp_list: z.object({ remotePath: z.string() }),
  sftp_read: z.object({ remotePath: z.string() }),
  sftp_write: z.object({
    remotePath: z.string(),
    content: z.string(),
    createDirs: z.boolean().optional(),
  }),
  sftp_delete: z.object({ remotePath: z.string() }),
  sftp_mkdir: z.object({ remotePath: z.string(), recursive: z.boolean().optional() }),
  sftp_rmdir: z.object({ remotePath: z.string(), recursive: z.boolean().optional() }),
  sftp_rename: z.object({ fromPath: z.string(), toPath: z.string() }),
  sftp_upload: z.object({
    localPath: z.string(),
    remotePath: z.string(),
    createDirs: z.boolean().optional(),
  }),
  sftp_download: z.object({ remotePath: z.string(), localPath: z.string() }),
  sftp_stat: z.object({ remotePath: z.string() }),
  sftp_exists: z.object({ remotePath: z.string() }),
  sftp_write_many: z.object({
    files: z.array(z.object({ remotePath: z.string(), content: z.string() })).min(1),
    createDirs: z.boolean().optional(),
    concurrency: z.number().int().positive().optional(),
  }),
  sftp_delete_many: z.object({
    remotePaths: z.array(z.string()).min(1),
    concurrency: z.number().int().positive().optional(),
  }),
  sftp_upload_many: z.object({
    files: z.array(z.object({ localPath: z.string(), remotePath: z.string() })).min(1),
    createDirs: z.boolean().optional(),
    concurrency: z.number().int().positive().optional(),
  }),
  sftp_download_many: z.object({
    files: z.array(z.object({ remotePath: z.string(), localPath: z.string() })).min(1),
    concurrency: z.number().int().positive().optional(),
  }),
  sftp_sync_dir: z.object({
    localDir: z.string(),
    remoteDir: z.string(),
    delete: z.boolean().optional(),
    dryRun: z.boolean().optional(),
    concurrency: z.number().int().positive().optional(),
  }),
};

export function createServer(options: ServerOptions): McpServer {
  const server = new McpServer({ name: "mcp-server-sftp", version: "1.1.0" });
  const registry = createToolRegistry(options);
  for (const name of toolNames) {
    if (options.config.disabledTools?.includes(name) === true) {
      continue;
    }
    registerTool(server, registry, name, schemas[name]);
  }
  return server;
}

function registerTool<Shape extends z.ZodRawShape>(
  server: McpServer,
  registry: ToolRegistry,
  name: ToolName,
  inputSchema: z.ZodObject<Shape>,
): void {
  server.registerTool(name, { description: toolDescriptions[name], inputSchema }, async (input) =>
    registry.invoke(name, input),
  );
}
