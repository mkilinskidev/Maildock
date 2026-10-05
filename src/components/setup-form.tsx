"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export function SetupForm() {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    const data = new FormData(event.currentTarget);
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
        Bootstrap secret
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
        Enter the bootstrap secret from your deployment configuration.
      </p>
      <label>
        Username
        <input
          name="username"
          minLength={3}
          maxLength={64}
          required
          autoComplete="username"
        />
      </label>
      <label>
        Password
        <input
          name="password"
          type="password"
          minLength={12}
          maxLength={128}
          required
          autoComplete="new-password"
        />
      </label>
      <p className="muted auth-help">
        Use a username of 3-64 characters and a password of 12-128 characters.
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
