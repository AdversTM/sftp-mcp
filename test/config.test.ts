import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("parses strict read-only and normalized independent prefixes", () => {
    // Given
    const env = {
      SFTP_HOST: "example.test",
      SFTP_USER: "deploy",
      SFTP_READ_ONLY: "true",
      SFTP_ALLOWED_WRITE_PREFIX: "/writes/../deploy/",
      SFTP_ALLOWED_READ_PREFIX: "/reads/./public/",
    };

    // When
    const config = loadConfig(env);

    // Then
    expect(config.servers).toHaveLength(1);
    expect(config.servers[0]).toMatchObject({
      id: "default",
      host: "example.test",
      username: "deploy",
      port: 22,
      readOnly: true,
      allowedWritePrefix: "/deploy",
      allowedReadPrefix: "/reads/public",
    });
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
    expect(defaultConfig.servers[0]?.destructiveActionsAllowed).toBe(true);
    expect(disabledConfig.servers[0]?.destructiveActionsAllowed).toBe(false);
    expect(enabledConfig.servers[0]?.destructiveActionsAllowed).toBe(true);
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

  it("parses disabled tools with whitespace trimmed and duplicates removed", () => {
    // Given
    const env = {
      SFTP_HOST: "example.test",
      SFTP_USER: "deploy",
      SFTP_DISABLED_TOOLS: " sftp_upload, sftp_sync_dir ,sftp_upload ",
    };

    // When
    const config = loadConfig(env);

    // Then
    expect(config.disabledTools).toEqual(["sftp_upload", "sftp_sync_dir"]);
  });

  it.each([undefined, "   "])("returns no disabled tools when value is %s", (value) => {
    // Given
    const env = { SFTP_HOST: "example.test", SFTP_USER: "deploy", SFTP_DISABLED_TOOLS: value };

    // When
    const config = loadConfig(env);

    // Then
    expect(config.disabledTools).toEqual([]);
  });

  it("rejects unknown disabled tool names", () => {
    // Given
    const env = {
      SFTP_HOST: "example.test",
      SFTP_USER: "deploy",
      SFTP_DISABLED_TOOLS: "sftp_upload,sftp_unknown",
    };

    // When
    const load = (): void => {
      loadConfig(env);
    };

    // Then
    expect(load).toThrow(ConfigError);
    expect(load).toThrow("sftp_unknown");
  });

  it("rejects empty disabled tool entries", () => {
    // Given
    const env = {
      SFTP_HOST: "example.test",
      SFTP_USER: "deploy",
      SFTP_DISABLED_TOOLS: "sftp_upload,,sftp_sync_dir",
    };

    // When
    const load = (): void => {
      loadConfig(env);
    };

    // Then
    expect(load).toThrow(ConfigError);
    expect(load).toThrow("<empty>");
  });
});

describe("loadConfig with a server map", () => {
  const servers = {
    prod: {
      host: "prod.example.test",
      username: "deploy",
      allowedWritePrefix: "/var/www/",
      description: "Production",
    },
    staging: { host: "staging.example.test", port: 2222, user: "ci", readOnly: false },
  };

  it("parses SFTP_SERVERS into ordered servers with global env defaults", () => {
    // Given
    const env = {
      SFTP_SERVERS: JSON.stringify(servers),
      SFTP_READ_ONLY: "true",
      SFTP_READY_TIMEOUT: "5000",
    };

    // When
    const config = loadConfig(env);

    // Then
    expect(config.servers).toEqual([
      {
        id: "prod",
        host: "prod.example.test",
        port: 22,
        username: "deploy",
        readyTimeout: 5000,
        readOnly: true,
        destructiveActionsAllowed: true,
        allowedWritePrefix: "/var/www",
        description: "Production",
      },
      {
        id: "staging",
        host: "staging.example.test",
        port: 2222,
        username: "ci",
        readyTimeout: 5000,
        readOnly: false,
        destructiveActionsAllowed: true,
      },
    ]);
  });

  it("reads the server map from SFTP_SERVERS_FILE", () => {
    // Given
    const file = path.join(mkdtempSync(path.join(tmpdir(), "sftp-mcp-config-")), "servers.json");
    writeFileSync(file, `\uFEFF${JSON.stringify(servers)}`);

    // When
    const config = loadConfig({ SFTP_SERVERS_FILE: file });

    // Then
    expect(config.servers.map((server) => server.id)).toEqual(["prod", "staging"]);
  });

  it.each([
    [{}, "no SFTP server configured: set SFTP_SERVERS, SFTP_SERVERS_FILE, or SFTP_HOST"],
    [{ SFTP_SERVERS: "{", SFTP_SERVERS_FILE: "x.json" }, "cannot both be set"],
    [{ SFTP_SERVERS: JSON.stringify(servers), SFTP_HOST: "x" }, "SFTP_HOST cannot be combined"],
    [{ SFTP_SERVERS: "{" }, "SFTP_SERVERS is not valid JSON"],
    [{ SFTP_SERVERS: "{}" }, "must define at least one server"],
    [{ SFTP_SERVERS: '{"a b":{"host":"h","username":"u"}}' }, "server id must match"],
    [{ SFTP_SERVERS: '{"a":{"host":"h","usr":"u"}}' }, "SFTP_SERVERS.a"],
    [{ SFTP_SERVERS: '{"a":{"host":"h"}}' }, "SFTP_SERVERS.a.username is required"],
    [{ SFTP_SERVERS: '{"a":{"host":"h","username":"u","port":70000}}' }, "SFTP_SERVERS.a.port"],
    [
      { SFTP_SERVERS: '{"a":{"host":"h","username":"u","allowedReadPrefix":"rel"}}' },
      "SFTP_SERVERS.a.allowedReadPrefix must be an absolute POSIX path",
    ],
    [{ SFTP_SERVERS_FILE: path.join(tmpdir(), "missing-sftp-servers.json") }, "SFTP_SERVERS_FILE"],
  ])("rejects invalid server map config %#", (env, message) => {
    // Given
    const load = (): void => {
      loadConfig(env);
    };

    // When / Then
    expect(load).toThrow(ConfigError);
    expect(load).toThrow(message);
  });
});
