import { useEffect, type ReactNode } from "react";
import type { Language } from "../preferences.js";

export type SettingsSection = "general" | "archived" | "agents" | "plugins";

interface AppSettingsProps {
  open: boolean;
  section: SettingsSection;
  general: ReactNode;
  agents: ReactNode;
  plugins: ReactNode;
  archived: ReactNode;
  language: Language;
  onSectionChange(section: SettingsSection): void;
  onClose(): void;
}
export function AppSettings(props: AppSettingsProps) {
  useEffect(() => {
    if (!props.open) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") props.onClose(); };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [props.open, props.onClose]);
  if (!props.open) {
    return null;
  }

  const zh = props.language === "zh";
  const settings = zh ? "设置" : "Settings";
  return (
    <div className="app-settings">
      <button
        type="button"
        className="app-settings__backdrop"
        aria-label={zh ? "关闭设置" : "Dismiss Settings"}
        onPointerDown={props.onClose}
      />
      <section className="app-settings__dialog" role="dialog" aria-modal="true" aria-label={settings}>
        <nav className="app-settings__nav" aria-label={zh ? "设置分类" : "Settings sections"}>
          <h2>{settings}</h2>
          <button
            type="button"
            className="app-settings__nav-item"
            data-active={props.section === "general"}
            onClick={() => props.onSectionChange("general")}
          >
            {zh ? "通用设置" : "General"}
          </button>
          <button
            type="button"
            className="app-settings__nav-item"
            data-active={props.section === "agents"}
            onClick={() => props.onSectionChange("agents")}
          >
            Agents
          </button>
          <button
            type="button"
            className="app-settings__nav-item"
            data-active={props.section === "plugins"}
            onClick={() => props.onSectionChange("plugins")}
          >
            {zh ? "插件" : "Plugins"}
          </button>
          <button
            type="button"
            className="app-settings__nav-item"
            data-active={props.section === "archived"}
            onClick={() => props.onSectionChange("archived")}
          >
            {zh ? "已归档" : "Archived"}
          </button>
        </nav>
        <div className="app-settings__content">
          <header className="app-settings__header">
            <button
              type="button"
              aria-label={zh ? "关闭设置" : "Close Settings"}
              onClick={props.onClose}
            >
              ×
            </button>
          </header>
          <div className="app-settings__body" data-section={props.section}>
            {props.section === "general" ? props.general : null}
            {props.section === "archived" ? props.archived : null}
            {props.section === "agents" ? props.agents : null}
            {props.section === "plugins" ? props.plugins : null}
          </div>
        </div>
      </section>
    </div>
  );
}
