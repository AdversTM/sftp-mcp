export class ConfigError extends Error {
  readonly name = "ConfigError";
}

export class AuthorizationError extends Error {
  readonly name = "AuthorizationError";
}

export class SftpOperationError extends Error {
  readonly name = "SftpOperationError";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
