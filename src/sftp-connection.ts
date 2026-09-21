import { Client } from "ssh2";
import type { SFTPWrapper } from "ssh2";

import type { SftpConfig } from "./config.js";
import { SftpOperationError, errorMessage } from "./errors.js";
import type { SftpDirectoryEntry, SftpProvider, SftpStats, TransferOptions } from "./sftp-types.js";

type SharedConnection = {
  readonly client: Client;
  readonly sftp: SFTPWrapper;
};

const connectionErrorPattern =
  /(ECONNRESET|ETIMEDOUT|EPIPE|ECONNREFUSED|not connected|no sftp connection|connection (closed|lost|reset|ended)|handshake|channel|no response|timed out|socket|closed)/i;

export class Ssh2SftpProvider implements SftpProvider {
  #shared: SharedConnection | undefined;
  #connecting: Promise<SharedConnection> | undefined;

  constructor(private readonly config: SftpConfig) {}

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
