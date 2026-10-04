"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { RichComposer } from "./rich-composer";
import { uploadComposeFile } from "./compose-upload";
import {
  plainTextDocument,
  type RichDocument,
} from "@/modules/mail/domain/rich-document";
import type {
  SignatureCatalog,
  SignatureDefaults,
} from "@/modules/mail/domain/signature";

async function signatureRequest(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  if (response.status === 204) return null;
  const result = await response.json();
  if (!response.ok) throw Error(result.error ?? "Signature operation failed.");
  return result;
}
type EditSignature = {
  id: string;
  name: string;
  revision?: number;
  richDocument: RichDocument;
};
export function SignatureSettings({
  onDirtyChange,
  onBusyChange,
}: {
  onDirtyChange?: (value: boolean) => void;
  onBusyChange?: (value: boolean) => void;
} = {}) {
  const router = useRouter();
  const [catalog, setCatalog] = useState<SignatureCatalog>();
  const [edit, setEdit] = useState<EditSignature>();
  const [error, setError] = useState("");
  const [valid, setValid] = useState(true);
  const [pending, setPending] = useState(false);
  const [uploads, setUploads] = useState(0);
  useEffect(() => {
    onDirtyChange?.(!!edit);
    return () => onDirtyChange?.(false);
  }, [edit, onDirtyChange]);
  useEffect(() => {
    onBusyChange?.(pending || uploads > 0);
    return () => onBusyChange?.(false);
  }, [pending, uploads, onBusyChange]);
  const editId = edit?.id;
  const updateDocument = useCallback(
    (richDocument: RichDocument) =>
      setEdit((current) => (current ? { ...current, richDocument } : current)),
    [],
  );
  const uploadImage = useCallback(
    async (file: File, inline: boolean) => {
      if (!inline || !editId) {
        setError("Signatures support inline images only.");
        return null;
      }
      setUploads((n) => n + 1);
      try {
        return await uploadComposeFile(file, true, editId);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Image upload failed.");
        return null;
      } finally {
        setUploads((n) => n - 1);
      }
    },
    [editId],
  );
  async function load() {
    setCatalog(await signatureRequest("/api/signatures"));
  }
  useEffect(() => {
    void signatureRequest("/api/signatures")
      .then(setCatalog)
      .catch((e) => setError(e.message));
  }, []);
  async function mutate(action: () => Promise<void>) {
    setPending(true);
    setError("");
    try {
      await action();
      await load();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Signature operation failed.");
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="account-card signature-settings">
      <div className="signature-section-header">
        <h2>Signatures</h2>
        <button
          type="button"
          className="button secondary"
          disabled={pending || !!edit}
          onClick={() => {
            setValid(true);
            setError("");
            setEdit({
              id: crypto.randomUUID(),
              name: "",
              richDocument: plainTextDocument(""),
            });
          }}
        >
          + Add signature
        </button>
      </div>
      <div className="signature-list">
        {catalog?.signatures.map((s) => (
          <div className="signature-row" key={s.id}>
            <span className="signature-name">{s.name}</span>
            <div className="signature-row-actions">
              <button
                className="button secondary"
                type="button"
                disabled={pending || !!edit}
                onClick={() =>
                  void mutate(async () => {
                    setValid(true);
                    setEdit(await signatureRequest(`/api/signatures/${s.id}`));
                  })
                }
              >
                Edit
              </button>{" "}
              <button
                className="button secondary signature-delete"
                type="button"
                disabled={pending || !!edit}
                onClick={() => {
                  if (
                    window.confirm(
                      `Delete signature “${s.name}”? Existing drafts will keep their copies.`,
                    )
                  )
                    void mutate(async () => {
                      const definition = await signatureRequest(
                        `/api/signatures/${s.id}`,
                      );
                      await signatureRequest(`/api/signatures/${s.id}`, {
                        method: "DELETE",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          expectedRevision: definition.revision,
                        }),
                      });
                    });
                }}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
      {edit ? (
        <div className="signature-editor">
          <label>
            Signature name{" "}
            <input
              value={edit.name}
              maxLength={100}
              disabled={pending}
              onChange={(e) => setEdit({ ...edit, name: e.target.value })}
            />
          </label>
          <div className="signature-editor-frame">
            <RichComposer
              key={edit.id}
              initialDocument={edit.richDocument}
              onChange={updateDocument}
              onError={setError}
              onValidation={setValid}
              draftId={edit.id}
              revision={edit.revision ?? 0}
              disabled={pending}
              upload={uploadImage}
            />
            <div className="signature-editor-actions">
              <button
                className="button"
                type="button"
                disabled={pending || uploads > 0 || !valid || !edit.name.trim()}
                onClick={() =>
                  void mutate(async () => {
                    await signatureRequest(
                      edit.revision
                        ? `/api/signatures/${edit.id}`
                        : "/api/signatures",
                      {
                        method: edit.revision ? "PATCH" : "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          ...(edit.revision
                            ? { expectedRevision: edit.revision }
                            : { id: edit.id }),
                          name: edit.name,
                          richDocument: edit.richDocument,
                        }),
                      },
                    );
                    setEdit(undefined);
                  })
                }
              >
                Save signature
              </button>{" "}
              <button
                className="button secondary"
                type="button"
                disabled={pending || uploads > 0}
                onClick={() => setEdit(undefined)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
export function AccountSignatureSettings({
  accountId,
  initialCatalog,
}: {
  accountId: string;
  initialCatalog?: SignatureCatalog;
}) {
  const [catalog, setCatalog] = useState<SignatureCatalog>();
  const [values, setValues] = useState<SignatureDefaults>({
    new: null,
    reply: null,
    forward: null,
  });
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    void (
      initialCatalog
        ? Promise.resolve(initialCatalog)
        : signatureRequest("/api/signatures")
    )
      .then((result: SignatureCatalog) => {
        setCatalog(result);
        setValues(
          result.defaults[accountId] ?? {
            new: null,
            reply: null,
            forward: null,
          },
        );
      })
      .catch((e) => setError(e.message));
  }, [accountId, initialCatalog]);
  return (
    <div className="account-signature-settings">
      <h3>Signatures</h3>
      <div className="account-signature-grid">
        {(
          [
            ["new", "New messages"],
            ["reply", "Replies"],
            ["forward", "Forwards"],
          ] as const
        ).map(([mode, label]) => (
          <label key={mode}>
            {label}{" "}
            <select
              aria-label={`${label} signature`}
              value={values[mode] ?? ""}
              disabled={pending || !catalog}
              onChange={(e) => {
                const next = { ...values, [mode]: e.target.value || null };
                setPending(true);
                setError("");
                void signatureRequest(`/api/accounts/${accountId}/signatures`, {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(next),
                })
                  .then(() => setValues(next))
                  .catch((e) => setError(e.message))
                  .finally(() => setPending(false));
              }}
            >
              <option value="">None</option>
              {catalog?.signatures.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>{" "}
          </label>
        ))}
      </div>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
