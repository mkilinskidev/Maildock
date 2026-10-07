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
    <section className="remote-image-privacy">
      <header className="settings-pane-header">
        <h2>Remote image privacy</h2>
        <p>
          Images are blocked by default to prevent tracking requests. Loading
          remote images can reveal your IP address and opening time to remote
          hosts. Trusted senders automatically load images in future messages
          from that exact address.
        </p>
      </header>
      <div className="trusted-senders-heading">
        <h3 id="trusted-senders-title">Trusted senders</h3>
        <p>Remote images from these addresses are loaded automatically.</p>
      </div>
      <div className="trusted-senders-container">
        {senders.length ? (
          <table
            className="trusted-senders-table"
            aria-labelledby="trusted-senders-title"
          >
            <thead>
              <tr>
                <th scope="col">Email address</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {senders.map((s) => (
                <tr key={s.address}>
                  <td>{s.address}</td>
                  <td>
                    <button
                      type="button"
                      className="trusted-sender-remove"
                      aria-label={`Remove ${s.address}`}
                      disabled={removing !== null}
                      onClick={() => void remove(s.address)}
                    >
                      {removing === s.address ? "Removing…" : "Remove"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="trusted-senders-empty">
            <p>No trusted senders.</p>
            <p>Remote images remain blocked by default.</p>
          </div>
        )}
      </div>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
