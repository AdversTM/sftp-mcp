export type SftpStats = {
  readonly mode?: number;
  readonly size?: number;
  readonly uid?: number;
  readonly gid?: number;
  readonly atime?: number;
  readonly mtime?: number;
};

export type SftpDirectoryEntry = {
  readonly filename: string;
  readonly attrs: SftpStats;
};

export type TransferOptions = {
  readonly concurrency: number;
  readonly chunkSize: number;
};

export interface SftpProvider {
  readdir(remotePath: string): Promise<readonly SftpDirectoryEntry[]>;
  readFile(remotePath: string): Promise<Buffer | string>;
  writeFile(remotePath: string, contents: Buffer): Promise<void>;
  unlink(remotePath: string): Promise<void>;
  mkdir(remotePath: string): Promise<void>;
  rmdir(remotePath: string): Promise<void>;
  rename(fromPath: string, toPath: string): Promise<void>;
  stat(remotePath: string): Promise<SftpStats>;
  lstat(remotePath: string): Promise<SftpStats>;
  fastPut(localPath: string, remotePath: string, options: TransferOptions): Promise<void>;
  fastGet(remotePath: string, localPath: string, options: TransferOptions): Promise<void>;
}
