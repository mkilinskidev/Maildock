"use client";
import type { MailAccountView } from "@/modules/accounts/application/accounts-service";
import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { DraftView } from "@/modules/mail/domain/draft";
import {
  plainTextDocument,
  validateRichDocument,
} from "@/modules/mail/domain/rich-document";
export function DraftList({
  accounts = [],
  onResume,
  disabled = false,
  refreshKey = 0,
}: {
  accounts?: MailAccountView[];
  onResume: (draft: DraftView) => void;
  disabled?: boolean;
  refreshKey?: number;
}) {
  const [rows, setRows] = useState<
    { id: string; accountId?: string; subject: string; to: string }[]
  >([]);
  const [error, setError] = useState("");
  const [conflictedId, setConflictedId] = useState("");
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [generation, setGeneration] = useState(refreshKey);
  if (generation !== refreshKey) {
    setGeneration(refreshKey);
    setLoading(true);
    setError("");
  }
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/drafts");
        if (!response.ok) throw Error("Maildock drafts could not be loaded.");
        const remote = (await response.json()) as {
          id: string;
          accountId?: string;
          subject: string;
          to: string;
        }[];
        const merged = new Map(remote.map((row) => [row.id, row]));
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (!key?.startsWith("maildock-draft:")) continue;
          try {
            const row = JSON.parse(localStorage.getItem(key)!) as DraftView;
            merged.set(row.id, row);
          } catch {}
        }
        if (!cancelled) setRows([...merged.values()]);
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Could not load drafts.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey, retry]);
  async function resume(id: string) {
    try {
      const backup = localStorage.getItem(`maildock-draft:${id}`);
      const response = await fetch(`/api/drafts/${id}`);
      if (backup) {
        if (new TextEncoder().encode(backup).length > 1_000_000)
          throw Error(
            "Recovery copy exceeds the supported size. Reopen the saved draft.",
          );
        const local = JSON.parse(backup) as DraftView;
        local.richDocument = validateRichDocument(
          local.richDocument ?? plainTextDocument(local.plainText),
        );
        if (response.ok) {
          const remote = (await response.json()) as DraftView;
          if (local.revision !== remote.revision && local.revision !== 0) {
            setConflictedId(id);
            throw Error(
              "This draft changed in another tab. Your unsaved recovery copy has been kept. Reopen the saved Maildock draft to continue.",
            );
          }
        } else if (response.status === 409 && local.revision > 0)
          throw Error("This draft was sent or discarded in another tab.");
        else if (!response.ok && response.status !== 409)
          throw Error("Draft could not be loaded. Please retry.");
        onResume(local);
        return;
      }
      if (!response.ok)
        throw Error((await response.json()).error ?? "Draft unavailable.");
      onResume((await response.json()) as DraftView);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Draft unavailable.");
    }
  }
  async function discard(id: string) {
    try {
      const response = await fetch(`/api/drafts/${id}`);
      if (response.ok) {
        const row = (await response.json()) as DraftView;
        const removal = await fetch(`/api/drafts/${id}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedRevision: row.revision }),
        });
        if (!removal.ok)
          throw Error(
            (await removal.json()).error ?? "Draft could not be discarded.",
          );
      } else if (response.status !== 409)
        throw Error("Draft could not be discarded.");
      localStorage.removeItem(`maildock-draft:${id}`);
      setRows((current) => current.filter((row) => row.id !== id));
      setError("");
      setConflictedId("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Discard failed.");
    }
  }
  return (
    <div className="mail-rows">
      {error ? (
        <p role="alert" className="mail-error error">
          {error}
        </p>
      ) : null}
      {conflictedId ? (
        <div className="draft-recovery-actions">
          <p>
            Reopening the saved draft replaces this browser&apos;s recovery
            copy.
          </p>
          <button
            className="button secondary"
            disabled={disabled}
            onClick={() =>
              void (async () => {
                try {
                  const response = await fetch(`/api/drafts/${conflictedId}`);
                  if (!response.ok)
                    throw Error(
                      "The saved draft could not be reopened. Please retry.",
                    );
                  const row = (await response.json()) as DraftView;
                  localStorage.removeItem(`maildock-draft:${conflictedId}`);
                  onResume(row);
                } catch (failure) {
                  setError(
                    failure instanceof Error
                      ? failure.message
                      : "The saved draft could not be reopened. Please retry.",
                  );
                }
              })()
            }
          >
            Reopen saved draft
          </button>
        </div>
      ) : null}
      {loading ? (
        <p className="mail-list-status" role="status">
          Loading Maildock drafts…
        </p>
      ) : null}
      {error ? (
        <button
          className="button secondary"
          disabled={loading || disabled}
          onClick={() => {
            setLoading(true);
            setError("");
            setRetry((n) => n + 1);
          }}
        >
          Retry loading drafts
        </button>
      ) : null}
      {rows.map((row) => (
        <div key={row.id} className="local-draft-row">
          <button
            className="mail-list-row"
            disabled={disabled}
            onClick={() => void resume(row.id)}
          >
            <strong>{row.to || "No recipients"}</strong>
            <span className="mail-row-subject">
              {row.subject || "(No subject)"}
            </span>
            {row.accountId ? (
              <span className="mail-row-bottom">
                {accounts.find((a) => a.id === row.accountId)?.displayName ??
                  "Account unavailable"}
              </span>
            ) : null}
          </button>
          <button
            className="icon-button"
            disabled={disabled}
            title="Discard draft"
            aria-label={`Discard ${row.subject || "draft"}`}
            onClick={() => void discard(row.id)}
          >
            <Trash2 size={15} />
          </button>
        </div>
      ))}
      {!loading && !error && !rows.length ? (
        <div className="pane-empty">
          <strong>No Maildock drafts</strong>
          <p>
            Start a new message. Your drafts are saved in Maildock and
            aren&apos;t synchronized to your email provider.
          </p>
        </div>
      ) : null}
    </div>
  );
}
