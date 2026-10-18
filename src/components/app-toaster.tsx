"use client";

import { Toaster } from "sonner";

export function AppToaster() {
  return (
    <Toaster
      position="bottom-right"
      closeButton
      toastOptions={{
        style: {
          background: "var(--elevated)",
          color: "var(--text)",
          border: "1px solid var(--border)",
          fontSize: "13px",
        },
      }}
    />
  );
}
