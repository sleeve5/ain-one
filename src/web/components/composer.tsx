import { useState, type ReactNode } from "react";

interface ComposerProps {
  disabled?: boolean;
  value: string;
  onChange(value: string): void;
  onSubmit(content: string): Promise<void>;
  language?: "zh" | "en";
  leadingControls?: ReactNode;
  trailingControls?: ReactNode;
  stopControl?: ReactNode;
}

export function Composer(props: ComposerProps) {
  const [busy, setBusy] = useState(false);
  const zh = props.language === "zh";

  const submitDisabled = props.disabled || busy || props.value.trim().length === 0;

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (submitDisabled) {
          return;
        }

        const message = props.value.trim();
        setBusy(true);
        void props.onSubmit(message).then(
          () => {
            setBusy(false);
          },
          () => {
            setBusy(false);
          },
        );
      }}
    >
      <label className="composer__label" htmlFor="message-input">
        {zh ? "消息" : "Message"}
      </label>
      <textarea
        id="message-input"
        className="composer__input"
        value={props.value}
        onChange={(event) => props.onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
        rows={3}
        placeholder={zh ? "给 Ain One 发送消息" : "Message Ain One"}
      />
      <div className="composer__footer">
        <div className="composer__controls composer__controls--leading">{props.leadingControls}</div>
        <div className="composer__controls composer__controls--trailing">{props.trailingControls}{props.stopControl}<button type="submit" className="composer__send" disabled={submitDisabled} aria-label="Send message">↑</button></div>
      </div>
    </form>
  );
}
