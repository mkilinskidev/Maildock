"use client";
import { useEffect, useState } from "react";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { useRouter } from "next/navigation";
import type { OAuthProviderConfigView } from "@/modules/accounts/infrastructure/oauth-provider-configs";
export function OAuthProviderSettings({
  onDirtyChange,
  onBusyChange,
}: {
  onDirtyChange: (value: boolean) => void;
  onBusyChange: (value: boolean) => void;
}) {
  const [providers, setProviders] = useState<OAuthProviderConfigView[]>([]);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    void fetch("/api/settings/oauth-providers", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw Error();
        const data = await response.json();
        if (active) setProviders(data.providers);
      })
      .catch(() => {
        if (active)
          setError("OAuth provider configuration could not be loaded.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  const selected = providers.find((provider) => provider.id === selectedId);
  if (selected)
    return (
      <ProviderForm
        key={selected.id}
        provider={selected}
        onDirtyChange={onDirtyChange}
        onBusyChange={onBusyChange}
        onBack={() => {
          onDirtyChange(false);
          setSelectedId(null);
        }}
        onSaved={(saved) =>
          setProviders((current) =>
            current.map((provider) =>
              provider.id === saved.id ? saved : provider,
            ),
          )
        }
      />
    );
  return (
    <>
      <header className="settings-pane-header">
        <h2>OAuth providers</h2>
        <p>Configure OAuth providers used for email connections.</p>
      </header>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {loading ? <p role="status">Loading OAuth providers...</p> : null}
      <div className="oauth-provider-list" aria-label="OAuth providers">
        {providers.map((provider) => (
          <button
            key={provider.id}
            type="button"
            className="oauth-provider-row"
            onClick={() => setSelectedId(provider.id)}
          >
            <span>
              <strong>{provider.name}</strong>
              <small>{provider.description}</small>
            </span>
            <span className="oauth-provider-status">
              {provider.configured ? "Configured" : "Not configured"}
            </span>
            <ChevronRight aria-hidden="true" size={18} />
          </button>
        ))}
      </div>
    </>
  );
}

function ProviderForm({
  provider,
  onDirtyChange,
  onBusyChange,
  onBack,
  onSaved,
}: {
  provider: OAuthProviderConfigView;
  onBack: () => void;
  onSaved: (provider: OAuthProviderConfigView) => void;
  onDirtyChange: (value: boolean) => void;
  onBusyChange: (value: boolean) => void;
}) {
  const router = useRouter();
  const [saved, setSaved] = useState(provider);
  const [clientId, setClientId] = useState(provider.clientId);
  const [secret, setSecret] = useState("");
  const [enabled, setEnabled] = useState(provider.enabled);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const dirty =
    clientId !== saved.clientId || !!secret || enabled !== saved.enabled;
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    onBusyChange(true);
    setError("");
    setStatus("");
    try {
      const response = await fetch("/api/settings/oauth-providers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId: provider.id,
          clientId,
          clientSecret: secret,
          enabled,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? "Configuration could not be saved.");
        return;
      }
      setSaved(data);
      onSaved(data);
      setClientId(data.clientId);
      setSecret("");
      setStatus("Saved");
      router.refresh();
    } catch {
      setError("Configuration could not be saved.");
    } finally {
      setPending(false);
      onBusyChange(false);
    }
  }
  return (
    <>
      <button
        type="button"
        className="button secondary"
        disabled={pending}
        onClick={() => {
          if (dirty && !window.confirm("Discard unsaved settings changes?"))
            return;
          onBack();
        }}
      >
        <ArrowLeft size={16} aria-hidden="true" /> OAuth providers
      </button>
      <form
        className="settings-create-form oauth-provider-form"
        onSubmit={save}
      >
        <section className="settings-section">
          <header className="settings-pane-header oauth-provider-detail-header">
            <div>
              <h2>{provider.name}</h2>
              <p>{provider.description}</p>
            </div>
            <span className="oauth-provider-status" role="status">
              {saved.configured ? "Configured" : "Not configured"}
            </span>
          </header>
          <label className="oauth-provider-enabled">
            <input
              type="checkbox"
              checked={enabled}
              disabled={pending}
              onChange={(e) => setEnabled(e.target.checked)}
            />{" "}
            Enabled
          </label>
          <div className="oauth-provider-fields">
            <label>
              Client ID
              <input
                name="clientId"
                value={clientId}
                required
                maxLength={256}
                disabled={pending}
                onChange={(e) => setClientId(e.target.value)}
              />
            </label>
            <label>
              Client secret
              <input
                name="clientSecret"
                type="password"
                autoComplete="new-password"
                value={secret}
                maxLength={16384}
                disabled={pending}
                onChange={(e) => setSecret(e.target.value)}
              />
            </label>
            <p>
              {saved.hasClientSecret
                ? "A client secret is stored. Leave blank to keep it."
                : "Enter the application client secret."}
            </p>
            <div className="oauth-provider-redirect">
              <label>
                Redirect URI
                <input value={provider.redirectUri} readOnly />
              </label>
              <button
                type="button"
                className="button secondary"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(provider.redirectUri)
                    .then(() => setStatus("Redirect URI copied"))
                    .catch(() =>
                      setError(
                        "Copy failed. Select and copy the redirect URI.",
                      ),
                    );
                }}
              >
                Copy
              </button>
            </div>
          </div>
          <div className="actions">
            <button type="submit" className="button" disabled={pending}>
              {pending ? "Saving..." : "Save"}
            </button>
          </div>
          {status ? <p role="status">{status}</p> : null}
          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : null}
        </section>
      </form>
    </>
  );
}
