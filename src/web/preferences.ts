import type { PermissionMode } from "../shared/contracts.js";

export type Language = "zh" | "en";
export type Appearance = "light" | "dark" | "system";

export interface UiPreferences {
  language: Language;
  appearance: Appearance;
  defaultPermissionMode: PermissionMode;
}
const keys = {
  language: "ain-one:language",
  appearance: "ain-one:appearance",
  defaultPermissionMode: "ain-one:default-permission",
} as const;

export function readPreferences(): UiPreferences {
  const language = readStorage(keys.language);
  const appearance = readStorage(keys.appearance);
  const defaultPermissionMode = readStorage(keys.defaultPermissionMode);
  return {
    language: language === "zh" || language === "en"
      ? language
      : globalThis.navigator?.language.toLowerCase().startsWith("zh") ? "zh" : "en",
    appearance: appearance === "light" || appearance === "dark" ? appearance : "system",
    defaultPermissionMode:
      defaultPermissionMode === "help_me_approve" || defaultPermissionMode === "full_access"
        ? defaultPermissionMode
        : "request_approval",
  };
}
export function writePreferences(preferences: UiPreferences): void {
  writeStorage(keys.language, preferences.language);
  writeStorage(keys.appearance, preferences.appearance);
  writeStorage(keys.defaultPermissionMode, preferences.defaultPermissionMode);
}

function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Preferences remain usable for this session when storage is unavailable.
  }
}
