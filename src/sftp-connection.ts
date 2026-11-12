import { createHash } from "node:crypto";
import type { SFTPWrapper } from "ssh2";
import { Client } from "ssh2";

import type { SftpServerConfig } from "./config.js";
import { errorMessage, SftpOperationError } from "./errors.js";
import type {
  FileHash,
  SftpDirectoryEntry,
  SftpProvider,
  SftpStats,
  TransferOptions,
} from "./sftp-types.js";

type SharedConnection = {
  readonly client: Client;
  readonly sftp: SFTPWrapper;
};

const connectionErrorPattern =
  /(ECONNRESET|ETIMEDOUT|EPIPE|ECONNREFUSED|not connected|no sftp connection|connection (closed|lost|reset|ended)|handshake|channel|no response|timed out|socket|closed)/i;

// Paths passed to a remote shell are limited to characters that are inert in POSIX sh
// single quotes and in Windows cmd (no quotes, &, |, ;, $, %, !, backticks, redirects).
const shellSafePathPattern = /^\/[A-Za-z0-9._/ +@,=:~-]*$/;
const sha256sumOutputPattern = /^([0-9a-f]{64})\s/;
const commandNotFoundExitCode = 127;

type ChunkResult = { readonly data: Buffer } | { readonly error: unknown };

export class Ssh2SftpProvider implements SftpProvider {
  #shared: SharedConnection | undefined;
  #connecting: Promise<SharedConnection> | undefined;
  #remoteHashUnavailable = false;

  constructor(private readonly config: SftpServerConfig) {}

  async readdir(remotePath: string): Promise<readonly SftpDirectoryEntry[]> {
    return this.withSftp(
      (sftp) =>
        new Promise<readonly SftpDirectoryEntry[]>((resolve, reject) => {
          sftp.readdir(remotePath, (error, entries) => {
            if (error !== undefined) {
              reject(error);
              return;
            }
            resolve(entries.map((entry) => ({ filename: entry.filename, attrs: entry.attrs })));
          });
        }),
    );
  }

  async readFile(remotePath: string): Promise<Buffer | string> {
    return this.withSftp(
      (sftp) =>
        new Promise<Buffer | string>((resolve, reject) => {
          sftp.readFile(remotePath, (error, contents) => {
            if (error !== undefined) {
              reject(error);
              return;
            }
            resolve(contents);
          });
        }),
    );
  }

  async writeFile(remotePath: string, contents: Buffer): Promise<void> {
    return this.withSftp((sftp) =>
      this.noResult((done) => sftp.writeFile(remotePath, contents, done)),
    );
  }

  async unlink(remotePath: string): Promise<void> {
    return this.withSftp((sftp) => this.noResult((done) => sftp.unlink(remotePath, done)));
  }

  async mkdir(remotePath: string): Promise<void> {
    return this.withSftp((sftp) => this.noResult((done) => sftp.mkdir(remotePath, done)));
  }

  async rmdir(remotePath: string): Promise<void> {
    return this.withSftp((sftp) => this.noResult((done) => sftp.rmdir(remotePath, done)));
  }

  async rename(fromPath: string, toPath: string): Promise<void> {
    return this.withSftp((sftp) => this.noResult((done) => sftp.rename(fromPath, toPath, done)));
  }

  async stat(remotePath: string): Promise<SftpStats> {
    return this.withSftp((sftp) => this.statResult((done) => sftp.stat(remotePath, done)));
  }

  async lstat(remotePath: string): Promise<SftpStats> {
    return this.withSftp((sftp) => this.statResult((done) => sftp.lstat(remotePath, done)));
  }

  async fastPut(localPath: string, remotePath: string, options: TransferOptions): Promise<void> {
    return this.withSftp((sftp) =>
      this.noResult((done) =>
        sftp.fastPut(
          localPath,
          remotePath,
          { concurrency: options.concurrency, chunkSize: options.chunkSize },
          done,
        ),
      ),
    );
  }

  async fastGet(remotePath: string, localPath: string, options: TransferOptions): Promise<void> {
    return this.withSftp((sftp) =>
      this.noResult((done) =>
        sftp.fastGet(
          remotePath,
          localPath,
          { concurrency: options.concurrency, chunkSize: options.chunkSize },
          done,
        ),
      ),
    );
  }

  async sha256(remotePath: string, options: TransferOptions): Promise<FileHash> {
    if (!this.#remoteHashUnavailable && shellSafePathPattern.test(remotePath)) {
      const digest = await this.remoteSha256(remotePath);
      if (digest !== undefined) {
        return { digest, method: "remote" };
      }
    }
    const digest = await this.withSftp((sftp) => this.streamSha256(sftp, remotePath, options));
    return { digest, method: "stream" };
  }

  async warm(): Promise<void> {
    await this.getConnection();
  }

  close(): void {
    const shared = this.#shared;
    this.#shared = undefined;
    this.#connecting = undefined;
    shared?.client.end();
  }

  private noResult(
    invoke: (done: (error: Error | null | undefined) => void) => void,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      invoke((error) => {
        if (error === undefined || error === null) {
          resolve();
          return;
        }
        reject(error);
      });
    });
  }

  private statResult(
    invoke: (done: (error: Error | null | undefined, stats: SftpStats) => void) => void,
  ): Promise<SftpStats> {
    return new Promise<SftpStats>((resolve, reject) => {
      invoke((error, stats) => {
        if (error === undefined || error === null) {
          resolve(stats);
          return;
        }
        reject(error);
      });
    });
  }

  private async remoteSha256(remotePath: string): Promise<string | undefined> {
    const { client } = await this.getConnection();
    return new Promise<string | undefined>((resolve) => {
      client.exec(`sha256sum -- '${remotePath}'`, (error, channel) => {
        if (error !== undefined) {
          this.#remoteHashUnavailable = true;
          resolve(undefined);
          return;
        }
        let stdout = "";
        let exitCode: number | null = null;
        channel.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        channel.stderr.resume();
        channel.on("exit", (code: number | null) => {
          exitCode = code;
        });
        channel.on("close", () => {
          if (exitCode === commandNotFoundExitCode) {
            this.#remoteHashUnavailable = true;
          }
          const digest = exitCode === 0 ? sha256sumOutputPattern.exec(stdout)?.[1] : undefined;
          resolve(digest);
        });
      });
    });
  }

  private async streamSha256(
    sftp: SFTPWrapper,
    remotePath: string,
    options: TransferOptions,
  ): Promise<string> {
    const handle = await new Promise<Buffer>((resolve, reject) => {
      sftp.open(remotePath, "r", (error, opened) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve(opened);
      });
    });
    try {
      const size = (await this.statResult((done) => sftp.fstat(handle, done))).size ?? 0;
      const chunkCount = Math.ceil(size / options.chunkSize);
      const hash = createHash("sha256");
      const inFlight = new Map<number, Promise<ChunkResult>>();
      let issued = 0;
      for (let index = 0; index < chunkCount; index += 1) {
        while (issued < chunkCount && inFlight.size < options.concurrency) {
          const position = issued * options.chunkSize;
          const length = Math.min(options.chunkSize, size - position);
          inFlight.set(
            issued,
            this.readChunk(sftp, handle, position, length).then(
              (data) => ({ data }),
              (error: unknown) => ({ error }),
            ),
          );
          issued += 1;
        }
        const result = await inFlight.get(index);
        inFlight.delete(index);
        if (result === undefined) {
          throw new SftpOperationError(`chunk ${index} was never requested`);
        }
        if ("error" in result) {
          throw result.error;
        }
        hash.update(result.data);
      }
      return hash.digest("hex");
    } finally {
      sftp.close(handle, () => undefined);
    }
  }

  private async readChunk(
    sftp: SFTPWrapper,
    handle: Buffer,
    position: number,
    length: number,
  ): Promise<Buffer> {
    const buffer = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const bytesRead = await new Promise<number>((resolve, reject) => {
        sftp.read(handle, buffer, filled, length - filled, position + filled, (error, count) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          resolve(count);
        });
      });
      if (bytesRead === 0) {
        break;
      }
      filled += bytesRead;
    }
    return buffer.subarray(0, filled);
  }

  private async withSftp<T>(operation: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
    try {
      return await operation((await this.getConnection()).sftp);
    } catch (error) {
      if (!connectionErrorPattern.test(errorMessage(error))) {
        throw error;
      }
      this.close();
      return operation((await this.getConnection()).sftp);
    }
  }

  private async getConnection(): Promise<SharedConnection> {
    if (this.#shared !== undefined) {
      return this.#shared;
    }
    if (this.#connecting === undefined) {
      this.#connecting = this.connectRaw().then(
        (shared) => {
          this.#shared = shared;
          this.#connecting = undefined;
          const drop = (): void => {
            if (this.#shared === shared) {
              this.#shared = undefined;
            }
          };
          shared.client.on("close", drop);
          shared.client.on("error", drop);
          shared.sftp.on("close", drop);
          return shared;
        },
        (error: unknown) => {
          this.#connecting = undefined;
          throw error;
        },
      );
    }
    return this.#connecting;
  }

  private connectRaw(): Promise<SharedConnection> {
    return new Promise<SharedConnection>((resolve, reject) => {
      const client = new Client();
      let settled = false;
      client.on("ready", () => {
        client.sftp((error, sftp) => {
          if (error !== undefined) {
            settled = true;
            client.end();
            reject(new SftpOperationError("unable to open SFTP channel", { cause: error }));
            return;
          }
          settled = true;
          resolve({ client, sftp });
        });
      });
      client.on("error", (error) => {
        if (!settled) {
          settled = true;
          reject(new SftpOperationError("SFTP connection failed", { cause: error }));
        }
      });
      const connection = {
        host: this.config.host,
        port: this.config.port,
        username: this.config.username,
        readyTimeout: this.config.readyTimeout,
        keepaliveInterval: 10000,
        keepaliveCountMax: 6,
        ...(this.config.password === undefined ? {} : { password: this.config.password }),
        ...(this.config.privateKey === undefined ? {} : { privateKey: this.config.privateKey }),
        ...(this.config.passphrase === undefined ? {} : { passphrase: this.config.passphrase }),
      };
      client.connect(connection);
    });
  }
}
