import type { McpResult } from "./mcp-results.js";
import type { PathGuards } from "./paths.js";
import type { SftpProvider, TransferOptions } from "./sftp-types.js";

export type ToolConfig = {
  readonly maxReadBytes: number;
  readonly maxConcurrency: number;
  readonly transfer: TransferOptions;
};

export type ToolDependencies = {
  readonly provider: SftpProvider;
  readonly guards: PathGuards;
  readonly config: ToolConfig;
};

export type ToolHandler = (input: unknown) => Promise<McpResult>;
