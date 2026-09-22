import { afterEach, describe, expect, it, vi } from "vitest";

import { createEntrypointLogger } from "../src/entrypoint-logger.js";
import type { LogSink } from "../src/log-sink.js";

describe("createEntrypointLogger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes every message to stderr and the sink, never to stdout", () => {
    // Given
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const written: string[] = [];
    const sink: LogSink = {
      write: (line) => {
        written.push(line);
      },
      close: () => undefined,
    };
    const log = createEntrypointLogger(sink);

    // When
    log("[sftp-mcp] ready -> deploy on sftp-host:22");

    // Then
    expect(errorSpy).toHaveBeenCalledWith("[sftp-mcp] ready -> deploy on sftp-host:22");
    expect(written).toEqual(["[sftp-mcp] ready -> deploy on sftp-host:22"]);
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it("writes to stderr only when no sink is configured", () => {
    // Given
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = createEntrypointLogger(undefined);

    // When
    log("[sftp-mcp] warm-connect failed (will retry on first call): boom");

    // Then
    expect(errorSpy).toHaveBeenCalledWith(
      "[sftp-mcp] warm-connect failed (will retry on first call): boom",
    );
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it("preserves call order across multiple lines", () => {
    // Given
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const written: string[] = [];
    const sink: LogSink = {
      write: (line) => {
        written.push(line);
      },
      close: () => undefined,
    };
    const log = createEntrypointLogger(sink);

    // When
    log("first");
    log("second");
    log("third");

    // Then
    expect(written).toEqual(["first", "second", "third"]);
  });
});
