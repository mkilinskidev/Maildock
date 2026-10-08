"use client";

import { FormEvent, useState } from "react";

export function LoginForm() {
  const [step, setStep] = useState<"password" | "totp" | "recovery">(
    "password",
  );
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  async function backToPassword() {
    setPending(true);
    setError(undefined);
    try {
      const response = await fetch("/api/auth/mfa/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Cancellation failed");
      setStep("password");
    } catch {
      setError("Sign in is temporarily unavailable. Please try again.");
    } finally {
      setPending(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setPending(true);
    setError(undefined);
    try {
      const response = await fetch(
        step === "password"
          ? "/api/auth/sign-in/username"
          : `/api/auth/mfa/${step}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
          body: JSON.stringify(
            step === "password"
              ? {
                  username: data.get("username"),
                  password: data.get("password"),
                  rememberMe: false,
                }
              : { code: data.get("code") },
          ),
        },
      );
      form.reset();
      const result = (await response.json()) as {
        twoFactorRedirect?: boolean;
        restart?: boolean;
        ownerRecoveryRequired?: boolean;
      };
      if (response.ok) {
        if (result.ownerRecoveryRequired) {
          window.location.replace("/owner-recovery-mfa");
          return;
        }
        if (step === "password" && result.twoFactorRedirect) {
          setStep("totp");
          return;
        }
        // The server login page selects enrollment or the business landing page.
        // Full navigation discards ephemeral credential/code state.
        window.location.replace("/login");
        return;
      }
      if (result.restart) setStep("password");
      setError(
        response.status === 429
          ? "Too many attempts. Try again later."
          : result.restart
            ? "Please sign in again."
            : "Sign in could not be completed. Check your details and try again.",
      );
    } catch {
      form.reset();
      setError("Sign in is temporarily unavailable. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form key={step} onSubmit={submit} className="auth-card">
      {step === "password" ? (
        <>
          <label>
            Username
            <input name="username" required autoComplete="username" />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              required
              autoComplete="current-password"
            />
          </label>
        </>
      ) : (
        <>
          <p className="muted auth-help">
            {step === "totp"
              ? "Enter the six-digit code from your authenticator."
              : "Enter one of your saved recovery codes. Each code can be used once."}
          </p>
          <label>
            {step === "totp" ? "Authenticator code" : "Recovery code"}
            <input
              name="code"
              required
              autoFocus
              inputMode={step === "totp" ? "numeric" : "text"}
              autoComplete={step === "totp" ? "one-time-code" : "off"}
              spellCheck={false}
              pattern={
                step === "totp" ? "[0-9]{6}" : "[a-zA-Z0-9]{5}-[a-zA-Z0-9]{5}"
              }
              minLength={step === "totp" ? 6 : 11}
              maxLength={step === "totp" ? 6 : 11}
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
        {pending ? "Please wait…" : step === "password" ? "Sign in" : "Verify"}
      </button>
      {step !== "password" && (
        <>
          <button
            type="button"
            className="button"
            disabled={pending}
            onClick={() => {
              setStep(step === "totp" ? "recovery" : "totp");
              setError(undefined);
            }}
          >
            {step === "totp" ? "Use a recovery code" : "Use authenticator code"}
          </button>
          <button
            type="button"
            className="button"
            disabled={pending}
            onClick={backToPassword}
          >
            Back to password
          </button>
        </>
      )}
    </form>
  );
}
