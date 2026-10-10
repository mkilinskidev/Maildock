"use client";
import { useEffect, useRef, useState } from "react";
import { Paperclip } from "lucide-react";
import type { AttachmentView } from "@/modules/mail/domain/attachments";

export function attachmentSize(size: string | null) {
  if (size === null) return "";
  const bytes = Number(size);
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.ceil(bytes / 1024)} KB`;
}
export function AttachmentList({
  attachments,
}: {
  attachments: AttachmentView[];
}) {
  const [states, setStates] = useState<
    Record<string, { status: string; error: string | null }>
  >({});
  const requestedDownloads = useRef(new Set<string>());
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      const pending = attachments.filter((a) =>
        ["pending", "fetching"].includes(states[a.id]?.status ?? a.status),
      );
      if (!pending.length) return;
      const updates: Record<string, { status: string; error: string | null }> =
        {};
      for (const a of pending) {
        try {
          const response = await fetch(`/api/attachments/${a.id}`);
          if (!response.ok) throw Error();
          updates[a.id] = await response.json();
        } catch {
          updates[a.id] = {
            status: "failed",
            error: "Attachment status could not be loaded. Retry preparation.",
          };
        }
      }
      if (!cancelled) {
        setStates((current) => ({ ...current, ...updates }));
        for (const [id, state] of Object.entries(updates)) {
          if (
            state.status === "ready" &&
            requestedDownloads.current.delete(id)
          ) {
            const link = document.createElement("a");
            link.href = `/api/attachments/${id}/download`;
            link.download = "";
            document.body.append(link);
            link.click();
            link.remove();
          } else if (state.status === "failed") {
            requestedDownloads.current.delete(id);
          }
        }
      }
    }
    const timer = setTimeout(() => void poll(), 2500);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [attachments, states]);
  async function prepare(id: string) {
    requestedDownloads.current.add(id);
    setStates((current) => ({
      ...current,
      [id]: { status: "pending", error: null },
    }));
    try {
      const response = await fetch(`/api/attachments/${id}`, {
        method: "POST",
      });
      if (!response.ok) throw Error();
    } catch {
      requestedDownloads.current.delete(id);
      setStates((current) => ({
        ...current,
        [id]: { status: "failed", error: "Attachment could not be prepared." },
      }));
    }
  }
  const visible = attachments.filter((a) => a.visible);
  if (!visible.length) return null;
  return (
    <div className="mail-attachments">
      <h3>Attachments</h3>
      {visible.map((a) => {
        const state = states[a.id] ?? a;
        const preparing = ["pending", "fetching"].includes(state.status);
        const contents = (
          <>
            <Paperclip size={13} aria-hidden="true" />
            <span className="attachment-filename">
              {a.filename || "Attachment"}
            </span>
            {a.size !== null ? (
              <span className="attachment-size">{attachmentSize(a.size)}</span>
            ) : null}
            {preparing ? <span role="status">Preparing…</span> : null}
          </>
        );
        return (
          <span key={a.id} className="attachment-item">
            {state.status === "ready" ? (
              <a
                className="mail-attachment attachment-download"
                aria-label={`Download ${a.filename || "attachment"}`}
                href={`/api/attachments/${a.id}/download`}
                download
              >
                {contents}
              </a>
            ) : (
              <button
                className="mail-attachment attachment-download"
                type="button"
                disabled={preparing}
                aria-busy={preparing}
                aria-label={`${preparing ? "Preparing" : "Download"} ${a.filename || "attachment"}`}
                onClick={() => void prepare(a.id)}
              >
                {contents}
              </button>
            )}
            {state.error ? (
              <span className="error" role="alert">
                {state.error}
              </span>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}
