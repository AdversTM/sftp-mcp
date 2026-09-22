# SFTP MCP Server

Node ESM MCP server for SFTP accounts, including chrooted accounts limited to the SFTP subsystem. It uses one warm SSH/SFTP channel and retries an operation once after a confirmed connection-level failure.

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

| Variable                    | Default   | Meaning                                                                                              |
|-----------------------------|-----------|------------------------------------------------------------------------------------------------------|
| `SFTP_HOST`                 | required  | SSH host                                                                                             |
| `SFTP_PORT`                 | `22`      | SSH port, integer 1 through 65535                                                                    |
| `SFTP_USER`                 | required  | SSH username                                                                                         |
| `SFTP_PASSWORD`             | unset     | Password authentication                                                                              |
| `SFTP_PRIVATE_KEY`          | unset     | Local path to private-key file                                                                       |
| `SFTP_PASSPHRASE`           | unset     | Private-key passphrase                                                                               |
| `SFTP_READY_TIMEOUT`        | `20000`   | SSH handshake timeout in milliseconds                                                                |
| `SFTP_MAX_READ_BYTES`       | `1048576` | Maximum bytes for `sftp_read`                                                                        |
| `SFTP_MAX_CONCURRENCY`      | `8`       | Default in-flight operations for batch tools                                                         |
| `SFTP_TRANSFER_CONCURRENCY` | `64`      | `fastPut` and `fastGet` concurrency                                                                  |
| `SFTP_CHUNK_SIZE`           | `32768`   | `fastPut` and `fastGet` chunk size, minimum 1024                                                     |
| `SFTP_READ_ONLY`            | `false`   | Exact boolean: `true` denies every remote mutation, including `sftp_sync_dir` dry runs               |
| `SFTP_ALLOW_DESTRUCTIVE`    | `true`    | Exact boolean: `false` denies delete, rmdir, rename, delete batches, and non-dry-run `sftp_sync_dir` |
| `SFTP_ALLOWED_WRITE_PREFIX` | unset     | Optional absolute POSIX lexical prefix for remote mutations                                          |
| `SFTP_ALLOWED_READ_PREFIX`  | unset     | Optional absolute POSIX lexical prefix for remote reads and remote sync traversal                    |
| `SFTP_DISABLED_TOOLS`       | unset     | Comma-separated MCP tool names to omit from registration                                             |

Set `SFTP_DISABLED_TOOLS` with canonical tool names separated by commas, for example `SFTP_DISABLED_TOOLS=sftp_upload,sftp_sync_dir`. Whitespace around names is ignored and duplicate names are deduplicated. Unset or blank values disable no tools. Unknown names and empty entries, such as `sftp_upload,,sftp_sync_dir`, fail startup with `ConfigError`.

Disabled tools are not registered, so they are absent from MCP tool listings and never enter client tool context. This is not a runtime tool-call denial.

Malformed numbers, malformed `SFTP_READ_ONLY` or `SFTP_ALLOW_DESTRUCTIVE`, missing host/user, non-absolute prefixes, invalid `SFTP_DISABLED_TOOLS`, or an unreadable private-key path fail startup. Private-key contents are never emitted.

## Remote Authorization

`SFTP_ALLOWED_WRITE_PREFIX` only controls remote mutations: write, delete, mkdir, rmdir, both rename paths, upload, mutating batches, and `sftp_sync_dir`. `SFTP_READ_ONLY=true` rejects every mutation, including dry-run sync, before any SFTP request.

`SFTP_ALLOW_DESTRUCTIVE=false` still permits writes, uploads, mkdir, and their write/upload batches. It rejects deletes, both non-recursive and recursive rmdir, every rename or move, delete batches, and every non-dry-run `sftp_sync_dir` before local traversal or SFTP calls. A dry-run `sftp_sync_dir` remains permitted and only reports its plan. `SFTP_READ_ONLY=true` takes precedence.

`SFTP_ALLOWED_READ_PREFIX` independently controls remote listing, read, download, stat, exists, download batches, and remote traversal/metadata reads needed by sync. A sync destination therefore needs both permissions when a read prefix is set. Prefixes are normalized and compared lexically as POSIX paths; `/safe` permits `/safe` and `/safe/file`, not `/safe-copy`.

Remote lexical checks do not prove symlink containment. A server-side symlink can resolve outside an allowed lexical prefix. Use server chroot, account permissions, and SFTP-server policy for physical containment.

## Tools

Read tools: `sftp_list`, `sftp_read`, `sftp_download`, `sftp_stat`, `sftp_exists`, `sftp_download_many`.

Mutation tools: `sftp_write`, `sftp_delete`, `sftp_mkdir`, `sftp_rmdir`, `sftp_rename`, `sftp_upload`, `sftp_write_many`, `sftp_delete_many`, `sftp_upload_many`, `sftp_sync_dir`.

Success responses contain one MCP text block. Failures contain `ERROR: ` text and `isError: true`. Batch failure listings remain capped at 50 lines.

## Development

```powershell
bun run test
bun run typecheck
bun run build
bun run check
```
