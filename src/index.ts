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
  const sink = createLogSink(readEnv("SFTP_LOG_FILE"));
  logDiagnostic = createEntrypointLogger(sink);
  const config = loadConfig(process.env);
  const servers = config.servers.map((serverConfig) => ({
    id: serverConfig.id,
    provider: new Ssh2SftpProvider(serverConfig),
    policy: serverConfig,
    label: `${serverConfig.username}@${serverConfig.host}:${serverConfig.port}`,
    ...(serverConfig.description === undefined ? {} : { description: serverConfig.description }),
  }));
  const server = createServer({ servers, config });
  const stop = (): void => {
    for (const entry of servers) {
      entry.provider.close();
    }
    sink?.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await server.connect(new StdioServerTransport());
  for (const entry of servers) {
    void entry.provider.warm().catch((error: unknown) => {
      logDiagnostic(
        `[sftp-mcp] warm-connect to '${entry.id}' failed (will retry on first call): ${errorMessage(error)}`,
      );
    });
  }
  logDiagnostic(
    `[sftp-mcp] ready → ${servers
      .map(
        (entry) =>
          `${entry.id} (${entry.label}${
            entry.policy.allowedWritePrefix === undefined
              ? ""
              : `, writes limited to ${entry.policy.allowedWritePrefix}`
          })`,
      )
      .join(", ")}`,
  );
}

void main().catch((error: unknown) => {
  logDiagnostic(`[sftp-mcp] startup failed: ${errorMessage(error)}`);
  process.exitCode = 1;
});
