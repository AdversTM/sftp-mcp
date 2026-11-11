#!/usr/bin/env node
// End-to-end smoke test: drives a built server over MCP stdio against a real SFTP host.
//
// Usage: node scripts/smoke-test.mjs <command> [args...]
// The SFTP connection comes from the usual SFTP_* environment variables.
// SMOKE_REMOTE_DIR (default "/upload") must be writable by the configured account.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const [command, ...args] = process.argv.slice(2);
if (command === undefined) {
  console.error("usage: node scripts/smoke-test.mjs <command> [args...]");
  process.exit(2);
}

const remoteDir = process.env.SMOKE_REMOTE_DIR ?? "/upload";
const remoteFile = `${remoteDir}/smoke-${Date.now()}.txt`;
const content = "hello from sftp-mcp smoke test\n";

const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
const pending = new Map();
let nextId = 1;

createInterface({ input: child.stdout }).on("line", (line) => {
  const message = JSON.parse(line);
  pending.get(message.id)?.(message);
  pending.delete(message.id);
});

function request(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 30_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
}

async function call(name, input) {
  const { result, error } = await request("tools/call", {
    name,
    arguments: { server: "default", ...input },
  });
  const text = result?.content?.[0]?.text ?? JSON.stringify(error);
  if (error !== undefined || result?.isError === true) {
    throw new Error(`${name} failed: ${text}`);
  }
  console.log(`ok  ${name}: ${text.split("\n")[0]}`);
  return text;
}

try {
  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "0" },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const { result } = await request("tools/list", {});
  console.log(`ok  tools/list: ${result.tools.length} tools`);

  await call("sftp_write", { remotePath: remoteFile, content });
  const read = await call("sftp_read", { remotePath: remoteFile });
  if (!read.includes(content.trim())) {
    throw new Error(`sftp_read returned unexpected content: ${read}`);
  }
  await call("sftp_sha256", { remotePath: remoteFile });
  await call("sftp_list", { remotePath: remoteDir });
  await call("sftp_delete", { remotePath: remoteFile });
  console.log("smoke test passed");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  child.kill();
}
