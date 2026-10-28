import { readFileSync } from "node:fs";

import { z } from "zod";

import { AuthorizationError, ConfigError } from "./errors.js";
import { normalizeRemotePath } from "./paths.js";
import { isToolName } from "./tool-catalog.js";
import type { ToolName } from "./tool-catalog.js";

const envSchema = z.object({
  SFTP_SERVERS: z.string().optional(),
  SFTP_SERVERS_FILE: z.string().optional(),
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
  SFTP_DISABLED_TOOLS: z.string().optional(),
});

type Env = z.infer<typeof envSchema>;

const legacyServerVariables = [
  "SFTP_HOST",
  "SFTP_PORT",
  "SFTP_USER",
  "SFTP_PASSWORD",
  "SFTP_PRIVATE_KEY",
  "SFTP_PASSPHRASE",
  "SFTP_ALLOWED_WRITE_PREFIX",
  "SFTP_ALLOWED_READ_PREFIX",
] as const satisfies readonly (keyof Env)[];

export const legacyServerId = "default";

const serverIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

const serverEntrySchema = z
  .object({
    host: z.string().trim().min(1),
    port: z.number().int().min(1).max(65535).optional(),
    username: z.string().optional(),
    user: z.string().optional(),
    password: z.string().optional(),
    privateKey: z.string().optional(),
    passphrase: z.string().optional(),
    readyTimeout: z.number().int().positive().optional(),
    readOnly: z.boolean().optional(),
    allowDestructive: z.boolean().optional(),
    allowedWritePrefix: z.string().optional(),
    allowedReadPrefix: z.string().optional(),
    description: z.string().optional(),
  })
  .strict();

const serversSchema = z
  .record(
    z.string().regex(serverIdPattern, "server id must match [A-Za-z0-9][A-Za-z0-9_.-]*"),
    serverEntrySchema,
  )
  .refine((servers) => Object.keys(servers).length > 0, "must define at least one server");

export type SftpServerConfig = {
  readonly id: string;
  readonly description?: string;
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
};

export type SftpConfig = {
  readonly servers: readonly SftpServerConfig[];
  readonly maxReadBytes: number;
  readonly maxConcurrency: number;
  readonly disabledTools: readonly ToolName[];
  readonly transfer: {
    readonly concurrency: number;
    readonly chunkSize: number;
  };
};

type ServerDefaults = {
  readonly readyTimeout: number;
  readonly readOnly: boolean;
  readonly destructiveActionsAllowed: boolean;
};

type ServerFields = {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password?: string | undefined;
  readonly privateKeyPath?: string | undefined;
  readonly passphrase?: string | undefined;
  readonly readyTimeout: number;
  readonly readOnly: boolean;
  readonly destructiveActionsAllowed: boolean;
  readonly allowedWritePrefix?: string | undefined;
  readonly allowedReadPrefix?: string | undefined;
  readonly description?: string | undefined;
};

type FieldLabel = (field: "privateKey" | "allowedWritePrefix" | "allowedReadPrefix") => string;

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function required(value: string | undefined, name: string): string {
  const trimmed = nonBlank(value);
  if (trimmed === undefined) {
    throw new ConfigError(`${name} is required`);
  }
  return trimmed;
}

function optionalPrefix(value: string | undefined, name: string): string | undefined {
  const trimmed = nonBlank(value);
  if (trimmed === undefined) {
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

function readPrivateKey(path: string | undefined, name: string): Buffer | undefined {
  const trimmed = nonBlank(path);
  if (trimmed === undefined) {
    return undefined;
  }
  try {
    return readFileSync(trimmed);
  } catch (error) {
    if (error instanceof Error) {
      throw new ConfigError(`unable to read SFTP private key configured by ${name}`);
    }
    throw error;
  }
}

function readServersFile(path: string): string {
  try {
    return readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  } catch (error) {
    if (error instanceof Error) {
      throw new ConfigError(`unable to read SFTP_SERVERS_FILE '${path}'`);
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

function disabledTools(value: string | undefined): readonly ToolName[] {
  if (value === undefined || value.trim().length === 0) {
    return [];
  }
  const names: ToolName[] = [];
  for (const entry of value.split(",")) {
    const name = entry.trim();
    if (!isToolName(name)) {
      throw new ConfigError(`SFTP_DISABLED_TOOLS contains invalid tool name: ${name || "<empty>"}`);
    }
    if (!names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

function buildServer(id: string, fields: ServerFields, label: FieldLabel): SftpServerConfig {
  const privateKey = readPrivateKey(fields.privateKeyPath, label("privateKey"));
  const password = nonBlank(fields.password);
  const passphrase = nonBlank(fields.passphrase);
  const description = nonBlank(fields.description);
  const allowedWritePrefix = optionalPrefix(fields.allowedWritePrefix, label("allowedWritePrefix"));
  const allowedReadPrefix = optionalPrefix(fields.allowedReadPrefix, label("allowedReadPrefix"));
  return {
    id,
    host: fields.host,
    port: fields.port,
    username: fields.username,
    readyTimeout: fields.readyTimeout,
    readOnly: fields.readOnly,
    destructiveActionsAllowed: fields.destructiveActionsAllowed,
    ...(description === undefined ? {} : { description }),
    ...(password === undefined ? {} : { password }),
    ...(privateKey === undefined ? {} : { privateKey }),
    ...(privateKey === undefined || passphrase === undefined ? {} : { passphrase }),
    ...(allowedWritePrefix === undefined ? {} : { allowedWritePrefix }),
    ...(allowedReadPrefix === undefined ? {} : { allowedReadPrefix }),
  };
}

function legacyServer(env: Env, defaults: ServerDefaults): SftpServerConfig {
  const port = positiveInteger(env.SFTP_PORT, 22, "SFTP_PORT");
  if (port > 65535) {
    throw new ConfigError("SFTP_PORT must be <= 65535");
  }
  const variables = {
    privateKey: "SFTP_PRIVATE_KEY",
    allowedWritePrefix: "SFTP_ALLOWED_WRITE_PREFIX",
    allowedReadPrefix: "SFTP_ALLOWED_READ_PREFIX",
  } as const;
  return buildServer(
    legacyServerId,
    {
      ...defaults,
      host: required(env.SFTP_HOST, "SFTP_HOST"),
      port,
      username: required(env.SFTP_USER, "SFTP_USER"),
      password: env.SFTP_PASSWORD,
      privateKeyPath: env.SFTP_PRIVATE_KEY,
      passphrase: env.SFTP_PASSPHRASE,
      allowedWritePrefix: env.SFTP_ALLOWED_WRITE_PREFIX,
      allowedReadPrefix: env.SFTP_ALLOWED_READ_PREFIX,
    },
    (field) => variables[field],
  );
}

function mappedServers(
  json: string,
  source: string,
  defaults: ServerDefaults,
): readonly SftpServerConfig[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ConfigError(`${source} is not valid JSON`);
    }
    throw error;
  }
  const parsed = serversSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue === undefined || issue.path.length === 0 ? "" : `.${issue.path.join(".")}`;
    throw new ConfigError(`${source}${where}: ${issue?.message ?? "invalid server map"}`);
  }
  return Object.entries(parsed.data).map(([id, entry]) =>
    buildServer(
      id,
      {
        host: entry.host,
        port: entry.port ?? 22,
        username: required(entry.username ?? entry.user, `${source}.${id}.username`),
        password: entry.password,
        privateKeyPath: entry.privateKey,
        passphrase: entry.passphrase,
        readyTimeout: entry.readyTimeout ?? defaults.readyTimeout,
        readOnly: entry.readOnly ?? defaults.readOnly,
        destructiveActionsAllowed: entry.allowDestructive ?? defaults.destructiveActionsAllowed,
        allowedWritePrefix: entry.allowedWritePrefix,
        allowedReadPrefix: entry.allowedReadPrefix,
        description: entry.description,
      },
      (field) => `${source}.${id}.${field}`,
    ),
  );
}

function loadServers(env: Env, defaults: ServerDefaults): readonly SftpServerConfig[] {
  const inline = nonBlank(env.SFTP_SERVERS);
  const file = nonBlank(env.SFTP_SERVERS_FILE);
  if (inline === undefined && file === undefined) {
    if (nonBlank(env.SFTP_HOST) === undefined) {
      throw new ConfigError(
        "no SFTP server configured: set SFTP_SERVERS, SFTP_SERVERS_FILE, or SFTP_HOST and SFTP_USER",
      );
    }
    return [legacyServer(env, defaults)];
  }
  if (inline !== undefined && file !== undefined) {
    throw new ConfigError("SFTP_SERVERS and SFTP_SERVERS_FILE cannot both be set");
  }
  const conflicting = legacyServerVariables.find((name) => nonBlank(env[name]) !== undefined);
  if (conflicting !== undefined) {
    throw new ConfigError(
      `${conflicting} cannot be combined with SFTP_SERVERS/SFTP_SERVERS_FILE; configure it per server`,
    );
  }
  return inline === undefined
    ? mappedServers(readServersFile(file ?? ""), "SFTP_SERVERS_FILE", defaults)
    : mappedServers(inline, "SFTP_SERVERS", defaults);
}

export function loadConfig(environment: Record<string, string | undefined>): SftpConfig {
  const env = envSchema.parse(environment);
  const defaults = {
    readyTimeout: positiveInteger(env.SFTP_READY_TIMEOUT, 20000, "SFTP_READY_TIMEOUT"),
    readOnly: strictBoolean(env.SFTP_READ_ONLY, false, "SFTP_READ_ONLY"),
    destructiveActionsAllowed: strictBoolean(
      env.SFTP_ALLOW_DESTRUCTIVE,
      true,
      "SFTP_ALLOW_DESTRUCTIVE",
    ),
  };
  return {
    servers: loadServers(env, defaults),
    maxReadBytes: positiveInteger(env.SFTP_MAX_READ_BYTES, 1024 * 1024, "SFTP_MAX_READ_BYTES"),
    maxConcurrency: positiveInteger(env.SFTP_MAX_CONCURRENCY, 8, "SFTP_MAX_CONCURRENCY"),
    disabledTools: disabledTools(env.SFTP_DISABLED_TOOLS),
    transfer: {
      concurrency: positiveInteger(env.SFTP_TRANSFER_CONCURRENCY, 64, "SFTP_TRANSFER_CONCURRENCY"),
      chunkSize: positiveInteger(env.SFTP_CHUNK_SIZE, 32768, "SFTP_CHUNK_SIZE", 1024),
    },
  };
}

export { ConfigError } from "./errors.js";
