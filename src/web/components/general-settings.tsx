import type { PermissionMode } from "../../shared/contracts.js";
import type { UiPreferences } from "../preferences.js";

interface GeneralSettingsProps {
  value: UiPreferences;
  onChange(value: UiPreferences): void;
}
export function GeneralSettings({ value, onChange }: GeneralSettingsProps) {
  const zh = value.language === "zh";
  return (
    <section className="general-settings">
      <h1>{zh ? "通用设置" : "General settings"}</h1>
      <p>{zh ? "这些偏好应用于工作台和之后新建的会话。" : "These preferences apply to the workspace and sessions you start next."}</p>
      <label>
        {zh ? "默认权限模式" : "Default permission mode"}
        <select
          aria-label="Default permission mode"
          value={value.defaultPermissionMode}
          onChange={(event) => onChange({
            ...value,
            defaultPermissionMode: event.currentTarget.value as PermissionMode,
          })}
        >
          <option value="request_approval">{zh ? "需要审批" : "Ask for approval"}</option>
          <option value="help_me_approve">{zh ? "自动审批" : "Auto approve"}</option>
          <option value="full_access">{zh ? "完全访问" : "Full access"}</option>
        </select>
      </label>
      <label>
        {zh ? "语言" : "Language"}
        <select
          aria-label="Language"
          value={value.language}
          onChange={(event) => onChange({
            ...value,
            language: event.currentTarget.value as UiPreferences["language"],
          })}
        >
          <option value="zh">中文</option>
          <option value="en">English</option>
        </select>
      </label>
      <fieldset>
        <legend>{zh ? "外观" : "Appearance"}</legend>
        {(["light", "dark", "system"] as const).map((appearance) => (
          <label key={appearance} className="general-settings__appearance" data-selected={value.appearance === appearance}>
            <input
              type="radio"
              name="appearance"
              value={appearance}
              checked={value.appearance === appearance}
              onChange={() => onChange({ ...value, appearance })}
            />
            <span className={`general-settings__appearance-preview general-settings__appearance-preview--${appearance}`} aria-hidden="true">
              <span /><span><i /><i /><i /></span>
            </span>
            <span>{appearance === "light"
              ? zh ? "浅色" : "Light"
              : appearance === "dark"
                ? zh ? "深色" : "Dark"
                : zh ? "跟随系统" : "System"}</span>
          </label>
        ))}
      </fieldset>
    </section>
  );
}
