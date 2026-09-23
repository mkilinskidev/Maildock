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
    const response = await fetch("/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
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
    setPending(false);
  }

  return (
    <form method="post" action="/api/setup" onSubmit={submit} className="card">
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
      {error ? <p className="error">{error}</p> : null}
      <button disabled={pending}>
        {pending ? "Creating owner…" : "Create owner"}
      </button>
    </form>
  );
}
