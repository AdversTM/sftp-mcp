import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { PathGuardConfig } from "../src/paths.js";
import { createToolRegistry } from "../src/server.js";
import type { ToolRegistry } from "../src/server.js";
import type {
  FileHash,
  SftpDirectoryEntry,
  SftpProvider,
  SftpStats,
  TransferOptions,
} from "../src/sftp-types.js";

function singleServer(provider: SftpProvider, policy: Partial<PathGuardConfig>): ToolRegistry {
  return createToolRegistry({ servers: [{ id: "main", provider, policy }], config: {} });
}

class FakeSftpProvider implements SftpProvider {
  readonly calls: string[] = [];

  async readdir(remotePath: string): Promise<readonly SftpDirectoryEntry[]> {
    this.calls.push(`readdir:${remotePath}`);
    return [];
  }

  async rename(fromPath: string, toPath: string): Promise<void> {
    this.calls.push(`rename:${fromPath}:${toPath}`);
  }

  async readFile(remotePath: string): Promise<Buffer | string> {
    this.calls.push(`readFile:${remotePath}`);
    return "";
  }

  async writeFile(remotePath: string, contents: Buffer): Promise<void> {
    this.calls.push(`writeFile:${remotePath}:${contents.length}`);
  }

  async unlink(remotePath: string): Promise<void> {
    this.calls.push(`unlink:${remotePath}`);
  }

  async mkdir(remotePath: string): Promise<void> {
    this.calls.push(`mkdir:${remotePath}`);
  }

  async rmdir(remotePath: string): Promise<void> {
    this.calls.push(`rmdir:${remotePath}`);
  }

  async stat(remotePath: string): Promise<SftpStats> {
    this.calls.push(`stat:${remotePath}`);
    return {};
  }

  async lstat(remotePath: string): Promise<SftpStats> {
    this.calls.push(`lstat:${remotePath}`);
    return {};
  }

  async fastPut(localPath: string, remotePath: string, options: TransferOptions): Promise<void> {
    this.calls.push(`fastPut:${localPath}:${remotePath}:${options.chunkSize}`);
  }

  async fastGet(remotePath: string, localPath: string, options: TransferOptions): Promise<void> {
    this.calls.push(`fastGet:${remotePath}:${localPath}:${options.chunkSize}`);
  }

  async sha256(remotePath: string, options: TransferOptions): Promise<FileHash> {
    this.calls.push(`sha256:${remotePath}:${options.chunkSize}`);
    return { digest: "ab".repeat(32), method: "remote" };
  }
}

describe("tool authorization", () => {
  it("denies write before SFTP call in read-only mode", async () => {
    // Given
    const provider = new FakeSftpProvider();
    const tools = singleServer(provider, { readOnly: true });

    // When
    const result = await tools.invoke("sftp_write", {
      server: "main",
      remotePath: "/site/a.txt",
      content: "x",
    });

    // Then
    expect(result.isError).toBe(true);
    expect(provider.calls).toEqual([]);
  });

  it("denies destructive tools before provider calls when destructive actions are disabled", async () => {
    // Given
    const provider = new FakeSftpProvider();
    const tools = singleServer(provider, { destructiveActionsAllowed: false });

    // When
    const results = await Promise.all([
      tools.invoke("sftp_delete", { server: "main", remotePath: "/site/a.txt" }),
      tools.invoke("sftp_delete_many", { server: "main", remotePaths: ["/site/a.txt"] }),
      tools.invoke("sftp_rmdir", { server: "main", remotePath: "/site", recursive: false }),
      tools.invoke("sftp_rmdir", { server: "main", remotePath: "/site", recursive: true }),
      tools.invoke("sftp_rename", {
        server: "main",
        fromPath: "/site/a.txt",
        toPath: "/site/b.txt",
      }),
      tools.invoke("sftp_sync_dir", { server: "main", localDir: "/missing", remoteDir: "/site" }),
    ]);

    // Then
    expect(results.every((result) => result.isError)).toBe(true);
    expect(results[5]?.content[0].text).toContain("SFTP_ALLOW_DESTRUCTIVE=false");
    expect(provider.calls).toEqual([]);
  });

  it("allows ordinary writes when destructive actions are disabled", async () => {
    // Given
    const provider = new FakeSftpProvider();
    const tools = singleServer(provider, { destructiveActionsAllowed: false });

    // When
    const result = await tools.invoke("sftp_write", {
      server: "main",
      remotePath: "/site/a.txt",
      content: "x",
    });

    // Then
    expect(result.isError).toBeUndefined();
    expect(provider.calls).toEqual(["writeFile:/site/a.txt:1"]);
  });

  it("allows dry-run sync when destructive actions are disabled", async () => {
    // Given
    const provider = new FakeSftpProvider();
    const localDir = mkdtempSync(path.join(tmpdir(), "sftp-mcp-test-"));
    writeFileSync(path.join(localDir, "file.txt"), "content");
    const tools = singleServer(provider, { destructiveActionsAllowed: false });

    // When
    const result = await tools.invoke("sftp_sync_dir", {
      server: "main",
      localDir,
      remoteDir: "/site",
      dryRun: true,
    });

    // Then
    expect(result.isError).toBeUndefined();
    expect(provider.calls).toEqual(["stat:/site/file.txt"]);
  });

  it("guards every remote read tool path before SFTP calls", async () => {
    // Given
    const provider = new FakeSftpProvider();
    const tools = singleServer(provider, { allowedReadPrefix: "/public" });

    // When
    const results = await Promise.all([
      tools.invoke("sftp_list", { server: "main", remotePath: "/private" }),
      tools.invoke("sftp_read", { server: "main", remotePath: "/private/a" }),
      tools.invoke("sftp_download", {
        server: "main",
        remotePath: "/private/a",
        localPath: "/tmp/a",
      }),
      tools.invoke("sftp_stat", { server: "main", remotePath: "/private/a" }),
      tools.invoke("sftp_exists", { server: "main", remotePath: "/private/a" }),
      tools.invoke("sftp_sha256", { server: "main", remotePath: "/private/a" }),
      tools.invoke("sftp_download_many", {
        server: "main",
        files: [{ remotePath: "/private/a", localPath: "/tmp/a" }],
      }),
    ]);

    // Then
    expect(results.every((result) => result.isError)).toBe(true);
    expect(provider.calls).toEqual([]);
  });

  it("requires both rename paths inside write prefix", async () => {
    // Given
    const provider = new FakeSftpProvider();
    const tools = singleServer(provider, { allowedWritePrefix: "/deploy" });

    // When
    const result = await tools.invoke("sftp_rename", {
      server: "main",
      fromPath: "/other/source.txt",
      toPath: "/deploy/destination.txt",
    });

    // Then
    expect(result.isError).toBe(true);
    expect(provider.calls).toEqual([]);
  });

  it("guards dry sync traversal with read prefix", async () => {
    // Given
    const provider = new FakeSftpProvider();
    const localDir = mkdtempSync(path.join(tmpdir(), "sftp-mcp-test-"));
    writeFileSync(path.join(localDir, "file.txt"), "content");
    const tools = singleServer(provider, {
      allowedWritePrefix: "/deploy",
      allowedReadPrefix: "/public",
    });

    // When
    const result = await tools.invoke("sftp_sync_dir", {
      server: "main",
      localDir,
      remoteDir: "/deploy",
      dryRun: true,
    });

    // Then
    expect(result.isError).toBe(true);
    expect(provider.calls).toEqual([]);
  });
});

describe("sftp_sha256", () => {
  it("returns digest in sha256sum format with the method used", async () => {
    // Given
    const provider = new FakeSftpProvider();
    const tools = singleServer(provider, {});

    // When
    const result = await tools.invoke("sftp_sha256", { server: "main", remotePath: "/a/../b.txt" });

    // Then
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe(
      `${"ab".repeat(32)}  /b.txt\n(computed on server via sha256sum)`,
    );
    expect(provider.calls).toEqual(["sha256:/b.txt:32768"]);
  });
});

describe("multi-server routing", () => {
  it("routes each call to the selected server with that server's policy", async () => {
    // Given
    const prod = new FakeSftpProvider();
    const staging = new FakeSftpProvider();
    const tools = createToolRegistry({
      servers: [
        { id: "prod", provider: prod, policy: { readOnly: true } },
        { id: "staging", provider: staging },
      ],
      config: {},
    });

    // When
    const prodWrite = await tools.invoke("sftp_write", {
      server: "prod",
      remotePath: "/a.txt",
      content: "x",
    });
    const stagingWrite = await tools.invoke("sftp_write", {
      server: "staging",
      remotePath: "/a.txt",
      content: "x",
    });
    await tools.invoke("sftp_list", { server: "prod", remotePath: "/" });

    // Then
    expect(prodWrite.isError).toBe(true);
    expect(stagingWrite.isError).toBeUndefined();
    expect(prod.calls).toEqual(["readdir:/"]);
    expect(staging.calls).toEqual(["writeFile:/a.txt:1"]);
  });

  it("rejects missing or unknown server ids before provider calls", async () => {
    // Given
    const provider = new FakeSftpProvider();
    const tools = singleServer(provider, {});

    // When
    const missing = await tools.invoke("sftp_list", { remotePath: "/" });
    const unknown = await tools.invoke("sftp_list", { server: "nope", remotePath: "/" });

    // Then
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain("server is required (available: main)");
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toContain("unknown server: 'nope' (available: main)");
    expect(provider.calls).toEqual([]);
  });

  it("lists configured servers with connection label, policy, and description", async () => {
    // Given
    const tools = createToolRegistry({
      servers: [
        {
          id: "prod",
          provider: new FakeSftpProvider(),
          policy: { readOnly: true, allowedReadPrefix: "/public" },
          label: "prod.example.test:22",
          description: "Production web",
        },
        {
          id: "staging",
          provider: new FakeSftpProvider(),
          policy: { destructiveActionsAllowed: false, allowedWritePrefix: "/www" },
          label: "staging.example.test:2222",
        },
      ],
      config: {},
    });

    // When
    const result = await tools.invoke("sftp_list_servers", {});

    // Then
    expect(result.content[0].text).toBe(
      [
        "servers (2)",
        "prod: prod.example.test:22 [read-only; read prefix /public] — Production web",
        "staging: staging.example.test:2222 [non-destructive; write prefix /www]",
      ].join("\n"),
    );
  });
});
