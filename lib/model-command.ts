export function isSettingsSlashCommand(message: string): boolean {
  return /^\/(model|thinking)(?:\s|$)/.test(message.trim());
}

export type SettingChangeResult = { error?: string; level?: string };
