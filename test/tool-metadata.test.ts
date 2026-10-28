import { describe, expect, it } from "vitest";

import { toolDescriptions } from "../src/server.js";
import type { ToolName } from "../src/server.js";

describe("MCP tool metadata", () => {
  it("preserves every registered tool description", () => {
    // Given
    const expected = {
      sftp_list_servers:
        "List configured SFTP servers (id, user@host:port, access policy, description). Pass the id as `server` to every other sftp_* tool.",
      sftp_list: "List a remote directory (read-only). Returns type/size/mtime/name per entry.",
      sftp_read:
        "Read a remote text file (read-only). Refuses files larger than SFTP_MAX_READ_BYTES.",
      sftp_write: "Write/overwrite a remote text file from inline content.",
      sftp_delete: "Delete a remote file.",
      sftp_mkdir: "Create a remote directory.",
      sftp_rmdir: "Remove a remote directory.",
      sftp_rename: "Rename or move a remote file/directory (destination is guarded).",
      sftp_upload: "Upload a local file to the remote host (for binary/large files).",
      sftp_download: "Download a remote file to a local path (read-only).",
      sftp_stat: "Stat a remote path (read-only).",
      sftp_exists:
        "Check whether a remote path exists (read-only). Returns false | 'd' | '-' | 'l'.",
      sftp_write_many:
        "Write many remote text files in parallel on one connection. Much faster than N sequential writes across a high-latency link.",
      sftp_delete_many: "Delete many remote files in parallel on one connection.",
      sftp_upload_many: "Upload many local files in parallel on one connection.",
      sftp_download_many: "Download many remote files in parallel on one connection.",
      sftp_sync_dir:
        "Sync a local directory to a remote directory: upload files that are missing, size-different, or newer (parallel). Optionally delete remote files not present locally. Use dryRun to preview.",
    } satisfies Record<ToolName, string>;

    // When
    const descriptions = toolDescriptions;

    // Then
    expect(descriptions).toEqual(expected);
  });
});
