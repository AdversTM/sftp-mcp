import { closeSync, openSync, writeSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { ConfigError, errorMessage } from "./errors.js";

export type LogSink = {
  readonly write: (line: string) => void;
  readonly close: () => void;
};

export type LogFileWriter = (fd: number, data: string) => void;

const writeToFile: LogFileWriter = (fd, data) => {
  writeSync(fd, data);
};

export function resolveLogFilePath(
  rawValue: string | undefined,
  cwd: string = process.cwd(),
): string | undefined {
  const trimmed = rawValue?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return undefined;
  }
  return isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
}

export function openLogSink(path: string, writeLine: LogFileWriter = writeToFile): LogSink {
  let fd: number;
  try {
    fd = openSync(path, "a");
  } catch (error) {
    throw new ConfigError(`SFTP_LOG_FILE is unusable at '${path}': ${errorMessage(error)}`);
  }

  let active = true;

  const notifyFailure = (error: unknown): void => {
    active = false;
    process.stderr.write(
      `[sftp-mcp] log file sink failed, continuing with stderr only: ${errorMessage(error)}\n`,
    );
  };

  return {
    write(line: string): void {
      if (!active) {
        return;
      }
      try {
        writeLine(fd, `${line}\n`);
      } catch (error) {
        notifyFailure(error);
      }
    },
    close(): void {
      if (!active) {
        return;
      }
      active = false;
      closeSync(fd);
    },
  };
}

export function createLogSink(
  rawValue: string | undefined,
  cwd: string = process.cwd(),
): LogSink | undefined {
  const path = resolveLogFilePath(rawValue, cwd);
  return path === undefined ? undefined : openLogSink(path);
}
