"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { SentCopyPolicy } from "@/modules/accounts/domain/account";
import type { MailboxRoleView } from "@/modules/mail/application/mailbox-role-service";

export function SentCopyPolicyFields({
  policy,
  onChange,
  sentRole,
  disabled = false,
}: {
  policy: SentCopyPolicy;
  onChange: (policy: SentCopyPolicy) => void;
  sentRole?: MailboxRoleView;
  disabled?: boolean;
}) {
  return (
    <fieldset className="sent-copy-policy" disabled={disabled}>
      <legend>Sent messages</legend>
      <label className="checkbox">
        <input
          type="radio"
          name="sentCopyPolicy"
          value="server"
          checked={policy === "server"}
          onChange={() => onChange("server")}
        />
        Server saves sent messages automatically
      </label>
      <label className="checkbox">
        <input
          type="radio"
          name="sentCopyPolicy"
          value="maildock"
          checked={policy === "maildock"}
          onChange={() => onChange("maildock")}
        />
        Maildock saves a copy in Sent
      </label>
      {policy === "maildock" ? (
        sentRole?.available ? (
          <p>
            Maildock saves a copy in: <strong>{sentRole.mailboxName}</strong>{" "}
            <span className="system-folder-source">
              {sentRole.source === "manual" ? "Manual" : "Auto"}
            </span>
          </p>
        ) : (
          <p className="error" role="status">
            Sent mailbox unavailable. Configure System folders → Sent.
          </p>
        )
      ) : null}
    </fieldset>
  );
}

export function SentCopySettings({
  accountId,
  initialPolicy,
  sentRole,
}: {
  accountId: string;
  initialPolicy: SentCopyPolicy;
  sentRole?: MailboxRoleView;
}) {
  const router = useRouter();
  const [policy, setPolicy] = useState(initialPolicy);
  const [savedPolicy, setSavedPolicy] = useState(initialPolicy);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function save(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    setSaved(false);
    try {
      const response = await fetch(`/api/accounts/${accountId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sentCopyPolicy: policy }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok)
        throw Error(result.error ?? "Sent-copy policy could not be saved.");
      setSavedPolicy(policy);
      setSaved(true);
      router.refresh();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Sent-copy policy could not be saved.",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <form className="sent-copy-settings" onSubmit={(event) => void save(event)}>
      <SentCopyPolicyFields
        policy={policy}
        onChange={(value) => {
          setPolicy(value);
          setSaved(false);
          setError("");
        }}
        sentRole={sentRole}
        disabled={pending}
      />
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      <button
        className="button secondary"
        disabled={pending || policy === savedPolicy}
      >
        {pending ? "Saving…" : saved ? "Saved" : "Save Sent setting"}
      </button>
    </form>
  );
}
