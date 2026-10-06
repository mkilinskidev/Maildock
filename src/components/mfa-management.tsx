"use client";

import { useEffect, useState, type FormEvent } from "react";
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
}: {
  codes: string[];
  close: () => void;
  freshLogin?: boolean;
}) {
  const [copyStatus, setCopyStatus] = useState("");
  return (
    <section className="auth-card" aria-label="Recovery codes">
      <h2>Save your new recovery codes</h2>
      <p>
        All previous recovery codes are invalid. These codes are shown only now.
        Store them somewhere safe outside Maildock.
      </p>
      <pre className="mfa-recovery-codes">{codes.join("\n")}</pre>
      <button
        className="button"
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
      <p role="status">{copyStatus}</p>
      {freshLogin && (
        <p>
          Sign in again with your password and new authenticator or recovery
          code.
        </p>
      )}
      <button className="button" type="button" onClick={close}>
        {freshLogin ? "Continue to login" : "Close"}
      </button>
    </section>
  );
}

export function MfaManagement() {
  const [action, setAction] = useState<"recovery" | "replace">();
  const [proofType, setProofType] = useState("totp");
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
  if (codes)
    return <RecoveryCodes codes={codes} close={() => setCodes(undefined)} />;
  return (
    <section
      className="settings-section"
      aria-label="Two-factor authentication"
    >
      <h2>Two-factor authentication</h2>
      <p>Authenticator: enabled</p>
      <p>Recovery codes: configured</p>
      {!action ? (
        <>
          <button
            className="button"
            onClick={() => {
              setError("");
              setAction("recovery");
            }}
          >
            Generate new recovery codes
          </button>
          <button
            className="button"
            onClick={() => {
              setError("");
              setAction("replace");
            }}
          >
            Replace authenticator
          </button>
        </>
      ) : (
        <form onSubmit={submit} className="auth-card" autoComplete="off">
          <h3>
            {action === "recovery"
              ? "Generate new recovery codes"
              : "Replace authenticator"}
          </h3>
          {action === "replace" && (
            <p>
              Starting replacement invalidates your authenticator and recovery
              codes and signs out all sessions. Finish in this browser within 10
              minutes. If you leave or the authority expires, Maildock stays
              locked and may require operator intervention.
            </p>
          )}
          <label>
            Owner password
            <input
              name="password"
              type="password"
              minLength={12}
              maxLength={128}
              required
              autoComplete="off"
            />
          </label>
          <label>
            Current MFA proof
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
            {proofType === "totp" ? "Authenticator code" : "Recovery code"}
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
          <button className="button" disabled={pending}>
            {pending ? "Please wait…" : "Confirm"}
          </button>
          <button
            className="button"
            type="button"
            disabled={pending}
            onClick={() => {
              setAction(undefined);
              setError("");
            }}
          >
            Cancel
          </button>
        </form>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
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
