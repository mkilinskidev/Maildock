"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function ConversationViewSettings({
  initialEnabled,
}: {
  initialEnabled: boolean;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  async function save(value: boolean) {
    const previous = enabled;
    setEnabled(value);
    setPending(true);
    setStatus("");
    setError("");
    try {
      const response = await fetch("/api/settings/conversation-view", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: value }),
      });
      if (!response.ok)
        throw Error("Conversation view setting could not be saved.");
      setStatus("Saved");
      router.refresh();
    } catch (failure) {
      setEnabled(previous);
      setError(
        failure instanceof Error
          ? failure.message
          : "Setting could not be saved.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      className="mail-preferences"
      aria-labelledby="conversation-view-heading"
    >
      <div className="mail-preferences-heading">
        <h2 id="conversation-view-heading">Conversation view</h2>
      </div>
      <p
        id="conversation-view-description"
        className="mail-preference-description"
      >
        Group related messages in the message list. Applies to all accounts.
      </p>
      <label className="conversation-preference">
        <input
          type="checkbox"
          checked={enabled}
          disabled={pending}
          aria-label="Conversation view"
          aria-describedby="conversation-view-description"
          onChange={(event) => void save(event.target.checked)}
        />
        <span>Enable conversation view</span>
      </label>
      <p className="preference-save-status" role="status">
        {pending ? "Saving…" : status}
      </p>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
