import { existsSync, mkdtempSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLogSink, openLogSink, resolveLogFilePath } from "../src/log-sink.js";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "sftp-mcp-log-sink-"));
}

describe("resolveLogFilePath", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([undefined, "", "   "])("returns undefined for blank value %j", (value) => {
    // Given
    const cwd = tempDir();

    // When
    const resolved = resolveLogFilePath(value, cwd);

    // Then
    expect(resolved).toBeUndefined();
  });

  it("resolves a relative path against the given cwd", () => {
    // Given
    const cwd = tempDir();

    // When
    const resolved = resolveLogFilePath("logs/diagnostic.log", cwd);

    // Then
    expect(resolved).toBe(path.resolve(cwd, "logs/diagnostic.log"));
  });

  it("keeps an absolute path unchanged", () => {
    // Given
    const cwd = tempDir();
    const absolute = path.join(tempDir(), "diagnostic.log");

    // When
    const resolved = resolveLogFilePath(absolute, cwd);

    // Then
    expect(resolved).toBe(absolute);
  });
});

describe("createLogSink", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns no sink when SFTP_LOG_FILE is blank", () => {
    // Given
    const cwd = tempDir();

    // When
    const sink = createLogSink("   ", cwd);

    // Then
    expect(sink).toBeUndefined();
  });

  it("returns no sink when SFTP_LOG_FILE is unset", () => {
    // Given
    const cwd = tempDir();

    // When
    const sink = createLogSink(undefined, cwd);

    // Then
    expect(sink).toBeUndefined();
  });
});

describe("openLogSink", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("appends ordered lines without touching stdout", () => {
    // Given
    const dir = tempDir();
    const logPath = path.join(dir, "diagnostic.log");
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const sink = openLogSink(logPath);

    // When
    sink.write("first");
    sink.write("second");
    sink.write("third");
    sink.close();

    // Then
    expect(readFileSync(logPath, "utf8")).toBe("first\nsecond\nthird\n");
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it("appends to existing file content instead of truncating", () => {
    // Given
    const dir = tempDir();
    const logPath = path.join(dir, "diagnostic.log");
    writeFileSync(logPath, "preexisting\n");
    const sink = openLogSink(logPath);

    // When
    sink.write("appended");
    sink.close();

    // Then
    expect(readFileSync(logPath, "utf8")).toBe("preexisting\nappended\n");
  });

  it("ignores writes after close", () => {
    // Given
    const dir = tempDir();
    const logPath = path.join(dir, "diagnostic.log");
    const sink = openLogSink(logPath);
    sink.write("first");

    // When
    sink.close();
    sink.write("second");

    // Then
    expect(readFileSync(logPath, "utf8")).toBe("first\n");
  });

  it("throws a clear error and does not create the missing parent directory", () => {
    // Given
    const dir = tempDir();
    const missingParent = path.join(dir, "missing-subdir");
    const logPath = path.join(missingParent, "diagnostic.log");

    // When
    const open = (): void => {
      openLogSink(logPath);
    };

    // Then
    expect(open).toThrow(/SFTP_LOG_FILE/);
    expect(open).toThrow(logPath);
    expect(existsSync(missingParent)).toBe(false);
  });

  it("degrades after a write failure: notifies stderr once and keeps stderr-only logging", () => {
    // Given
    const dir = tempDir();
    const logPath = path.join(dir, "diagnostic.log");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let callCount = 0;
    const failingWriter = (fd: number, data: string): void => {
      callCount += 1;
      if (callCount === 1) {
        writeSync(fd, data);
        return;
      }
      throw new Error("ENOSPC: no space left on device");
    };
    const sink = openLogSink(logPath, failingWriter);

    // When
    sink.write("first");
    sink.write("second");
    sink.write("third");

    // Then
    expect(readFileSync(logPath, "utf8")).toBe("first\n");
    expect(callCount).toBe(2);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const [notice] = stderrSpy.mock.calls[0] ?? [];
    expect(notice).toContain("log file sink failed");
  });
});
