# SFTP MCP Server

Node ESM MCP server for SFTP accounts, including chrooted accounts limited to the SFTP subsystem. One server process can target many SFTP hosts: it keeps one warm SSH/SFTP channel per configured server and retries an operation once after a confirmed connection-level failure.

## Multiple Servers

Configure a JSON map of server id → connection data, either inline via `SFTP_SERVERS` or as a file via `SFTP_SERVERS_FILE` (not both):

```json
{
  "prod": {
    "host": "prod.example.test",
    "username": "deploy",
    "privateKey": "C:/Users/me/.ssh/id_ed25519",
    "allowedWritePrefix": "/var/www",
    "allowDestructive": false,
    "description": "Production web"
  },
  "staging": {
    "host": "staging.example.test",
    "port": 2222,
    "username": "ci",
    "password": "secret"
  }
}
```

Server ids must match `[A-Za-z0-9][A-Za-z0-9_.-]*`. Per-server fields: `host` and `username` (alias `user`) (required), `port` (default `22`), `password`, `privateKey` (local key-file path), `passphrase`, `readyTimeout`, `readOnly`, `allowDestructive`, `allowedWritePrefix`, `allowedReadPrefix`, `description`. Unknown fields fail startup. `readyTimeout`, `readOnly`, and `allowDestructive` default to `SFTP_READY_TIMEOUT`, `SFTP_READ_ONLY`, and `SFTP_ALLOW_DESTRUCTIVE`. The single-server variables (`SFTP_HOST`, `SFTP_PORT`, `SFTP_USER`, `SFTP_PASSWORD`, `SFTP_PRIVATE_KEY`, `SFTP_PASSPHRASE`, `SFTP_ALLOWED_*_PREFIX`) cannot be combined with a server map.

`sftp_list_servers` lists the configured ids with `user@host:port`, access policy, and description. Every other tool requires a `server` argument; its JSON schema is an enum of the configured ids.

Without `SFTP_SERVERS`/`SFTP_SERVERS_FILE`, the single-server variables below define one server with id `default`.

## Setup

```powershell
bun install
bun run build
$env:SFTP_HOST = "sftp.example.test"
$env:SFTP_USER = "deploy"
bun run start
```

Use `dist/index.js` as the stdio executable; it runs under Node. Package bin is `mcp-server-sftp`. The server writes operational messages to stderr and MCP protocol messages to stdout.

## Environment

| Variable                    | Default   | Meaning                                                                                                 |
|-----------------------------|-----------|---------------------------------------------------------------------------------------------------------|
| `SFTP_SERVERS`              | unset     | Inline JSON server map (see Multiple Servers)                                                           |
| `SFTP_SERVERS_FILE`         | unset     | Local path to a JSON server-map file                                                                    |
| `SFTP_HOST`                 | required  | SSH host (single-server mode only)                                                                      |
| `SFTP_PORT`                 | `22`      | SSH port, integer 1 through 65535                                                                       |
| `SFTP_USER`                 | required  | SSH username                                                                                            |
| `SFTP_PASSWORD`             | unset     | Password authentication                                                                                 |
| `SFTP_PRIVATE_KEY`          | unset     | Local path to private-key file                                                                          |
| `SFTP_PASSPHRASE`           | unset     | Private-key passphrase                                                                                  |
| `SFTP_READY_TIMEOUT`        | `20000`   | SSH handshake timeout in milliseconds                                                                   |
| `SFTP_MAX_READ_BYTES`       | `1048576` | Maximum bytes for `sftp_read`                                                                           |
| `SFTP_MAX_CONCURRENCY`      | `8`       | Default in-flight operations for batch tools                                                            |
| `SFTP_TRANSFER_CONCURRENCY` | `64`      | `fastPut` and `fastGet` concurrency                                                                     |
| `SFTP_CHUNK_SIZE`           | `32768`   | `fastPut` and `fastGet` chunk size, minimum 1024                                                        |
| `SFTP_READ_ONLY`            | `false`   | Exact boolean: `true` denies every remote mutation, including `sftp_sync_dir` dry runs                  |
| `SFTP_ALLOW_DESTRUCTIVE`    | `true`    | Exact boolean: `false` denies delete, rmdir, rename, delete batches, and non-dry-run `sftp_sync_dir`    |
| `SFTP_ALLOWED_WRITE_PREFIX` | unset     | Optional absolute POSIX lexical prefix for remote mutations                                             |
| `SFTP_ALLOWED_READ_PREFIX`  | unset     | Optional absolute POSIX lexical prefix for remote reads and remote sync traversal                       |
| `SFTP_DISABLED_TOOLS`       | unset     | Comma-separated MCP tool names to omit from registration                                                |
| `SFTP_LOG_FILE`             | unset     | Optional local path (absolute or relative to CWD) to mirror stderr diagnostics into an append-only file |

Set `SFTP_DISABLED_TOOLS` with canonical tool names separated by commas, for example `SFTP_DISABLED_TOOLS=sftp_upload,sftp_sync_dir`. Whitespace around names is ignored and duplicate names are deduplicated. Unset or blank values disable no tools. Unknown names and empty entries, such as `sftp_upload,,sftp_sync_dir`, fail startup with `ConfigError`.

Disabled tools are not registered, so they are absent from MCP tool listings and never enter client tool context. This is not a runtime tool-call denial.

Malformed numbers, malformed `SFTP_READ_ONLY` or `SFTP_ALLOW_DESTRUCTIVE`, missing host/user, non-absolute prefixes, invalid `SFTP_DISABLED_TOOLS`, or an unreadable private-key path fail startup. Private-key contents are never emitted.

## Diagnostics

Every operational line already written to stderr (warm-connect status, the ready banner, and startup failures) is also mirrored to `SFTP_LOG_FILE` when it is set to a non-blank value. This exists because some MCP hosts do not expose a spawned server's stderr stream. Unset or blank `SFTP_LOG_FILE` disables mirroring entirely; behavior is identical to a server with no log file configured.

A relative `SFTP_LOG_FILE` resolves against `process.cwd()` at startup; an absolute path is used as-is. The file is opened in append mode — existing content is preserved, never truncated — and its parent directory is never created, so the target directory must already exist.

An unusable configured path (for example, a missing parent directory) fails startup with a clear error on stderr before the server connects. If the file becomes unusable later at runtime (for example, the disk fills or the file is removed), the server emits one stderr notice and continues logging to stderr only; it never crashes or retries the file.

MCP protocol messages are the only bytes ever written to stdout. Diagnostic lines, whether mirrored to `SFTP_LOG_FILE` or not, never reach stdout.

## Remote Authorization

`SFTP_ALLOWED_WRITE_PREFIX` only controls remote mutations: write, delete, mkdir, rmdir, both rename paths, upload, mutating batches, and `sftp_sync_dir`. `SFTP_READ_ONLY=true` rejects every mutation, including dry-run sync, before any SFTP request.

`SFTP_ALLOW_DESTRUCTIVE=false` still permits writes, uploads, mkdir, and their write/upload batches. It rejects deletes, both non-recursive and recursive rmdir, every rename or move, delete batches, and every non-dry-run `sftp_sync_dir` before local traversal or SFTP calls. A dry-run `sftp_sync_dir` remains permitted and only reports its plan. `SFTP_READ_ONLY=true` takes precedence.

`SFTP_ALLOWED_READ_PREFIX` independently controls remote listing, read, download, stat, exists, download batches, and remote traversal/metadata reads needed by sync. A sync destination therefore needs both permissions when a read prefix is set. Prefixes are normalized and compared lexically as POSIX paths; `/safe` permits `/safe` and `/safe/file`, not `/safe-copy`.

Remote lexical checks do not prove symlink containment. A server-side symlink can resolve outside an allowed lexical prefix. Use server chroot, account permissions, and SFTP-server policy for physical containment.

## Tools

Discovery tool: `sftp_list_servers` (no arguments).

Read tools (all require `server`): `sftp_list`, `sftp_read`, `sftp_download`, `sftp_stat`, `sftp_exists`, `sftp_sha256`, `sftp_download_many`.

Mutation tools: `sftp_write`, `sftp_delete`, `sftp_mkdir`, `sftp_rmdir`, `sftp_rename`, `sftp_upload`, `sftp_write_many`, `sftp_delete_many`, `sftp_upload_many`, `sftp_sync_dir`.

Success responses contain one MCP text block. Failures contain `ERROR: ` text and `isError: true`. Batch failure listings remain capped at 50 lines.

## Development

```powershell
bun run test
bun run typecheck
bun run build
bun run check
```
