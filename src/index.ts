import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig } from "./config.js";
import { createEntrypointLogger } from "./entrypoint-logger.js";
import { errorMessage } from "./errors.js";
import { createLogSink } from "./log-sink.js";
import { createServer } from "./server.js";
import { Ssh2SftpProvider } from "./sftp-connection.js";

let logDiagnostic = createEntrypointLogger(undefined);

function readEnv(name: string): string | undefined {
  // Bracket access avoids TypeScript's noPropertyAccessFromIndexSignature on
  // NodeJS.ProcessEnv while keeping the key itself out of Biome's literal-key lint.
  return process.env[name];
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const sink = createLogSink(readEnv("SFTP_LOG_FILE"));
  logDiagnostic = createEntrypointLogger(sink);
  const provider = new Ssh2SftpProvider(config);
  const server = createServer({ provider, config });
  const stop = (): void => {
    provider.close();
    sink?.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await server.connect(new StdioServerTransport());
  void provider.warm().catch((error: unknown) => {
    logDiagnostic(
      `[sftp-mcp] warm-connect failed (will retry on first call): ${errorMessage(error)}`,
    );
  });
  logDiagnostic(
    `[sftp-mcp] ready → ${config.username}@${config.host}:${config.port}${
      config.allowedWritePrefix === undefined
        ? ""
        : ` (writes limited to ${config.allowedWritePrefix})`
    }`,
  );
}

void main().catch((error: unknown) => {
  logDiagnostic(`[sftp-mcp] startup failed: ${errorMessage(error)}`);
  process.exitCode = 1;
});
