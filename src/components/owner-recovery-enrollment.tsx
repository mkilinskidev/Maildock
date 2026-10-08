"use client";
import { useEffect, useState, type FormEvent } from "react";
import { QRCodeSVG } from "qrcode.react";

export function OwnerRecoveryEnrollment() {
  const [uri, setURI] = useState<string>();
  const [codes, setCodes] = useState<string[]>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  useEffect(() => {
    const clear = () => {
      setURI(undefined);
      setCodes(undefined);
    };
    window.addEventListener("pagehide", clear);
    return () => window.removeEventListener("pagehide", clear);
  }, []);
  async function operation(
    kind: "resume" | "complete" | "cancel",
    code?: string,
  ) {
    setPending(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/auth/owner-recovery/${kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(code === undefined ? {} : { code }),
        cache: "no-store",
      });
      if (!response.ok)
        throw new Error(
          "Recovery enrollment could not be completed. Sign in again if the ceremony has expired; wait if attempts are limited.",
        );
      const result = await response.json();
      if (kind === "resume") {
        const parsed = new URL(result.totpURI);
        if (
          parsed.protocol !== "otpauth:" ||
          parsed.hostname !== "totp" ||
          !parsed.searchParams.get("secret")
        )
          throw new Error("Invalid enrollment response");
        setURI(result.totpURI);
      }
      if (kind === "complete") {
        if (
          !result.completed ||
          !result.freshLoginRequired ||
          !Array.isArray(result.recoveryCodes) ||
          !result.recoveryCodes.every(
            (value: unknown) =>
              typeof value === "string" &&
              /^[a-zA-Z0-9]{5}-[a-zA-Z0-9]{5}$/.test(value),
          )
        )
          throw new Error("Invalid completion response");
        setURI(undefined);
        setCodes(result.recoveryCodes);
      }
      if (kind === "cancel") window.location.replace("/login");
    } catch {
      setError(
        "Recovery enrollment could not be completed. Sign in again if the ceremony has expired; wait if attempts are limited.",
      );
    } finally {
      setPending(false);
    }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = new FormData(event.currentTarget).get("code") as string;
    event.currentTarget.reset();
    void operation("complete", code);
  }
  if (codes)
    return (
      <div className="auth-card">
        <h2>Save your recovery codes</h2>
        <p>
          Save these new recovery codes privately. Each code can be used once.
        </p>
        <pre className="mfa-recovery-codes">{codes.join("\n")}</pre>
        <a className="button" href="/login">
          I saved my codes — sign in again
        </a>
      </div>
    );
  return (
    <div className="auth-card">
      <p>
        Owner recovery requires a new authenticator before opening your inbox.
      </p>
      {uri ? (
        <>
          <QRCodeSVG
            className="mfa-qr"
            aria-label="Authenticator setup QR code"
            value={uri}
          />
          <label>
            Manual setup key
            <code className="mfa-secret">
              {new URL(uri).searchParams.get("secret")}
            </code>
          </label>
          <form onSubmit={submit}>
            <label>
              Authenticator code
              <input
                name="code"
                required
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                minLength={6}
                maxLength={6}
              />
            </label>
            <button className="button" disabled={pending}>
              Verify authenticator
            </button>
          </form>
        </>
      ) : (
        <button
          className="button"
          disabled={pending}
          onClick={() => void operation("resume")}
        >
          Show authenticator setup
        </button>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <a href="/login">Sign in again</a>
      <button
        className="button"
        disabled={pending}
        onClick={() => void operation("cancel")}
      >
        Cancel enrollment
      </button>
    </div>
  );
}
