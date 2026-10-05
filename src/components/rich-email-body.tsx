"use client";
import { useEffect, useRef, useState } from "react";
import { ShieldOff } from "lucide-react";
import {
  contentPollDelay,
  DEFAULT_CONTENT_POLL_INTERVAL_MS,
} from "@/shared/application/content-polling";

type Rendering = {
  document: string | null;
  blocked: boolean;
  trusted: boolean;
  sender: string | null;
  pending: boolean;
  inlineFailures: number;
};
export function RichEmailBody({
  url,
  plainText,
  contentPollIntervalMs = DEFAULT_CONTENT_POLL_INTERVAL_MS,
}: {
  url: string;
  plainText: string | null;
  contentPollIntervalMs?: number;
}) {
  const [rendering, setRendering] = useState<Rendering | null>(null);
  const [loadImages, setLoadImages] = useState(false);
  const [trustRequest, setTrustRequest] = useState(0);
  const fulfilledTrust = useRef(0);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const startedAt = Date.now();
    let saveTrust = trustRequest > fulfilledTrust.current;
    async function load() {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ loadImages, trustSender: saveTrust }),
          signal: controller.signal,
        });
        if (!response.ok) throw Error();
        const value = (await response.json()) as Rendering;
        if (cancelled) return;
        saveTrust = false;
        fulfilledTrust.current = trustRequest;
        setRendering(value);
        setError("");
        if (value.pending)
          timer = setTimeout(
            () => void load(),
            contentPollDelay(contentPollIntervalMs, Date.now() - startedAt),
          );
      } catch {
        if (!cancelled)
          setError(
            "HTML could not be displayed. Plain text is shown where available.",
          );
      }
    }
    void load();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [url, loadImages, trustRequest, contentPollIntervalMs, retry]);
  return (
    <>
      {rendering?.blocked ? (
        <div className="mail-privacy">
          <ShieldOff size={15} />
          <span>Remote images are blocked for your privacy.</span>
          <button
            className="button secondary"
            onClick={() => setLoadImages(true)}
          >
            Load images
          </button>
          {rendering.sender ? (
            <button
              className="button secondary"
              onClick={() => setTrustRequest((value) => value + 1)}
            >
              Always load from this sender
            </button>
          ) : null}
          <small>
            Loading images can reveal your IP address and opening time. Sender
            permission applies to this exact address.
          </small>
        </div>
      ) : null}
      {error ? (
        <div className="reader-error" role="alert">
          <p>{error}</p>
          <button
            className="button secondary"
            onClick={() => {
              setError("");
              setRetry((n) => n + 1);
            }}
          >
            Retry display
          </button>
        </div>
      ) : null}
      {rendering?.document && !error ? (
        <iframe
          title="Email content"
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          srcDoc={rendering.document}
        />
      ) : (
        <pre>
          {plainText ?? (error ? "HTML is unavailable." : "Preparing email…")}
        </pre>
      )}
      {rendering?.pending ? (
        <p role="status">Preparing inline images…</p>
      ) : null}
      {rendering?.inlineFailures ? (
        <p role="status">Some inline images are unavailable.</p>
      ) : null}
    </>
  );
}
