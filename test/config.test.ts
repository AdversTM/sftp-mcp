import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("parses strict read-only and normalized independent prefixes", () => {
    // Given
    const env = {
      SFTP_HOST: "example.test",
      SFTP_USER: "deploy",
      SFTP_READ_ONLY: "true",
      SFTP_ALLOWED_PREFIX: "/writes/../deploy/",
      SFTP_ALLOWED_READ_PREFIX: "/reads/./public/",
    };

    // When
    const config = loadConfig(env);

    // Then
    expect(config.readOnly).toBe(true);
    expect(config.allowedWritePrefix).toBe("/deploy");
    expect(config.allowedReadPrefix).toBe("/reads/public");
  });

  it("rejects malformed numeric config", () => {
    // Given
    const env = { SFTP_HOST: "example.test", SFTP_USER: "deploy", SFTP_PORT: "NaN" };

    // When
    const load = (): void => {
      loadConfig(env);
    };

    // Then
    expect(load).toThrow(ConfigError);
  });

  it("defaults destructive actions to allowed and parses exact boolean overrides", () => {
    // Given
    const base = { SFTP_HOST: "example.test", SFTP_USER: "deploy" };

    // When
    const defaultConfig = loadConfig(base);
    const disabledConfig = loadConfig({ ...base, SFTP_ALLOW_DESTRUCTIVE: "false" });
    const enabledConfig = loadConfig({ ...base, SFTP_ALLOW_DESTRUCTIVE: "true" });

    // Then
    expect(defaultConfig.destructiveActionsAllowed).toBe(true);
    expect(disabledConfig.destructiveActionsAllowed).toBe(false);
    expect(enabledConfig.destructiveActionsAllowed).toBe(true);
  });

  it("rejects malformed destructive-actions config", () => {
    // Given
    const env = {
      SFTP_HOST: "example.test",
      SFTP_USER: "deploy",
      SFTP_ALLOW_DESTRUCTIVE: "FALSE",
    };

    // When
    const load = (): void => {
      loadConfig(env);
    };

    // Then
    expect(load).toThrow("SFTP_ALLOW_DESTRUCTIVE must be exactly true or false");
  });
});
