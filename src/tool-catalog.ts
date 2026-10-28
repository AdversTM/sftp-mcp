export const toolNames = [
  "sftp_list_servers",
  "sftp_list",
  "sftp_read",
  "sftp_write",
  "sftp_delete",
  "sftp_mkdir",
  "sftp_rmdir",
  "sftp_rename",
  "sftp_upload",
  "sftp_download",
  "sftp_stat",
  "sftp_exists",
  "sftp_write_many",
  "sftp_delete_many",
  "sftp_upload_many",
  "sftp_download_many",
  "sftp_sync_dir",
] as const;

export type ToolName = (typeof toolNames)[number];

export function isToolName(value: string): value is ToolName {
  return toolNames.some((toolName) => toolName === value);
}
