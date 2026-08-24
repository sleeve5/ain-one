import { useState } from "react";

interface ComposerProps {
  disabled?: boolean;
  queueMode: boolean;
  value: string;
  onChange(value: string): void;
  onSubmit(content: string): Promise<void>;
}

export function Composer(props: ComposerProps) {
  const [busy, setBusy] = useState(false);

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
        Message
      </label>
      <textarea
        id="message-input"
        className="composer__input"
        value={props.value}
        onChange={(event) => props.onChange(event.currentTarget.value)}
        rows={4}
      />
      <button type="submit" className="composer__send" disabled={submitDisabled}>
        {props.queueMode ? "Queue message" : "Send message"}
      </button>
    </form>
  );
}
