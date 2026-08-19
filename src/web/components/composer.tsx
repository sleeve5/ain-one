import { useState } from "react";

interface ComposerProps {
  disabled?: boolean;
  queueMode: boolean;
  onSubmit(content: string): Promise<void>;
}

export function Composer(props: ComposerProps) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const submitDisabled = props.disabled || busy || draft.trim().length === 0;

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (submitDisabled) {
          return;
        }

        const message = draft.trim();
        setBusy(true);
        void props.onSubmit(message).then(
          () => {
            setDraft("");
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
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
        rows={4}
      />
      <button type="submit" className="composer__send" disabled={submitDisabled}>
        {props.queueMode ? "Queue message" : "Send message"}
      </button>
    </form>
  );
}
