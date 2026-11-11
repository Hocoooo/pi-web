export interface ConfigSyncStatus {
  repository: string;
  branch: string;
  lastSync: { action: "push" | "pull"; commit: string; at: string } | null;
}

export interface ConfigSyncResult extends ConfigSyncStatus {
  changed: boolean;
  files: number;
  packages: number;
  reloadRequired: boolean;
}
