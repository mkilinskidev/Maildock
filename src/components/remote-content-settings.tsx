"use client";
import { useState } from "react";
export function RemoteContentSettings({
  initialSenders,
}: {
  initialSenders: { address: string }[];
}) {
  const [senders, setSenders] = useState(initialSenders);
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  async function remove(address: string) {
    setRemoving(address);
    setError("");
    try {
      const response = await fetch("/api/settings/remote-content-senders", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address }),
      });
      if (!response.ok) throw Error("Sender permission could not be removed.");
      setSenders((values) => values.filter((s) => s.address !== address));
    } catch {
      setError("Sender permission could not be removed.");
    } finally {
      setRemoving(null);
    }
  }
  return (
    <section className="card">
      <h2>Remote image privacy</h2>
      <p>
        Images are blocked by default to prevent tracking requests. Loading
        remote images can reveal your IP address and opening time to remote
        hosts. Trusted senders automatically load images in future messages from
        that exact address.
      </p>
      {senders.length ? (
        <ul>
          {senders.map((s) => (
            <li key={s.address}>
              {s.address}{" "}
              <button
                className="button secondary"
                disabled={removing !== null}
                onClick={() => void remove(s.address)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p>No trusted senders.</p>
      )}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
