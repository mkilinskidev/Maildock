"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    const data = new FormData(event.currentTarget);
    const response = await fetch("/api/auth/sign-in/username", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: data.get("username"),
        password: data.get("password"),
        rememberMe: false,
      }),
    });
    if (response.ok) {
      router.replace("/");
      router.refresh();
      return;
    }
    setError(
      response.status === 429
        ? "Too many attempts. Try again later."
        : "Invalid username or password.",
    );
    setPending(false);
  }

  return (
    <form
      method="post"
      action="/api/auth/sign-in/username"
      onSubmit={submit}
      className="card"
    >
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
      {error ? <p className="error">{error}</p> : null}
      <button disabled={pending}>{pending ? "Signing in…" : "Sign in"}</button>
    </form>
  );
}
