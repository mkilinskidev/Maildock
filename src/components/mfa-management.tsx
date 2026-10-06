"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { QRCodeSVG } from "qrcode.react";

function useSensitiveState<T>() {
  const [value, setValue] = useState<T>();
  useEffect(() => {
    const clear = () => setValue(undefined);
    window.addEventListener("pagehide", clear);
    return () => window.removeEventListener("pagehide", clear);
  }, []);
  return [value, setValue] as const;
}

async function post(path: string, body: object) {
  const response = await fetch(`/api/auth/mfa/manage/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error("MFA request rejected");
  return response.json() as Promise<{
    recoveryCodes?: string[];
    totpURI?: string;
    replacementStarted?: boolean;
    completed?: boolean;
  }>;
}

function RecoveryCodes({
  codes,
  close,
  freshLogin = false,
  compact = false,
  titleId,
}: {
  codes: string[];
  close: () => void;
  freshLogin?: boolean;
  compact?: boolean;
  titleId?: string;
}) {
  const [copyStatus, setCopyStatus] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (compact) heading.current?.focus();
  }, [compact]);
  return (
    <section
      className={compact ? "mfa-code-presentation" : "auth-card"}
      aria-label="Recovery codes"
    >
      <h2 id={titleId} ref={heading} tabIndex={compact ? -1 : undefined}>
        Save your new recovery codes
      </h2>
      <p>
        All previous recovery codes are invalid. These codes are shown only{" "}
        {compact ? "once" : "now"}. Store them somewhere safe outside Maildock.
      </p>
      {compact ? (
        <div
          className="mfa-code-grid"
          role="group"
          aria-label="New recovery codes"
        >
          {codes.map((code) => (
            <code key={code}>{code}</code>
          ))}
        </div>
      ) : (
        <pre className="mfa-recovery-codes">{codes.join("\n")}</pre>
      )}
      {compact && (
        <p className="mfa-copy-status" role="status">
          {copyStatus}
        </p>
      )}
      <div className={compact ? "mfa-dialog-actions" : "mfa-recovery-actions"}>
        <button
          className={compact ? "button secondary" : "button"}
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(codes.join("\n"));
              setCopyStatus("Copied");
            } catch {
              setCopyStatus("Select and copy the codes manually.");
            }
          }}
        >
          Copy all
        </button>
        {!compact && <p role="status">{copyStatus}</p>}
        {freshLogin && (
          <p>
            Sign in again with your password and new authenticator or recovery
            code.
          </p>
        )}
        <button className="button" type="button" onClick={close}>
          {freshLogin ? "Continue to login" : compact ? "Done" : "Close"}
        </button>
      </div>
    </section>
  );
}

function ManagementDialog({
  titleId,
  protectedState,
  close,
  trigger,
  children,
}: {
  titleId: string;
  protectedState: boolean;
  close: () => void;
  trigger: RefObject<HTMLButtonElement | null>;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    const opener = trigger.current;
    element.showModal();
    return () => {
      element.close();
      opener?.focus();
    };
  }, [trigger]);
  return (
    <dialog
      ref={dialog}
      className="mfa-management-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!protectedState) close();
      }}
    >
      {children}
    </dialog>
  );
}

export function MfaManagement() {
  const [action, setAction] = useState<"recovery" | "replace">();
  const [proofType, setProofType] = useState("totp");
  const [codes, setCodes] = useSensitiveState<string[]>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  function open(next: "recovery" | "replace", button: HTMLButtonElement) {
    trigger.current = button;
    setError("");
    setProofType("totp");
    setAction(next);
  }
  function close() {
    setAction(undefined);
    setCodes(undefined);
    setError("");
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setPending(true);
    setError("");
    try {
      const result = await post(
        action === "recovery" ? "recovery/regenerate" : "authenticator/start",
        {
          password: data.get("password"),
          proofType,
          proofCode: data.get("proofCode"),
        },
      );
      if (action === "replace" && result.replacementStarted)
        window.location.replace("/replace-authenticator");
      else if (action === "recovery" && result.recoveryCodes) {
        setCodes(result.recoveryCodes);
        setAction(undefined);
      } else throw new Error("Invalid response");
    } catch {
      setError(
        "MFA management could not be completed. Check your details and try again.",
      );
    } finally {
      form.reset();
      setPending(false);
    }
  }
  return (
    <section className="mfa-settings" aria-label="Two-factor authentication">
      <header className="settings-pane-header">
        <h2>Two-factor authentication</h2>
        <p>
          Protect your Maildock account with an authenticator app and recovery
          codes.
        </p>
      </header>
      <section
        className="mfa-settings-card"
        aria-labelledby="mfa-authenticator-title"
      >
        <div className="mfa-card-header">
          <h3 id="mfa-authenticator-title">Authenticator</h3>
          <span className="status-pill">Enabled</span>
        </div>
        <p>An authenticator code is required when you sign in.</p>
        <div className="mfa-card-actions">
          <button
            className="button secondary"
            onClick={(event) => open("replace", event.currentTarget)}
          >
            Replace authenticator
          </button>
        </div>
      </section>
      <section
        className="mfa-settings-card"
        aria-labelledby="mfa-recovery-title"
      >
        <div className="mfa-card-header">
          <h3 id="mfa-recovery-title">Recovery codes</h3>
          <span className="status-pill">Configured</span>
        </div>
        <p>
          Use recovery codes if you lose access to your authenticator. Each code
          can only be used once.
        </p>
        <div className="mfa-card-actions">
          <button
            className="button secondary"
            onClick={(event) => open("recovery", event.currentTarget)}
          >
            Generate new recovery codes
          </button>
        </div>
      </section>
      {(action || codes) && (
        <ManagementDialog
          titleId={titleId}
          protectedState={pending || Boolean(codes)}
          close={close}
          trigger={trigger}
        >
          {codes ? (
            <RecoveryCodes
              codes={codes}
              compact
              titleId={titleId}
              close={close}
            />
          ) : (
            <form
              onSubmit={submit}
              className="mfa-management-form"
              autoComplete="off"
              aria-busy={pending}
            >
              <h2 id={titleId}>
                {action === "recovery"
                  ? "Generate new recovery codes"
                  : "Replace authenticator"}
              </h2>
              <p>
                {action === "replace"
                  ? "Your current authenticator and recovery codes will stop working, and all sessions will be signed out. You will need to set up a new authenticator and sign in again."
                  : "Your existing recovery codes will stop working immediately."}
              </p>
              {action === "replace" && (
                <p className="mfa-dialog-help">
                  Complete setup in this browser within 10 minutes. If you leave
                  or run out of time, Maildock stays locked and may require
                  operator intervention.
                </p>
              )}
              <fieldset className="mfa-dialog-fields" disabled={pending}>
                <label>
                  Current password
                  <input
                    name="password"
                    type="password"
                    minLength={12}
                    maxLength={128}
                    required
                    autoComplete="off"
                    autoFocus
                  />
                </label>
                <label>
                  Verification method
                  <select
                    value={proofType}
                    onChange={(event) => setProofType(event.target.value)}
                    disabled={pending}
                  >
                    <option value="totp">Authenticator code</option>
                    <option value="recovery">Recovery code</option>
                  </select>
                </label>
                <label>
                  {proofType === "totp"
                    ? "Current authenticator code"
                    : "Current recovery code"}
                  <input
                    key={proofType}
                    name="proofCode"
                    autoComplete="off"
                    spellCheck={false}
                    required
                    inputMode={proofType === "totp" ? "numeric" : "text"}
                    pattern={
                      proofType === "totp"
                        ? "[0-9]{6}"
                        : "[a-zA-Z0-9]{5}-[a-zA-Z0-9]{5}"
                    }
                    maxLength={proofType === "totp" ? 6 : 11}
                  />
                </label>
              </fieldset>
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <div className="mfa-dialog-actions">
                <button
                  className="button secondary"
                  type="button"
                  disabled={pending}
                  onClick={close}
                >
                  Cancel
                </button>
                <button
                  className={action === "replace" ? "button danger" : "button"}
                  disabled={pending}
                >
                  {pending
                    ? "Please wait…"
                    : action === "replace"
                      ? "Replace authenticator"
                      : "Generate codes"}
                </button>
              </div>
            </form>
          )}
        </ManagementDialog>
      )}
    </section>
  );
}

export function ReplacementEnrollment() {
  const [uri, setUri] = useSensitiveState<string>();
  const [codes, setCodes] = useSensitiveState<string[]>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setPending(true);
    setError("");
    try {
      const result = await post(
        uri ? "authenticator/complete" : "authenticator/resume",
        uri ? { code: data.get("code") } : {},
      );
      if (uri && result.completed && result.recoveryCodes) {
        setUri(undefined);
        setCodes(result.recoveryCodes);
      } else if (!uri && result.totpURI) {
        const parsed = new URL(result.totpURI);
        if (
          parsed.protocol !== "otpauth:" ||
          parsed.hostname !== "totp" ||
          !parsed.searchParams.get("secret")
        )
          throw new Error("Invalid response");
        setUri(result.totpURI);
      } else throw new Error("Invalid response");
    } catch {
      setError(
        "Replacement could not be completed. Check your code. If the replacement authority expired or is unavailable, operator intervention is required. Maildock remains locked.",
      );
    } finally {
      form.reset();
      setPending(false);
    }
  }
  if (codes)
    return (
      <RecoveryCodes
        codes={codes}
        freshLogin
        close={() => {
          setCodes(undefined);
          window.location.replace("/login");
        }}
      />
    );
  return (
    <form onSubmit={submit} className="auth-card" autoComplete="off">
      {uri ? (
        <>
          <p>
            Scan the new QR code, then enter a code from the new authenticator.
          </p>
          <QRCodeSVG
            value={uri}
            className="mfa-qr"
            size={232}
            marginSize={4}
            title="New authenticator QR code"
            role="img"
            aria-label="New authenticator QR code"
          />
          <label>
            Manual setup key
            <code className="mfa-secret">
              {new URL(uri).searchParams.get("secret")}
            </code>
          </label>
          <label>
            New authenticator code
            <input
              name="code"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              autoComplete="one-time-code"
            />
          </label>
        </>
      ) : (
        <p>
          Resume the authorized replacement in this browser. Your old
          authenticator and recovery codes are invalid. Replacement expires 10
          minutes after it starts.
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button className="button" disabled={pending}>
        {pending
          ? "Please wait…"
          : uri
            ? "Confirm new authenticator"
            : "Resume replacement"}
      </button>
    </form>
  );
}
