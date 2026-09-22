import { readFileSync } from "node:fs";

import { z } from "zod";

import { AuthorizationError, ConfigError } from "./errors.js";
import { normalizeRemotePath } from "./paths.js";

const envSchema = z.object({
  SFTP_HOST: z.string().optional(),
  SFTP_PORT: z.string().optional(),
  SFTP_USER: z.string().optional(),
  SFTP_PASSWORD: z.string().optional(),
  SFTP_PRIVATE_KEY: z.string().optional(),
  SFTP_PASSPHRASE: z.string().optional(),
  SFTP_READ_ONLY: z.string().optional(),
  SFTP_ALLOW_DESTRUCTIVE: z.string().optional(),
  SFTP_ALLOWED_WRITE_PREFIX: z.string().optional(),
  SFTP_ALLOWED_READ_PREFIX: z.string().optional(),
  SFTP_MAX_READ_BYTES: z.string().optional(),
  SFTP_READY_TIMEOUT: z.string().optional(),
  SFTP_MAX_CONCURRENCY: z.string().optional(),
  SFTP_TRANSFER_CONCURRENCY: z.string().optional(),
  SFTP_CHUNK_SIZE: z.string().optional(),
});

export type SftpConfig = {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password?: string;
  readonly privateKey?: Buffer;
  readonly passphrase?: string;
  readonly readyTimeout: number;
  readonly readOnly: boolean;
  readonly destructiveActionsAllowed: boolean;
  readonly allowedWritePrefix?: string;
  readonly allowedReadPrefix?: string;
  readonly maxReadBytes: number;
  readonly maxConcurrency: number;
  readonly transfer: {
    readonly concurrency: number;
    readonly chunkSize: number;
  };
};

function required(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    throw new ConfigError(`${name} is required`);
  }
  return trimmed;
}

function optionalPrefix(value: string | undefined, name: string): string | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return undefined;
  }
  try {
    return normalizeRemotePath(trimmed);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      throw new ConfigError(`${name} must be an absolute POSIX path`);
    }
    throw error;
  }
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum = 1,
): number {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < minimum) {
    throw new ConfigError(`${name} must be a finite integer >= ${minimum}`);
  }
  return parsed;
}

function strictBoolean(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new ConfigError(`${name} must be exactly true or false`);
}

export function loadConfig(environment: Record<string, string | undefined>): SftpConfig {
  const env = envSchema.parse(environment);
  const privateKeyPath = env.SFTP_PRIVATE_KEY?.trim();
  let privateKey: Buffer | undefined;
  if (privateKeyPath !== undefined && privateKeyPath.length > 0) {
    try {
      privateKey = readFileSync(privateKeyPath);
    } catch (error) {
      if (error instanceof Error) {
        throw new ConfigError("unable to read configured SFTP private key");
      }
      throw error;
    }
  }
  const password = env.SFTP_PASSWORD?.trim();
  const passphrase = env.SFTP_PASSPHRASE?.trim();
  const config = {
    host: required(env.SFTP_HOST, "SFTP_HOST"),
    port: positiveInteger(env.SFTP_PORT, 22, "SFTP_PORT"),
    username: required(env.SFTP_USER, "SFTP_USER"),
    readyTimeout: positiveInteger(env.SFTP_READY_TIMEOUT, 20000, "SFTP_READY_TIMEOUT"),
    readOnly: strictBoolean(env.SFTP_READ_ONLY, false, "SFTP_READ_ONLY"),
    destructiveActionsAllowed: strictBoolean(
      env.SFTP_ALLOW_DESTRUCTIVE,
      true,
      "SFTP_ALLOW_DESTRUCTIVE",
    ),
    maxReadBytes: positiveInteger(env.SFTP_MAX_READ_BYTES, 1024 * 1024, "SFTP_MAX_READ_BYTES"),
    maxConcurrency: positiveInteger(env.SFTP_MAX_CONCURRENCY, 8, "SFTP_MAX_CONCURRENCY"),
    transfer: {
      concurrency: positiveInteger(env.SFTP_TRANSFER_CONCURRENCY, 64, "SFTP_TRANSFER_CONCURRENCY"),
      chunkSize: positiveInteger(env.SFTP_CHUNK_SIZE, 32768, "SFTP_CHUNK_SIZE", 1024),
    },
    ...(password === undefined || password.length === 0 ? {} : { password }),
    ...(privateKey === undefined ? {} : { privateKey }),
    ...(privateKey === undefined || passphrase === undefined || passphrase.length === 0
      ? {}
      : { passphrase }),
    ...(() => {
      const allowedWritePrefix = optionalPrefix(
        env.SFTP_ALLOWED_WRITE_PREFIX,
        "SFTP_ALLOWED_WRITE_PREFIX",
      );
      return allowedWritePrefix === undefined ? {} : { allowedWritePrefix };
    })(),
    ...(() => {
      const allowedReadPrefix = optionalPrefix(
        env.SFTP_ALLOWED_READ_PREFIX,
        "SFTP_ALLOWED_READ_PREFIX",
      );
      return allowedReadPrefix === undefined ? {} : { allowedReadPrefix };
    })(),
  } satisfies SftpConfig;
  if (config.port > 65535) {
    throw new ConfigError("SFTP_PORT must be <= 65535");
  }
  return config;
}

export { ConfigError } from "./errors.js";
