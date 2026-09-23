"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function LogoutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  async function signOut() {
    setPending(true);
    setError(undefined);

    const response = await fetch("/api/auth/sign-out", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      setError("Sign out failed. Please try again.");
      setPending(false);
      return;
    }

    router.replace("/login");
    router.refresh();
  }

  return (
    <>
      {error ? <p className="error">{error}</p> : null}
      <button className="secondary" disabled={pending} onClick={signOut}>
        {pending ? "Signing out…" : "Sign out"}
      </button>
    </>
  );
}
