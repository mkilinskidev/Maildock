"use client";

import type { DraftView } from "@/modules/mail/domain/draft";
import type { ComposePrefill } from "@/modules/mail/domain/compose-source";
import { useCallback, useEffect, useRef, useState } from "react";
import { Send, X, Paperclip } from "lucide-react";
import type { AttachmentView } from "@/modules/mail/domain/attachments";
import { attachmentSize } from "./attachment-list";
import type { MailAccountView } from "@/modules/accounts/application/accounts-service";
import { uploadComposeFile } from "./compose-upload";
import { RichComposer } from "./rich-composer";
import {
  plainTextDocument,
  richResourceIds,
  serializeRichDocument,
  validateRichDocument,
  type RichDocument,
} from "@/modules/mail/domain/rich-document";

export function sendingAccountAvailable(account: MailAccountView) {
  return (
    account.enabled &&
    Boolean(account.smtp?.host) &&
    (account.authMethod !== "oauth2" || account.oauthStatus === "connected")
  );
}
export function sendStatusText(status: string, sentCopyStatus?: string) {
  if (status === "sent" && sentCopyStatus === "failed")
    return "Message sent, but the copy could not be saved to Sent.";
  if (status === "sent" && sentCopyStatus === "uncertain")
    return "Message sent, but Maildock could not confirm whether the Sent copy was saved.";
  if (status === "sent" && ["pending", "saving"].includes(sentCopyStatus ?? ""))
    return "Message sent · Saving a copy to Sent…";
  if (status === "sent") return "Message sent";
  if (status === "failed") return "Message could not be sent";
  if (status === "uncertain")
    return "Maildock could not confirm whether this message was sent.";
  return "Sending…";
}

export function MailComposer({
  accounts,
  accountId,
  prefill,
  draft,
  onQueued,
  onSaved,
  onClose,
}: {
  prefill?: ComposePrefill;
  draft?: DraftView;
  accounts: MailAccountView[];
  accountId: string;
  onQueued: (id: string) => void;
  onSaved?: () => void;
  onClose: () => void;
}) {
  const usable = accounts.filter(sendingAccountAvailable);
  const [from, setFrom] = useState(
    draft?.accountId ??
      usable.find((account) => account.id === accountId)?.id ??
      usable[0]?.id ??
      "",
  );
  const selectable = [
    ...usable,
    ...accounts.filter(
      (account) => account.id === from && !sendingAccountAvailable(account),
    ),
  ];
  const [to, setTo] = useState(draft?.to ?? prefill?.to ?? "");
  const [cc, setCc] = useState(draft?.cc ?? prefill?.cc ?? "");
  const [bcc, setBcc] = useState(draft?.bcc ?? "");
  const [subject, setSubject] = useState(
    draft?.subject ?? prefill?.subject ?? "",
  );
  const [richDocument, setRichDocument] = useState<RichDocument>(() =>
    validateRichDocument(
      draft?.richDocument ??
        prefill?.richDocument ??
        plainTextDocument(draft?.plainText ?? prefill?.plainText ?? ""),
    ),
  );
  const referenced = richResourceIds(richDocument);
  const plainText = serializeRichDocument(
    richDocument,
    new Map([...referenced].map((id) => [id, `${id}@maildock.invalid`])),
  ).plainText;
  const [editorValid, setEditorValid] = useState(true);
  const [signatureReady, setSignatureReady] = useState(false);
  const editorValidRef = useRef(true);
  editorValidRef.current = editorValid;
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<
    (AttachmentView & { kind: "incoming" | "staged" | "draft" })[]
  >(
    () =>
      draft?.attachments ??
      (prefill?.attachments ?? []).map((a) => ({ ...a, kind: "incoming" })),
  );
  const source = draft?.source ?? prefill?.source;
  const addSignatureResources = useCallback(
    (resources: (AttachmentView & { kind: "staged" })[]) =>
      setAttachments((current) => [...current, ...resources]),
    [],
  );
  const draftId = useRef(draft?.id ?? crypto.randomUUID());
  const revision = useRef(draft?.revision ?? 0);
  const [saveState, setSaveState] = useState(draft?.revision ? "Saved" : "");
  const conflict = useRef(false);
  const stopped = useRef(false);
  const saving = useRef<Promise<void> | null>(null);
  const snapshot = JSON.stringify({
    accountId: from,
    to,
    cc,
    bcc,
    subject,
    plainText,
    richDocument,
    attachments: attachments
      .filter(
        (a) =>
          a.status !== "uploading" &&
          !(a.kind === "staged" && a.status === "failed"),
      )
      .filter((a) => !a.inline || referenced.has(a.id))
      .map(({ id, kind, inline }) => ({ id, kind, inline })),
  });
  const latest = useRef(snapshot);
  latest.current = snapshot;
  const saved = useRef(draft?.revision && !draft.recovery ? snapshot : "");
  const recovery = useRef<DraftView | null>(null);
  recovery.current = {
    id: draftId.current,
    accountId: from,
    to,
    cc,
    bcc,
    subject,
    plainText,
    richDocument,
    source: source ?? null,
    composeMode: source?.mode ?? "new",
    revision: revision.current,
    status: "active",
    outgoingMessageId: null,
    recovery: true,
    attachments: attachments
      .filter(
        (a) =>
          a.status !== "uploading" &&
          !(a.kind === "staged" && a.status === "failed"),
      )
      .filter((a) => !a.inline || referenced.has(a.id)),
  };
  function meaningful() {
    const value = JSON.parse(latest.current);
    return (
      revision.current > 0 ||
      Boolean(source) ||
      [value.to, value.cc, value.bcc, value.subject, value.plainText].some(
        (v) => v.length,
      ) ||
      attachments.length > 0
    );
  }
  function backup() {
    if (!editorValidRef.current) return;
    if (!meaningful()) {
      try {
        localStorage.removeItem(`maildock-draft:${draftId.current}`);
      } catch {}
      return;
    }
    if (
      meaningful() &&
      saved.current !== latest.current &&
      !stopped.current &&
      recovery.current
    ) {
      try {
        const serialized = JSON.stringify({
          ...recovery.current,
          revision: revision.current,
        });
        if (new TextEncoder().encode(serialized).length <= 1_000_000)
          localStorage.setItem(`maildock-draft:${draftId.current}`, serialized);
        else localStorage.removeItem(`maildock-draft:${draftId.current}`);
      } catch {
        /* Server autosave remains available. */
      }
    }
  }
  async function save() {
    if (!signatureReady)
      throw Error(
        "Wait for signatures to finish loading before saving or sending.",
      );
    if (!editorValidRef.current)
      throw Error("Undo unsupported formatting before saving or sending.");
    if (saving.current) return saving.current;
    if (
      stopped.current ||
      conflict.current ||
      !meaningful() ||
      saved.current === latest.current
    )
      return;
    saving.current = (async () => {
      try {
        while (!stopped.current && saved.current !== latest.current) {
          const state = latest.current;
          setSaveState("Saving…");
          backup();
          const response = await fetch(
            revision.current ? `/api/drafts/${draftId.current}` : "/api/drafts",
            {
              method: revision.current ? "PATCH" : "POST",
              headers: { "Content-Type": "application/json" },
              keepalive: state.length < 60000,
              body: JSON.stringify({
                ...JSON.parse(state),
                ...(revision.current
                  ? { expectedRevision: revision.current }
                  : { id: draftId.current, ...(source ? { source } : {}) }),
              }),
            },
          );
          const result = (await response.json()) as DraftView & {
            error?: string;
          };
          if (response.status === 409) {
            conflict.current = true;
            throw Error(result.error);
          }
          if (!response.ok || !result.id || !result.revision)
            throw Error(result.error ?? "Draft could not be saved.");
          const requested = JSON.parse(state);
          const sameContent =
            ["accountId", "to", "cc", "bcc", "subject", "plainText"].every(
              (key) => requested[key] === result[key as keyof DraftView],
            ) &&
            JSON.stringify(requested.richDocument) ===
              JSON.stringify(result.richDocument) &&
            JSON.stringify(
              requested.attachments.map((a: { id: string }) => a.id),
            ) === JSON.stringify(result.attachments.map((a) => a.id));
          if (!revision.current && result.revision > 1 && !sameContent) {
            conflict.current = true;
            throw Error(
              "This draft changed in another tab. Reopen it from Local drafts.",
            );
          }
          revision.current = result.revision;
          saved.current = sameContent ? state : "";
          backup();
        }
        setSaveState("Saved");
        setError("");
        try {
          localStorage.removeItem(`maildock-draft:${draftId.current}`);
        } catch {}
        onSaved?.();
      } catch (failure) {
        setSaveState("Save failed");
        setError(
          failure instanceof Error
            ? failure.message
            : "Draft could not be saved.",
        );
        throw failure;
      } finally {
        saving.current = null;
      }
    })();
    return saving.current;
  }
  const saveRef = useRef(save);
  saveRef.current = save;
  const backupRef = useRef(backup);
  backupRef.current = backup;
  useEffect(() => {
    backupRef.current();
    const timer = setTimeout(() => {
      void saveRef.current().catch(() => undefined);
    }, 1000);
    return () => clearTimeout(timer);
  }, [snapshot, signatureReady]);
  useEffect(() => {
    const flush = () => {
      backupRef.current();
      void saveRef.current().catch(() => undefined);
    };
    const hidden = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", hidden);
      flush();
    };
  }, []);
  async function close() {
    try {
      await save();
      onClose();
    } catch {
      /* Keep unsaved editor open. */
    }
  }
  async function discard() {
    stopped.current = true;
    try {
      await saving.current?.catch(() => undefined);
      if (revision.current) {
        const response = await fetch(`/api/drafts/${draftId.current}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedRevision: revision.current }),
        });
        if (!response.ok)
          throw Error(
            (await response.json()).error ?? "Draft could not be discarded.",
          );
      }
      localStorage.removeItem(`maildock-draft:${draftId.current}`);
      onClose();
    } catch (failure) {
      stopped.current = false;
      setError(failure instanceof Error ? failure.message : "Discard failed.");
    }
  }
  const attachmentsBlocked = attachments.some((a) => a.status !== "ready");
  useEffect(() => {
    const pending = attachments.filter(
      (a) =>
        a.kind === "incoming" && ["pending", "fetching"].includes(a.status),
    );
    if (!pending.length) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void Promise.all(
        pending.map(async (a) => {
          try {
            const response = await fetch(`/api/attachments/${a.id}`);
            if (!response.ok) throw Error();
            const result = (await response.json()) as Partial<AttachmentView>;
            if (!cancelled)
              setAttachments((current) =>
                current.map((item) =>
                  item.id === a.id
                    ? {
                        ...item,
                        status: result.status ?? "failed",
                        size: result.size ?? item.size,
                        error: result.error ?? null,
                      }
                    : item,
                ),
              );
          } catch {
            if (!cancelled)
              setAttachments((current) =>
                current.map((item) =>
                  item.id === a.id
                    ? {
                        ...item,
                        status: "failed",
                        error:
                          "Attachment status could not be loaded. Retry preparation.",
                      }
                    : item,
                ),
              );
          }
        }),
      );
    }, 2500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [attachments]);
  const uploadFile = useCallback(
    async (file: File, inline: boolean): Promise<AttachmentView | null> => {
      const temporaryId = crypto.randomUUID();
      setAttachments((current) => [
        ...current,
        {
          id: temporaryId,
          kind: "staged",
          filename: file.name,
          type: file.type,
          size: null,
          status: "uploading",
          error: null,
          visible: !inline,
          inline,
        },
      ]);
      try {
        const result = await uploadComposeFile(file, inline, draftId.current);
        setAttachments((current) =>
          current.map((a) =>
            a.id === temporaryId
              ? {
                  ...a,
                  ...result,
                  kind: "staged",
                  visible: !inline,
                  inline,
                }
              : a,
          ),
        );
        return { ...result, inline, visible: !inline };
      } catch (failure) {
        setAttachments((current) =>
          current.map((a) =>
            a.id === temporaryId
              ? {
                  ...a,
                  status: "failed",
                  error:
                    failure instanceof Error
                      ? failure.message
                      : "Attachment upload failed.",
                }
              : a,
          ),
        );
        return null;
      }
    },
    [],
  );
  async function upload(files: FileList | null) {
    if (!files) return;
    for (const file of Array.from(files)) await uploadFile(file, false);
    if (fileRef.current) fileRef.current.value = "";
  }
  async function retryAttachment(a: AttachmentView) {
    setAttachments((current) =>
      current.map((item) =>
        item.id === a.id ? { ...item, status: "pending", error: null } : item,
      ),
    );
    try {
      const response = await fetch(`/api/attachments/${a.id}`, {
        method: "POST",
      });
      if (!response.ok) throw Error();
    } catch {
      setAttachments((current) =>
        current.map((item) =>
          item.id === a.id
            ? {
                ...item,
                status: "failed",
                error: "Attachment could not be prepared.",
              }
            : item,
        ),
      );
    }
  }
  function removeAttachment(id: string) {
    const item = attachments.find((a) => a.id === id);
    setAttachments((current) => current.filter((a) => a.id !== id));
    if (item?.kind === "staged" && item.status === "ready")
      void fetch(`/api/attachments/staged/${id}`, { method: "DELETE" }).catch(
        () => undefined,
      );
  }
  async function send(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || attachmentsBlocked) return;
    if (
      !from ||
      ![to, cc, bcc].some((value) => value.trim()) ||
      [to, cc, bcc, subject].some((value) => /[\r\n\x00]/.test(value))
    ) {
      setError(
        "Select a sending account and enter at least one recipient. Headers must not contain line breaks.",
      );
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await save();
      if (!revision.current || conflict.current)
        throw Error("Save the draft before sending.");
      const response = await fetch(`/api/drafts/${draftId.current}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: revision.current }),
      });
      const result = (await response.json()) as { id?: string; error?: string };
      if (!response.ok || !result.id)
        throw Error(result.error ?? "Message could not be queued.");
      stopped.current = true;
      localStorage.removeItem(`maildock-draft:${draftId.current}`);
      onQueued(result.id);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Message could not be queued.",
      );
      setSubmitting(false);
    }
  }
  return (
    <form
      className="mail-composer"
      onSubmit={(event) => void send(event)}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        if (submitting || !e.dataTransfer.files.length) return;
        e.preventDefault();
        void upload(e.dataTransfer.files);
      }}
    >
      <div className="mail-detail-header composer-heading">
        <h2>
          {source
            ? { reply: "Reply", reply_all: "Reply all", forward: "Forward" }[
                source.mode
              ]
            : "New message"}
        </h2>
        <button
          className="icon-button"
          type="button"
          aria-label="Close composer"
          disabled={
            submitting || attachments.some((a) => a.status === "uploading")
          }
          onClick={() => void close()}
        >
          <X size={18} />
        </button>
      </div>
      <fieldset disabled={submitting} className="composer-fields">
        <label>
          From
          <select
            aria-label="From"
            disabled={!signatureReady}
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            required
          >
            {selectable.length ? (
              selectable.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.displayName} &lt;{account.email}&gt;
                </option>
              ))
            ) : (
              <option value="">No sending account available</option>
            )}
          </select>
        </label>
        <label>
          To
          <input
            aria-label="To"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            maxLength={8000}
            placeholder="Name <email@example.com>"
          />
        </label>
        <label>
          Cc
          <input
            aria-label="Cc"
            value={cc}
            onChange={(event) => setCc(event.target.value)}
            maxLength={8000}
          />
        </label>
        <label>
          Bcc
          <input
            aria-label="Bcc"
            value={bcc}
            onChange={(event) => setBcc(event.target.value)}
            maxLength={8000}
          />
        </label>
        <label>
          Subject
          <input
            aria-label="Subject"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            maxLength={998}
          />
        </label>
        <RichComposer
          initialDocument={richDocument}
          onChange={setRichDocument}
          onError={setError}
          onValidation={setEditorValid}
          upload={uploadFile}
          disabled={submitting}
          draftId={draftId.current}
          revision={revision.current}
          signatureOptions={{
            accountId: from,
            mode:
              source?.mode === "forward" ? "forward" : source ? "reply" : "new",
            initialize: !draft,
            onResources: addSignatureResources,
            onReady: setSignatureReady,
          }}
        />
      </fieldset>
      <div className="composer-attachments">
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          aria-label="Select attachments"
          disabled={submitting}
          onChange={(event) => void upload(event.target.files)}
        />
        <button
          type="button"
          className="button secondary"
          disabled={submitting}
          onClick={() => fileRef.current?.click()}
        >
          <Paperclip size={15} /> Attach files
        </button>
        {attachments
          .filter(
            (a) =>
              !a.inline || a.status === "failed" || a.status === "uploading",
          )
          .map((a) => (
            <div key={a.id} className="mail-attachment">
              <Paperclip size={13} />
              <span>
                {a.filename || "Attachment"} · {attachmentSize(a.size)}{" "}
                {a.status === "uploading"
                  ? "Uploading…"
                  : ["pending", "fetching"].includes(a.status)
                    ? "Preparing attachment…"
                    : ""}
              </span>
              {a.error ? (
                <span role="alert" className="error">
                  {a.error}
                </span>
              ) : null}
              {a.kind === "incoming" &&
              ["failed", "not_fetched"].includes(a.status) ? (
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => void retryAttachment(a)}
                >
                  Retry preparation
                </button>
              ) : null}
              <button
                type="button"
                disabled={submitting || a.status === "uploading"}
                aria-label={`Remove ${a.filename || "attachment"}`}
                onClick={() => removeAttachment(a.id)}
              >
                Remove
              </button>
            </div>
          ))}
      </div>
      <div className="composer-footer">
        {error ? (
          <p role="alert" className="error">
            {error}
          </p>
        ) : null}
        <div className="composer-footer-actions">
          <button
            className="button secondary"
            type="button"
            disabled={submitting}
            onClick={() => void discard()}
          >
            Discard
          </button>
          {saveState === "Save failed" && !conflict.current ? (
            <button
              className="button secondary"
              type="button"
              onClick={() => void save().catch(() => undefined)}
            >
              Retry save
            </button>
          ) : null}
          <button
            className="button"
            type="submit"
            disabled={
              submitting ||
              !from ||
              attachmentsBlocked ||
              !editorValid ||
              !signatureReady
            }
          >
            <Send size={15} />
            {submitting ? "Queueing…" : "Send"}
          </button>
          <small className="composer-save-status" role="status">
            {saveState}
          </small>
        </div>
      </div>
    </form>
  );
}
