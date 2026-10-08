"use client";

import { FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff } from "lucide-react";

import {
  ownerUsernameMaxLength,
  ownerUsernameMinLength,
} from "@/modules/auth/domain/owner-username";

export function SetupForm() {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [confirmationError, setConfirmationError] = useState<string>();
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const confirmation = useRef<HTMLInputElement>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    const data = new FormData(event.currentTarget);
    const confirmedPassword = confirmation.current?.value;
    if (!confirmedPassword || data.get("password") !== confirmedPassword) {
      setConfirmationError(
        confirmedPassword
          ? "Passwords do not match."
          : "Please confirm your password.",
      );
      confirmation.current?.focus();
      return;
    }
    setConfirmationError(undefined);
    setPending(true);
    try {
      const response = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bootstrapSecret: data.get("bootstrapSecret"),
          username: data.get("username"),
          password: data.get("password"),
        }),
      });
      if (response.ok) {
        router.replace("/login");
        router.refresh();
        return;
      }
      const result = (await response.json()) as { error?: string };
      setError(result.error ?? "Setup failed.");
    } catch {
      setError("Setup could not be completed. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      method="post"
      action="/api/setup"
      onSubmit={submit}
      className="auth-card"
    >
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
        Find the setup secret in the Maildock container logs.
      </p>
      <label>
        Username
        <input
          name="username"
          minLength={ownerUsernameMinLength}
          maxLength={ownerUsernameMaxLength}
          required
          autoComplete="username"
        />
      </label>
      <div className="auth-password-field">
        <label htmlFor="setup-password">Password</label>
        <div className="auth-password-input">
          <input
            id="setup-password"
            name="password"
            type={showPassword ? "text" : "password"}
            minLength={12}
            maxLength={128}
            required
            autoComplete="new-password"
            onInput={() => setConfirmationError(undefined)}
          />
          <button
            type="button"
            className="icon-button"
            aria-label={showPassword ? "Hide password" : "Show password"}
            aria-controls="setup-password"
            onClick={() => setShowPassword(!showPassword)}
          >
            {showPassword ? (
              <EyeOff size={18} aria-hidden="true" />
            ) : (
              <Eye size={18} aria-hidden="true" />
            )}
          </button>
        </div>
      </div>
      <div className="auth-password-field">
        <label htmlFor="setup-confirm-password">Confirm password</label>
        <div className="auth-password-input">
          <input
            id="setup-confirm-password"
            ref={confirmation}
            type={showConfirmation ? "text" : "password"}
            required
            maxLength={128}
            autoComplete="new-password"
            aria-invalid={confirmationError ? true : undefined}
            aria-describedby={
              confirmationError ? "setup-confirm-password-error" : undefined
            }
            onInput={() => setConfirmationError(undefined)}
            onInvalid={() =>
              setConfirmationError("Please confirm your password.")
            }
          />
          <button
            type="button"
            className="icon-button"
            aria-label={
              showConfirmation
                ? "Hide confirm password"
                : "Show confirm password"
            }
            aria-controls="setup-confirm-password"
            onClick={() => setShowConfirmation(!showConfirmation)}
          >
            {showConfirmation ? (
              <EyeOff size={18} aria-hidden="true" />
            ) : (
              <Eye size={18} aria-hidden="true" />
            )}
          </button>
        </div>
        {confirmationError ? (
          <p
            id="setup-confirm-password-error"
            className="error auth-help"
            role="alert"
          >
            {confirmationError}
          </p>
        ) : null}
      </div>
      <p className="muted auth-help">
        Use a username of {ownerUsernameMinLength}-{ownerUsernameMaxLength}{" "}
        characters (letters, numbers, dots, underscores, or hyphens) and a
        password of 12-128 characters.
      </p>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      <button className="button" disabled={pending}>
        {pending ? "Creating owner…" : "Create owner"}
      </button>
    </form>
  );
}
