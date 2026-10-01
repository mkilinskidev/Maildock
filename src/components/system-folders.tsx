"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { MailboxView } from "@/modules/mail/application/mailbox-service";
import type {
  MailboxRoleView,
  SystemMailboxRole,
} from "@/modules/mail/application/mailbox-role-service";

const labels: Record<SystemMailboxRole, string> = {
  archive: "Archive",
  trash: "Trash",
  sent: "Sent",
  drafts: "Drafts",
  junk: "Junk",
};

export function SystemFolders({
  accountId,
  initialRoles,
  mailboxes,
}: {
  accountId: string;
  initialRoles: MailboxRoleView[];
  mailboxes: MailboxView[];
}) {
  const router = useRouter();
  const [roles, setRoles] = useState(initialRoles);
  const [pending, setPending] = useState<SystemMailboxRole | null>(null);
  const [error, setError] = useState("");
  const choices = mailboxes.filter(
    (item) => item.selectable && item.lifecycleStatus === "active",
  );

  async function update(role: SystemMailboxRole, mailboxId?: string) {
    setPending(role);
    setError("");
    try {
      const response = await fetch(
        `/api/accounts/${accountId}/mailbox-roles/${role}`,
        {
          method: mailboxId ? "PUT" : "DELETE",
          ...(mailboxId
            ? {
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ mailboxId }),
              }
            : {}),
        },
      );
      const result = (await response.json()) as {
        roles?: MailboxRoleView[];
        error?: string;
      };
      if (!response.ok || !result.roles)
        throw new Error(result.error ?? "System folder could not be saved.");
      setRoles(result.roles);
      router.refresh();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "System folder could not be saved.",
      );
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="system-folders" aria-label="System folders">
      <h3>System folders</h3>
      <p>Choose a mailbox when the server does not identify its role.</p>
      {roles.map((item) => (
        <div className="system-folder-row" key={item.role}>
          <label htmlFor={`${accountId}-${item.role}`}>
            {labels[item.role]}
          </label>
          <select
            id={`${accountId}-${item.role}`}
            aria-label={`${labels[item.role]} mailbox`}
            value={item.available ? (item.mailboxId ?? "") : ""}
            disabled={pending !== null}
            onChange={(event) => {
              if (event.target.value)
                void update(item.role, event.target.value);
            }}
          >
            <option value="">
              {item.mailboxId
                ? "Unavailable — select a mailbox"
                : "Not assigned"}
            </option>
            {choices.map((mailbox) => (
              <option key={mailbox.id} value={mailbox.id}>
                {mailbox.name}
              </option>
            ))}
          </select>
          <span className="system-folder-source">
            {item.source === "manual"
              ? "Manual"
              : item.source === "special_use"
                ? "Auto"
                : "Unassigned"}
            {item.mailboxId && !item.available
              ? ` · ${item.mailboxName ?? "Mailbox"} unavailable`
              : ""}
          </span>
          {item.source === "manual" ? (
            <button
              className="button secondary"
              type="button"
              disabled={pending !== null}
              onClick={() => void update(item.role)}
            >
              Clear
            </button>
          ) : null}
        </div>
      ))}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
