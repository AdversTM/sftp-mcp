import { mkdirSync, readdirSync, statSync } from "node:fs";
import path, { posix } from "node:path";

import { errorMessage, SftpOperationError } from "./errors.js";
import type { PathGuards } from "./paths.js";
import type { SftpDirectoryEntry, SftpProvider, SftpStats } from "./sftp-types.js";

const modeMask = 0o170000;
const directoryMode = 0o040000;
const symlinkMode = 0o120000;

export type RemoteFileType = "d" | "l" | "-";

export type LocalFile = {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly size: number;
  readonly modifiedAt: number;
};

export function typeFromMode(mode: number | undefined): RemoteFileType {
  const type = (mode ?? 0) & modeMask;
  if (type === directoryMode) {
    return "d";
  }
  return type === symlinkMode ? "l" : "-";
}

export function isNotFound(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    (error instanceof Error && "code" in error && error.code === 2) ||
    /no such file|does not exist|ENOENT/i.test(message)
  );
}

export async function ensureRemoteDirectory(
  provider: SftpProvider,
  guards: PathGuards,
  remoteDirectory: string,
): Promise<void> {
  const directory = guards.guardWrite(remoteDirectory);
  try {
    const stats = await provider.stat(directory);
    if (typeFromMode(stats.mode) !== "d") {
      throw new SftpOperationError(`${directory} exists and is not a directory`);
    }
    return;
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
  const parent = posix.dirname(directory);
  if (parent !== "/" && parent !== directory) {
    await ensureRemoteDirectory(provider, guards, parent);
  }
  try {
    await provider.mkdir(directory);
  } catch (error) {
    try {
      const stats = await provider.stat(directory);
      if (typeFromMode(stats.mode) === "d") {
        return;
      }
    } catch (statError) {
      if (!isNotFound(statError)) {
        throw statError;
      }
    }
    throw error;
  }
}

export async function removeRemoteDirectory(
  provider: SftpProvider,
  guards: PathGuards,
  remoteDirectory: string,
): Promise<void> {
  const directory = guards.guardWrite(remoteDirectory);
  const entries = await provider.readdir(directory);
  for (const entry of entries) {
    const child = guards.guardWrite(posix.join(directory, entry.filename));
    if (typeFromMode(entry.attrs.mode) === "d") {
      await removeRemoteDirectory(provider, guards, child);
    } else {
      await provider.unlink(child);
    }
  }
  await provider.rmdir(directory);
}

export async function walkRemote(
  provider: SftpProvider,
  guards: PathGuards,
  remoteDirectory: string,
): Promise<readonly string[]> {
  const directory = guards.guardRead(remoteDirectory);
  let entries: readonly SftpDirectoryEntry[];
  try {
    entries = await provider.readdir(directory);
  } catch (error) {
    if (isNotFound(error)) {
      return [];
    }
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const child = guards.guardRead(posix.join(directory, entry.filename));
    if (typeFromMode(entry.attrs.mode) === "d") {
      files.push(...(await walkRemote(provider, guards, child)));
    } else {
      files.push(child);
    }
  }
  return files;
}

export function walkLocal(root: string): readonly LocalFile[] {
  const files: LocalFile[] = [];
  const visit = (directory: string, relativeDirectory: string): void => {
    for (const name of readdirSync(directory)) {
      const absolutePath = path.join(directory, name);
      const stats = statSync(absolutePath);
      const relativePath = relativeDirectory.length === 0 ? name : `${relativeDirectory}/${name}`;
      if (stats.isDirectory()) {
        visit(absolutePath, relativePath);
      } else if (stats.isFile()) {
        files.push({ relativePath, absolutePath, size: stats.size, modifiedAt: stats.mtimeMs });
      }
    }
  };
  visit(root, "");
  return files;
}

export function ensureLocalParent(localPath: string): void {
  mkdirSync(path.dirname(localPath), { recursive: true });
}

export function formatDirectoryEntry(entry: {
  readonly name: string;
  readonly type: RemoteFileType;
  readonly size: number | undefined;
  readonly modifyTime: number;
}): string {
  const kind = entry.type === "d" ? "dir " : entry.type === "l" ? "link" : "file";
  const modified =
    entry.modifyTime === 0
      ? ""
      : new Date(entry.modifyTime).toISOString().slice(0, 16).replace("T", " ");
  return `${kind} ${String(entry.size ?? "").padStart(9)}  ${modified}  ${entry.name}`;
}

export function statOutput(remotePath: string, stats: SftpStats): string {
  return JSON.stringify(
    {
      path: remotePath,
      type: typeFromMode(stats.mode),
      size: stats.size,
      mode: `0${((stats.mode ?? 0) & 0o7777).toString(8)}`,
      uid: stats.uid,
      gid: stats.gid,
      atime: stats.atime === undefined ? null : new Date(stats.atime * 1000).toISOString(),
      mtime: stats.mtime === undefined ? null : new Date(stats.mtime * 1000).toISOString(),
    },
    null,
    2,
  );
}
