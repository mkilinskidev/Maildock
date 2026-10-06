"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";

export function LogoutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  async function signOut() {
    setPending(true);
    setError(undefined);

    try {
      const response = await fetch("/api/auth/sign-out", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      if (!response.ok) {
        setError(
          "Sign out could not be confirmed. Your session may still be active.",
        );

        return;
      }

      router.replace("/login");
      router.refresh();
    } catch {
      setError(
        "Sign out could not be confirmed. Your session may still be active.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      <button disabled={pending} onClick={signOut}>
        <LogOut size={15} />
        {pending ? "Signing out…" : "Sign out"}
      </button>
    </>
  );
}
