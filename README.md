<div align="center">

# sftp-mcp

**SFTP for AI assistants. Files only, no shell.**

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets Claude and other MCP clients
browse, edit, transfer and sync files over plain SFTP. It works on chrooted, SFTP-only and shared-hosting
accounts where SSH-based servers can't run, and the assistant never gets a shell.

[![CI](https://github.com/AdversTM/sftp-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/AdversTM/sftp-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/sftp-mcp?logo=npm)](https://www.npmjs.com/package/sftp-mcp)
[![Node.js](https://img.shields.io/node/v/sftp-mcp?logo=nodedotjs)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[Install](#installation) · [Configure](#configuration) · [Tools](#tools) · [Security](#access-control) · [Contribute](#development)

</div>

---

## Why sftp-mcp?

Most MCP servers for remote machines are SSH servers that can also move files. They need a shell account and
give the assistant command execution. sftp-mcp does the opposite: it only speaks the SFTP protocol.

|                                                      | **sftp-mcp** | Typical SSH MCP server |
| ---------------------------------------------------- | ------------ | ---------------------- |
| Works with SFTP-only and chrooted accounts           | **Yes**      | Usually needs a shell  |
| Assistant can run arbitrary commands                 | **No**       | Yes                    |
| Read-only, no-delete and path limits per server      | **Built in** | Varies                 |
| Many hosts from one process                          | **Yes**      | Varies                 |
| Parallel transfers over one warm connection per host | **Yes**      | Varies                 |
| Directory sync that uploads only changed files       | **Yes**      | Varies                 |

The only remote command it ever sends is a fixed `sha256sum` for hashing. If the account has no shell, it hashes over SFTP instead.

Pick sftp-mcp when the assistant should work with **files**: deploying a site, editing configs, pulling logs or syncing a build.
Pick an SSH server when it needs to **run commands**.

## Installation

Requires Node.js 24 or newer. Most MCP clients can start the server straight from npm, with nothing to install:

```sh
npx -y sftp-mcp
```

Or install it globally and use the `sftp-mcp` command:

```sh
npm install -g sftp-mcp
```

## Quick start

Add the server to your MCP client. For **Claude Desktop**, edit `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sftp": {
      "command": "npx",
      "args": ["-y", "sftp-mcp"],
      "env": {
        "SFTP_HOST": "sftp.example.com",
        "SFTP_USER": "deploy",
        "SFTP_PRIVATE_KEY": "/home/me/.ssh/id_ed25519"
      }
    }
  }
}
```

On Windows, `npx` may need to go through `cmd`: `"command": "cmd", "args": ["/c", "npx", "-y", "sftp-mcp"]`.

For **Claude Code**:

```sh
claude mcp add sftp -e SFTP_HOST=sftp.example.com -e SFTP_USER=deploy \
  -e SFTP_PRIVATE_KEY=$HOME/.ssh/id_ed25519 -- npx -y sftp-mcp
```

Restart the client and ask it something like _"list /var/www on the sftp server"_.

## Configuration

All configuration comes from environment variables. Invalid values stop the server at startup with a clear error, so a typo never quietly loosens a policy.

### Single server

| Variable           | Default  | Description                    |
| ------------------ | -------- | ------------------------------ |
| `SFTP_HOST`        | required | SSH host                       |
| `SFTP_PORT`        | `22`     | SSH port                       |
| `SFTP_USER`        | required | SSH username                   |
| `SFTP_PASSWORD`    |          | Password authentication        |
| `SFTP_PRIVATE_KEY` |          | Path to a private key file     |
| `SFTP_PASSPHRASE`  |          | Passphrase for the private key |

The server is registered with the id `default`.

### Multiple servers

Describe the servers as a JSON map of id to connection. Pass it inline in `SFTP_SERVERS`, or as a file path in `SFTP_SERVERS_FILE`. You can't set both.

```json
{
  "prod": {
    "host": "prod.example.com",
    "username": "deploy",
    "privateKey": "/home/me/.ssh/id_ed25519",
    "allowedWritePrefix": "/var/www",
    "allowDestructive": false,
    "description": "Production web"
  },
  "staging": {
    "host": "staging.example.com",
    "port": 2222,
    "username": "ci",
    "password": "secret"
  }
}
```

| Field                                          | Description                                              |
| ---------------------------------------------- | -------------------------------------------------------- |
| `host`, `username` (alias `user`)              | Required                                                 |
| `port`                                         | Defaults to `22`                                         |
| `password`, `privateKey`, `passphrase`         | Credentials. `privateKey` is a local file path           |
| `readOnly`, `allowDestructive`, `readyTimeout` | Per-server overrides of the global settings below        |
| `allowedReadPrefix`, `allowedWritePrefix`      | Path restrictions, see [Access control](#access-control) |
| `description`                                  | Shown to the assistant in `sftp_list_servers`            |

Ids must match `[A-Za-z0-9][A-Za-z0-9_.-]*`. Unknown fields stop startup. The single-server variables can't be combined with a server map.

### Global settings

| Variable                    | Default   | Description                                                                           |
| --------------------------- | --------- | ------------------------------------------------------------------------------------- |
| `SFTP_READ_ONLY`            | `false`   | Deny every remote mutation                                                            |
| `SFTP_ALLOW_DESTRUCTIVE`    | `true`    | `false` denies delete, rmdir, rename and non-dry-run sync                             |
| `SFTP_ALLOWED_WRITE_PREFIX` |           | Absolute path prefix for mutations (single-server mode)                               |
| `SFTP_ALLOWED_READ_PREFIX`  |           | Absolute path prefix for reads (single-server mode)                                   |
| `SFTP_DISABLED_TOOLS`       |           | Comma-separated tool names to hide from the client                                    |
| `SFTP_READY_TIMEOUT`        | `20000`   | SSH handshake timeout, in ms                                                          |
| `SFTP_MAX_READ_BYTES`       | `1048576` | Size limit for `sftp_read`. Larger files must use `sftp_download`                     |
| `SFTP_MAX_CONCURRENCY`      | `8`       | Default parallelism of the batch tools                                                |
| `SFTP_TRANSFER_CONCURRENCY` | `64`      | In-flight requests per file transfer                                                  |
| `SFTP_CHUNK_SIZE`           | `32768`   | Transfer chunk size in bytes (minimum 1024)                                           |
| `SFTP_LOG_FILE`             |           | Also append logs to this file, for clients that hide stderr. Its directory must exist |

Booleans must be exactly `true` or `false`.

## Access control

Policies apply to each server separately and are checked **before** any SFTP request is sent.

| Policy                    | Effect                                                                                             |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| `readOnly: true`          | Blocks every mutation, including dry-run sync. Overrides everything else.                          |
| `allowDestructive: false` | Writes, uploads and mkdir still work. Delete, rmdir, rename/move and non-dry-run sync are blocked. |
| `allowedWritePrefix`      | Mutations only inside this path. Both ends of a rename are checked.                                |
| `allowedReadPrefix`       | Listing, reading, downloads, stat and hashing only inside this path.                               |

Prefixes are normalized and compared as POSIX paths: `/srv/app` allows `/srv/app` and `/srv/app/x`, but not `/srv/app-old`. A prefix of `/` allows everything.

> [!IMPORTANT]
> Prefix checks are lexical. A symlink on the server can still point outside the allowed prefix.
> For hard isolation, use a chroot, account permissions, or SFTP server configuration.

To hide tools from the assistant entirely, set `SFTP_DISABLED_TOOLS`, for example `sftp_delete,sftp_sync_dir`. Hidden tools are never registered, so they never appear in the client's tool list.

## Tools

Every tool except `sftp_list_servers` takes a `server` argument (one of the configured ids).

| Tool                 | Kind        | Description                                                                                             |
| -------------------- | ----------- | ------------------------------------------------------------------------------------------------------- |
| `sftp_list_servers`  | discovery   | Configured servers with their address, policy and description                                           |
| `sftp_list`          | read        | List a directory (type, size, mtime, name)                                                              |
| `sftp_read`          | read        | Read a text file, up to `SFTP_MAX_READ_BYTES`                                                           |
| `sftp_stat`          | read        | File metadata                                                                                           |
| `sftp_exists`        | read        | `false`, or the entry type: `d`, `-` or `l`                                                             |
| `sftp_sha256`        | read        | SHA-256 via `sha256sum` on the server, falling back to SFTP streaming                                   |
| `sftp_download`      | read        | Download a remote file to a local path                                                                  |
| `sftp_download_many` | read        | Parallel downloads                                                                                      |
| `sftp_write`         | write       | Create or overwrite a text file from inline content                                                     |
| `sftp_upload`        | write       | Upload a local file (binary-safe, parallel chunks)                                                      |
| `sftp_mkdir`         | write       | Create a directory, optionally recursive                                                                |
| `sftp_write_many`    | write       | Parallel text writes                                                                                    |
| `sftp_upload_many`   | write       | Parallel uploads                                                                                        |
| `sftp_sync_dir`      | write       | Upload missing, changed or newer files. Can also delete remote files missing locally. Supports `dryRun` |
| `sftp_delete`        | destructive | Delete a file                                                                                           |
| `sftp_rmdir`         | destructive | Remove a directory, optionally recursive                                                                |
| `sftp_rename`        | destructive | Rename or move                                                                                          |
| `sftp_delete_many`   | destructive | Parallel deletes                                                                                        |

Batch tools report each failure individually, so one bad file doesn't abort the batch.

---

## Development

Requires [Bun](https://bun.sh) 1.4+ for tooling. The published package runs on plain Node.js 24+.

```sh
git clone https://github.com/AdversTM/sftp-mcp.git
cd sftp-mcp
bun install

bun run test        # unit tests (vitest)
bun run typecheck   # strict TypeScript
bun run check       # Biome lint + format check (bun run format to fix)
bun run build       # compile to dist/ for Node.js
```

### Project layout

```text
src/
  index.ts            entry point: config, transport, lifecycle
  config.ts           env / JSON parsing and validation (zod)
  server.ts           MCP registration: tool descriptions + input schemas
  tool-catalog.ts     canonical list of tool names
  tools-read.ts       read-only tool handlers
  tools-write.ts      mutation tool handlers
  tools-batch.ts      parallel batch tools and directory sync
  paths.ts            path normalization and access-policy guards
  sftp-connection.ts  ssh2 provider: warm connection, retry, hashing
  sftp-operations.ts  shared helpers over the provider interface
test/                 vitest suites, using an in-memory SFTP provider
scripts/
  smoke-test.mjs      end-to-end check against a real SFTP server
```

### Adding a tool

1. Add the name to `toolNames` in [`src/tool-catalog.ts`](src/tool-catalog.ts).
2. Add a description and a zod input schema in [`src/server.ts`](src/server.ts). The compiler enforces both through `Record<ToolName, …>`.
3. Implement the handler in the matching `tools-*.ts` module. Before touching the provider, run every remote path through `deps.guards.guardRead`, `guardWrite` or `guardDestructive`.
4. Cover it in `test/tools.test.ts`.

### End-to-end smoke test

Run the server against a disposable SFTP container:

```sh
docker run -d --rm --name sftp -p 127.0.0.1:2222:22 atmoz/sftp "smoke:smoke:::upload"
SFTP_HOST=127.0.0.1 SFTP_PORT=2222 SFTP_USER=smoke SFTP_PASSWORD=smoke \
  node scripts/smoke-test.mjs node dist/index.js
```

### Contributing

Contributions are welcome. Please open an issue before starting large changes, and make sure `test`, `typecheck` and `check` pass.

## License

[MIT](LICENSE) © Damian Szuster
