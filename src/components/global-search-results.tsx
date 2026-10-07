"use client";
import { messageDate } from "@/shared/application/message-date";
import { useEffect, useState } from "react";
import { Search, LoaderCircle, Flag, Paperclip } from "lucide-react";
import type {
  SearchPage,
  SearchResult,
} from "@/modules/mail/application/search-service";

export function GlobalSearchResults({
  query,
  selectedId,
  onSelect,
  refreshKey,
}: {
  query: string;
  selectedId: string;
  onSelect: (item: SearchResult) => void;
  refreshKey: number;
}) {
  const [page, setPage] = useState<SearchPage>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void fetch(`/api/search?q=${encodeURIComponent(query.trim())}`, {
        signal: controller.signal,
        cache: "no-store",
      })
        .then(async (response) => {
          if (!response.ok)
            throw Error("Mail search is temporarily unavailable.");
          const value = (await response.json()) as SearchPage;
          if (!controller.signal.aborted) {
            setPage(value);
            setError("");
          }
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setError(
              "Mail search is temporarily unavailable. Try editing your search or clearing it.",
            );
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, refreshKey, retry]);
  return (
    <div className="mail-rows global-search-results" aria-live="polite">
      {error ? (
        <div className="pane-empty" role="alert">
          <strong>Search could not be completed</strong>
          <p>{error}</p>
          <button
            className="button secondary"
            onClick={() => {
              setError("");
              setPage(undefined);
              setRetry((n) => n + 1);
            }}
          >
            Retry search
          </button>
        </div>
      ) : !page ? (
        <div className="pane-empty" role="status">
          <LoaderCircle size={20} className="animate-spin" />
          <span>Searching all mail…</span>
        </div>
      ) : !page.items.length ? (
        <div className="pane-empty">
          <Search size={26} />
          <strong>No matching messages</strong>
          <p>
            Try different words. Only locally available bodies are searched.
          </p>
        </div>
      ) : (
        <>
          <p className="search-count">
            {page.items.length}
            {page.hasMore ? "+" : ""} messages
            {page.hasMore
              ? " · Showing the 50 most relevant. Refine your search for more."
              : ""}
          </p>
          {page.items.map((item) => (
            <button
              key={item.id}
              className={`mail-list-row${item.id === selectedId ? " selected" : ""}${!item.seen ? " unread" : ""}`}
              onClick={() => onSelect(item)}
              aria-current={item.id === selectedId ? "true" : undefined}
            >
              <span className="mail-row-top">
                <span className="mail-row-marker">
                  {!item.seen ? (
                    <span className="unread-dot" aria-label="Unread" />
                  ) : null}
                </span>
                <strong>
                  {item.from[0]?.name ||
                    item.from[0]?.address ||
                    "Unknown sender"}
                </strong>
                <time dateTime={item.date} title={messageDate(item.date).title}>
                  {messageDate(item.date).text}
                </time>
              </span>
              <span className="mail-row-subject">
                {item.subject || "(No subject)"}
              </span>
              <span className="mail-row-snippet search-snippet">
                {item.snippet}
              </span>
              <span className="mail-row-bottom">
                {item.accountName} · {item.mailboxName}
                {item.flagged ? <Flag size={12} aria-label="Flagged" /> : null}
                {item.hasAttachments ? (
                  <>
                    <Paperclip size={12} aria-hidden="true" /> Attachment
                  </>
                ) : null}
              </span>
            </button>
          ))}
        </>
      )}
    </div>
  );
}
