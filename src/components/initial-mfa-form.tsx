"use client";

import { FormEvent, useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";

type Enrollment = { totpURI: string; bootstrapSecret: string };

export function InitialMfaForm() {
  const [enrollment, setEnrollment] = useState<Enrollment>();
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const clear = () => {
      setEnrollment(undefined);
      setRecoveryCodes(undefined);
      setCopied(false);
    };
    window.addEventListener("pagehide", clear);
    return () => window.removeEventListener("pagehide", clear);
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const bootstrapSecret =
      enrollment?.bootstrapSecret ?? String(data.get("bootstrapSecret"));
    setPending(true);
    setError(undefined);
    try {
      const response = await fetch(
        enrollment
          ? "/api/auth/initial-mfa/complete"
          : "/api/auth/initial-mfa/start",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
          body: JSON.stringify(
            enrollment
              ? { bootstrapSecret, code: data.get("code") }
              : { bootstrapSecret, password: data.get("password") },
          ),
        },
      );
      form.reset();
      if (!response.ok) {
        setError(
          response.status === 429
            ? "Too many attempts. Try again later."
            : "Setup could not be completed. Check your details and try again.",
        );
        return;
      }
      const result = (await response.json()) as {
        totpURI?: string;
        recoveryCodes?: string[];
        completed?: boolean;
      };
      if (enrollment && result.completed && result.recoveryCodes) {
        setEnrollment(undefined);
        setRecoveryCodes(result.recoveryCodes);
      } else if (!enrollment && result.totpURI) {
        const uri = new URL(result.totpURI);
        if (
          uri.protocol !== "otpauth:" ||
          uri.hostname !== "totp" ||
          !uri.searchParams.get("secret")
        )
          throw new Error("Invalid enrollment response");
        setEnrollment({ totpURI: result.totpURI, bootstrapSecret });
      } else throw new Error("Invalid enrollment response");
    } catch {
      form.reset();
      setError(
        "Setup could not be completed. Try again, or sign in again to resume.",
      );
    } finally {
      setPending(false);
    }
  }

  async function copyCodes() {
    try {
      await navigator.clipboard.writeText(recoveryCodes!.join("\n"));
      setCopied(true);
    } catch {
      setError("Copy is unavailable. Select and copy the codes manually.");
    }
  }

  if (recoveryCodes)
    return (
      <section className="auth-card" aria-label="Recovery codes">
        <h2>Save your recovery codes</h2>
        <p className="muted auth-help">
          Keep these codes somewhere safe outside Maildock. Each code can be
          used once with your password if your authenticator is unavailable.
          These codes are shown only now.
        </p>
        <pre className="mfa-recovery-codes">{recoveryCodes.join("\n")}</pre>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="button" className="button" onClick={copyCodes}>
          {copied ? "Copied" : "Copy all codes"}
        </button>
        <p className="muted auth-help">
          Setup is complete. Sign in again using your password and
          authenticator.
        </p>
        <button
          type="button"
          className="button"
          onClick={() => {
            setRecoveryCodes(undefined);
            window.location.replace("/login");
          }}
        >
          Continue to login
        </button>
      </section>
    );

  return (
    <form onSubmit={submit} className="auth-card" autoComplete="off">
      {enrollment ? (
        <>
          <p className="muted auth-help">
            Scan this QR code with your authenticator app, then enter its
            six-digit code.
          </p>
          <QRCodeSVG
            className="mfa-qr"
            value={enrollment.totpURI}
            size={232}
            marginSize={4}
            title="Authenticator setup QR code"
            role="img"
            aria-label="Authenticator setup QR code"
          />
          <label>
            Manual setup key
            <code className="mfa-secret">
              {new URL(enrollment.totpURI).searchParams.get("secret")}
            </code>
          </label>
          <p className="muted auth-help">
            Time-based code · 6 digits · 30 seconds
          </p>
          <label>
            Authenticator code
            <input
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              minLength={6}
              maxLength={6}
              required
              autoFocus
            />
          </label>
        </>
      ) : (
        <>
          <label>
            Setup secret
            <input
              name="bootstrapSecret"
              type="password"
              required
              minLength={44}
              maxLength={44}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <p className="muted auth-help">
            Use the setup secret from the Maildock container logs. Keep it until
            authenticator setup is complete. Reloading requires entering it
            again.
          </p>
          <label>
            Owner password
            <input
              name="password"
              type="password"
              required
              minLength={12}
              maxLength={128}
              autoComplete="off"
            />
          </label>
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button className="button" disabled={pending}>
        {pending
          ? "Please wait…"
          : enrollment
            ? "Confirm authenticator"
            : "Start or resume setup"}
      </button>
      {enrollment && (
        <button
          type="button"
          className="button"
          disabled={pending}
          onClick={() => {
            setEnrollment(undefined);
            setError(undefined);
          }}
        >
          Restart setup
        </button>
      )}
      <a href="/login">Return to sign in</a>
    </form>
  );
}
