import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createToolRegistry } from "../src/server.js";
import type {
  SftpDirectoryEntry,
  SftpProvider,
  SftpStats,
  TransferOptions,
} from "../src/sftp-types.js";

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
}

describe("tool authorization", () => {
  it("denies write before SFTP call in read-only mode", async () => {
    // Given
    const provider = new FakeSftpProvider();
    const tools = createToolRegistry({ provider, config: { readOnly: true } });

    // When
    const result = await tools.invoke("sftp_write", { remotePath: "/site/a.txt", content: "x" });

    // Then
    expect(result.isError).toBe(true);
    expect(provider.calls).toEqual([]);
  });

  it("denies destructive tools before provider calls when destructive actions are disabled", async () => {
    // Given
    const provider = new FakeSftpProvider();
    const tools = createToolRegistry({ provider, config: { destructiveActionsAllowed: false } });

    // When
    const results = await Promise.all([
      tools.invoke("sftp_delete", { remotePath: "/site/a.txt" }),
      tools.invoke("sftp_delete_many", { remotePaths: ["/site/a.txt"] }),
      tools.invoke("sftp_rmdir", { remotePath: "/site", recursive: false }),
      tools.invoke("sftp_rmdir", { remotePath: "/site", recursive: true }),
      tools.invoke("sftp_rename", { fromPath: "/site/a.txt", toPath: "/site/b.txt" }),
      tools.invoke("sftp_sync_dir", { localDir: "/missing", remoteDir: "/site" }),
    ]);

    // Then
    expect(results.every((result) => result.isError)).toBe(true);
    expect(results[5]?.content[0].text).toContain("SFTP_ALLOW_DESTRUCTIVE=false");
    expect(provider.calls).toEqual([]);
  });

  it("allows ordinary writes when destructive actions are disabled", async () => {
    // Given
    const provider = new FakeSftpProvider();
    const tools = createToolRegistry({ provider, config: { destructiveActionsAllowed: false } });

    // When
    const result = await tools.invoke("sftp_write", { remotePath: "/site/a.txt", content: "x" });

    // Then
    expect(result.isError).toBeUndefined();
    expect(provider.calls).toEqual(["writeFile:/site/a.txt:1"]);
  });

  it("allows dry-run sync when destructive actions are disabled", async () => {
    // Given
    const provider = new FakeSftpProvider();
    const localDir = mkdtempSync(path.join(tmpdir(), "sftp-mcp-test-"));
    writeFileSync(path.join(localDir, "file.txt"), "content");
    const tools = createToolRegistry({ provider, config: { destructiveActionsAllowed: false } });

    // When
    const result = await tools.invoke("sftp_sync_dir", {
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
    const tools = createToolRegistry({ provider, config: { allowedReadPrefix: "/public" } });

    // When
    const results = await Promise.all([
      tools.invoke("sftp_list", { remotePath: "/private" }),
      tools.invoke("sftp_read", { remotePath: "/private/a" }),
      tools.invoke("sftp_download", { remotePath: "/private/a", localPath: "/tmp/a" }),
      tools.invoke("sftp_stat", { remotePath: "/private/a" }),
      tools.invoke("sftp_exists", { remotePath: "/private/a" }),
      tools.invoke("sftp_download_many", {
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
    const tools = createToolRegistry({ provider, config: { allowedWritePrefix: "/deploy" } });

    // When
    const result = await tools.invoke("sftp_rename", {
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
    const tools = createToolRegistry({
      provider,
      config: { allowedWritePrefix: "/deploy", allowedReadPrefix: "/public" },
    });

    // When
    const result = await tools.invoke("sftp_sync_dir", {
      localDir,
      remoteDir: "/deploy",
      dryRun: true,
    });

    // Then
    expect(result.isError).toBe(true);
    expect(provider.calls).toEqual([]);
  });
});
