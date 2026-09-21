import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig } from "./config.js";
import { errorMessage } from "./errors.js";
import { createServer } from "./server.js";
import { Ssh2SftpProvider } from "./sftp-connection.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const provider = new Ssh2SftpProvider(config);
  const server = createServer({ provider, config });
  const stop = (): void => {
    provider.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await server.connect(new StdioServerTransport());
  void provider.warm().catch((error: unknown) => {
    console.error(
      `[sftp-mcp] warm-connect failed (will retry on first call): ${errorMessage(error)}`,
    );
  });
  console.error(
    `[sftp-mcp] ready → ${config.username}@${config.host}:${config.port}${
      config.allowedWritePrefix === undefined
        ? ""
        : ` (writes limited to ${config.allowedWritePrefix})`
    }`,
  );
}

void main().catch((error: unknown) => {
  console.error(`[sftp-mcp] startup failed: ${errorMessage(error)}`);
  process.exitCode = 1;
});
