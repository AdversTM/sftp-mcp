import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { createServer } from "../src/server.js";
import type { SftpProvider } from "../src/sftp-types.js";

const provider: SftpProvider = {
  async readdir() {
    return [];
  },
  async readFile() {
    return "";
  },
  async writeFile() {},
  async unlink() {},
  async mkdir() {},
  async rmdir() {},
  async rename() {},
  async stat() {
    return {};
  },
  async lstat() {
    return {};
  },
  async fastPut() {},
  async fastGet() {},
};

describe("MCP tool registration", () => {
  it("omits disabled tools from the client-visible tool list", async () => {
    // Given
    const server = createServer({
      provider,
      config: { disabledTools: ["sftp_upload", "sftp_sync_dir"] },
    });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    // When
    const response = await client.listTools();

    // Then
    expect(response.tools.map((tool) => tool.name)).toEqual([
      "sftp_list",
      "sftp_read",
      "sftp_write",
      "sftp_delete",
      "sftp_mkdir",
      "sftp_rmdir",
      "sftp_rename",
      "sftp_download",
      "sftp_stat",
      "sftp_exists",
      "sftp_write_many",
      "sftp_delete_many",
      "sftp_upload_many",
      "sftp_download_many",
    ]);
    await client.close();
    await server.close();
  });
});
