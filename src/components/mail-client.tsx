"use client";

import Link from "next/link";
import {
  Archive,
  CircleAlert,
  Inbox,
  Mail,
  MailOpen,
  Paperclip,
  Plus,
  RefreshCw,
  Settings2,
  ShieldOff,
  Trash2,
  Star,
  Eye,
  EyeOff,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MailAccountView } from "@/modules/accounts/application/accounts-service";
import type { MailboxView } from "@/modules/mail/application/mailbox-service";
import type { MailboxRoleView } from "@/modules/mail/application/mailbox-role-service";
import type {
  MessageListItem,
  MessagePage,
} from "@/modules/mail/application/message-service";
import { LogoutButton } from "@/components/logout-button";
import { ThemeControl } from "@/components/theme-control";
import {
  MailComposer,
  sendStatusText,
  sendingAccountAvailable,
} from "@/components/mail-composer";

type Address = { name?: string; address?: string };
type SendFeedback = {
  status: string;
  error?: string | null;
  sentCopyStatus?: string;
  sentCopyError?: string | null;
};
function autoDismissSentFeedback(item?: SendFeedback) {
  return (
    item?.status === "sent" &&
    !["pending", "saving", "failed", "uncertain"].includes(
      item.sentCopyStatus ?? "",
    )
  );
}
type Detail = {
  id: string;
  subject: string | null;
  date: string;
  sentAt: string | null;
  from: Address[];
  to: Address[];
  cc: Address[];
  replyTo: Address[];
  attachments: { filename: string | null; type: string; size: string | null }[];
  content: {
    status: string;
    plainText: string | null;
    sanitizedHtml: string | null;
    remoteContentBlocked: boolean;
    error: string | null;
  };
};
type CountAdjustment = {
  key: string;
  mailboxId: string;
  delta: number;
  completedAt: string | null;
};
function address(values: Address[]) {
  return values
    .map((value) =>
      value.name
        ? `${value.name} <${value.address ?? ""}>`
        : (value.address ?? "Unknown"),
    )
    .join(", ");
}
function shell(html: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; object-src 'none'; frame-src 'none'; connect-src 'none'; img-src 'none'; media-src 'none'; font-src 'none'; form-action 'none'; base-uri 'none'; style-src 'unsafe-inline'"><style>body{font:15px/1.55 system-ui,sans-serif;color:#20242b;margin:20px;overflow-wrap:anywhere}table{max-width:100%;display:block;overflow:auto}pre{white-space:pre-wrap}blockquote{border-left:3px solid #d0d7de;padding-left:1em;margin-left:0;color:#596579}</style></head><body>${html}</body></html>`;
}
function formatCount(value: string): string {
  return new Intl.NumberFormat().format(BigInt(value));
}

export function MailClient({
  accounts,
  mailboxesByAccount,
  rolesByAccount,
}: {
  accounts: MailAccountView[];
  mailboxesByAccount: Record<string, MailboxView[]>;
  rolesByAccount: Record<string, MailboxRoleView[]>;
}) {
  const first = accounts[0];
  const [composing, setComposing] = useState(false);
  const [outgoing, setOutgoing] = useState<Record<string, SendFeedback>>({});
  const sentFeedbackTimers = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );
  useEffect(() => {
    const timers = sentFeedbackTimers.current;
    for (const [id, timer] of timers) {
      if (!autoDismissSentFeedback(outgoing[id])) {
        clearTimeout(timer);
        timers.delete(id);
      }
    }
    for (const [id, item] of Object.entries(outgoing)) {
      if (!autoDismissSentFeedback(item) || timers.has(id)) continue;
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id);
          setOutgoing((current) => {
            if (!autoDismissSentFeedback(current[id])) return current;
            const next = { ...current };
            delete next[id];
            return next;
          });
        }, 5000),
      );
    }
  }, [outgoing]);
  useEffect(() => {
    const timers = sentFeedbackTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);
  useEffect(() => {
    const ids = Object.entries(outgoing)
      .filter(
        ([, item]) =>
          item.status === "queued" ||
          item.status === "sending" ||
          (item.status === "sent" &&
            ["pending", "saving"].includes(item.sentCopyStatus ?? "")),
      )
      .map(([id]) => id);
    if (!ids.length) return;
    let cancelled = false;
    const poll = async () => {
      for (const id of ids) {
        try {
          const response = await fetch(`/api/outgoing/${id}`, {
            cache: "no-store",
          });
          if (!response.ok) continue;
          const result = (await response.json()) as SendFeedback;
          if (!cancelled)
            setOutgoing((current) =>
              current[id]?.status === result.status &&
              current[id]?.error === result.error &&
              current[id]?.sentCopyStatus === result.sentCopyStatus &&
              current[id]?.sentCopyError === result.sentCopyError
                ? current
                : { ...current, [id]: result },
            );
        } catch {
          /* Keep polling without claiming a delivery failure. */
        }
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [outgoing]);
  const [accountId, setAccountId] = useState(first?.id ?? "");
  const [liveMailboxesByAccount, setLiveMailboxesByAccount] =
    useState(mailboxesByAccount);
  const [liveRolesByAccount, setLiveRolesByAccount] = useState(rolesByAccount);
  const [folderReloadNonce, setFolderReloadNonce] = useState(0);
  const folders = liveMailboxesByAccount[accountId] ?? [];
  const [mailboxId, setMailboxId] = useState(
    () =>
      folders.find((item) => item.remotePath.toUpperCase() === "INBOX")?.id ??
      folders.find((item) => item.selectable)?.id ??
      "",
  );
  const activeLocationRef = useRef(`${accountId}:${mailboxId}`);
  const [messages, setMessages] = useState<MessageListItem[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(Boolean(first));
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [paginationError, setPaginationError] = useState("");
  const [pageRequestVersion, setPageRequestVersion] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const loadingPageRef = useRef(false);
  const pageRequestIdRef = useRef(0);
  const loadedMoreRef = useRef(false);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const [pendingCommands, setPendingCommands] = useState<
    Record<
      string,
      {
        accountId: string;
        mailboxId: string;
        adjustmentKey: string | null;
      }
    >
  >({});
  const [countAdjustments, setCountAdjustments] = useState<CountAdjustment[]>(
    [],
  );
  const folder = folders.find((item) => item.id === mailboxId);
  const base = `/api/accounts/${accountId}/mailboxes/${mailboxId}/messages`;
  const selectedMessage = messages.find((item) => item.id === selectedId);
  const moveAvailable = (action: "archive" | "trash") => {
    const mapping = liveRolesByAccount[accountId]?.find(
      (item) => item.role === action,
    );
    return Boolean(
      activeAccount?.enabled &&
      activeAccount.mailboxDiscovery.capabilities.includes("MOVE") &&
      mapping?.available &&
      mapping.mailboxId !== mailboxId,
    );
  };

  async function act(
    action:
      "archive" | "trash" | "mark_read" | "mark_unread" | "flag" | "unflag",
  ) {
    if (!selectedId || !selectedMessage) return;
    const targetId = selectedId;
    const previous = [...messages];
    const countDelta =
      action === "mark_read" && !selectedMessage.seen
        ? -1
        : action === "mark_unread" && selectedMessage.seen
          ? 1
          : 0;
    const adjustmentKey = countDelta === 0 ? null : crypto.randomUUID();
    if (adjustmentKey)
      setCountAdjustments((current) => [
        ...current,
        { key: adjustmentKey, mailboxId, delta: countDelta, completedAt: null },
      ]);
    setError("");
    if (action === "archive" || action === "trash") {
      const index = messages.findIndex((item) => item.id === targetId);
      const next = messages[index + 1] ?? messages[index - 1];
      setMessages((current) => current.filter((item) => item.id !== targetId));
      setSelectedId(next?.id ?? "");
      setDetail(null);
      setLoadingDetail(Boolean(next));
    } else {
      setMessages((current) =>
        current.map((item) =>
          item.id === targetId
            ? {
                ...item,
                seen:
                  action === "mark_read"
                    ? true
                    : action === "mark_unread"
                      ? false
                      : item.seen,
                flagged:
                  action === "flag"
                    ? true
                    : action === "unflag"
                      ? false
                      : item.flagged,
              }
            : item,
        ),
      );
    }
    try {
      const response = await fetch(`${base}/${targetId}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const result = (await response.json()) as { id?: string; error?: string };
      if (!response.ok || !result.id)
        throw new Error(result.error ?? "Message action could not be queued.");
      setPendingCommands((current) => ({
        ...current,
        [result.id!]: { accountId, mailboxId, adjustmentKey },
      }));
    } catch (failure) {
      if (adjustmentKey)
        setCountAdjustments((current) =>
          current.filter((item) => item.key !== adjustmentKey),
        );
      if (activeLocationRef.current === `${accountId}:${mailboxId}`) {
        setMessages(previous);
        setSelectedId(targetId);
        setError(
          failure instanceof Error
            ? failure.message
            : "Message action could not be queued.",
        );
      }
    }
  }

  useEffect(() => {
    const entries = Object.entries(pendingCommands);
    if (!entries.length) return;
    let cancelled = false;
    const idsByAccount = new Map<string, string[]>();
    for (const [id, command] of entries) {
      const ids = idsByAccount.get(command.accountId) ?? [];
      ids.push(id);
      idsByAccount.set(command.accountId, ids);
    }
    const timer = setInterval(() => {
      for (const [commandAccountId, ids] of idsByAccount)
        void fetch(
          `/api/accounts/${commandAccountId}/message-commands?${ids.map((id) => `id=${encodeURIComponent(id)}`).join("&")}`,
          { cache: "no-store" },
        )
          .then(async (response) =>
            response.ok
              ? (response.json() as Promise<{
                  commands: {
                    id: string;
                    status: string;
                    error: string | null;
                    completedAt: string | null;
                  }[];
                }>)
              : Promise.reject(),
          )
          .then((result) => {
            if (cancelled) return;
            const finished = result.commands.filter(
              (item) => item.status === "failed" || item.status === "succeeded",
            );
            if (!finished.length) return;
            setCountAdjustments((current) =>
              current.flatMap((adjustment) => {
                const match = finished.find(
                  (item) =>
                    pendingCommands[item.id]?.adjustmentKey === adjustment.key,
                );
                if (!match) return [adjustment];
                if (match.status === "failed") return [];
                return [{ ...adjustment, completedAt: match.completedAt }];
              }),
            );
            setPendingCommands((current) => {
              const next = { ...current };
              for (const item of finished) delete next[item.id];
              return next;
            });
            if (finished.some((item) => item.status === "succeeded"))
              setFolderReloadNonce((value) => value + 1);
            const failure = finished.find((item) => item.status === "failed");
            if (failure) {
              const source = pendingCommands[failure.id];
              if (source?.accountId === accountId) {
                setError(failure.error ?? "Message action failed.");
                if (source.mailboxId === mailboxId)
                  void fetch(`${base}?pageSize=50`, { cache: "no-store" }).then(
                    async (response) => {
                      if (response.ok && !cancelled)
                        setMessages(
                          (
                            (await response.json()) as MessagePage
                          ).items.slice(),
                        );
                    },
                  );
              }
            }
          })
          .catch(() => undefined);
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [accountId, mailboxId, base, pendingCommands]);

  const applyFirstPage = useCallback((page: MessagePage) => {
    setMessages((current) => {
      if (!loadedMoreRef.current) return [...page.items];
      const firstPageIds = new Set(page.items.map((item) => item.id));
      return [
        ...page.items,
        ...current.filter((item) => !firstPageIds.has(item.id)),
      ];
    });
    if (!loadedMoreRef.current) setNextCursor(page.nextCursor);
  }, []);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    let busy = false;
    const load = () => {
      if (document.visibilityState !== "visible" || busy) return;
      busy = true;
      fetch(`/api/accounts/${accountId}/mailboxes`, { cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) throw new Error("Mailboxes could not be loaded.");
          return response.json() as Promise<{
            mailboxes: MailboxView[];
            roles: MailboxRoleView[];
          }>;
        })
        .then((result) => {
          if (!cancelled) {
            setLiveMailboxesByAccount((current) => ({
              ...current,
              [accountId]: result.mailboxes,
            }));
            setLiveRolesByAccount((current) => ({
              ...current,
              [accountId]: result.roles,
            }));
            setCountAdjustments((current) =>
              current.filter((adjustment) => {
                if (!adjustment.completedAt) return true;
                const mailbox = result.mailboxes.find(
                  (item) => item.id === adjustment.mailboxId,
                );
                const synchronizedAt = mailbox?.deltaSync.lastSuccessfulAt;
                return (
                  !synchronizedAt ||
                  new Date(synchronizedAt).getTime() <
                    new Date(adjustment.completedAt).getTime()
                );
              }),
            );
          }
        })
        .catch(() => {
          // Keep the last known counts; the next poll retries.
        })
        .finally(() => {
          busy = false;
        });
    };
    load();
    const timer = setInterval(load, 20_000);
    document.addEventListener("visibilitychange", load);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [accountId, folderReloadNonce]);

  useEffect(() => {
    if (!accountId || !mailboxId) return;
    let cancelled = false;
    let busy = false;
    const load = () => {
      if (document.visibilityState !== "visible" || busy) return;
      busy = true;
      fetch(`${base}?pageSize=50`, { cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) throw new Error("Messages could not be loaded.");
          return response.json() as Promise<MessagePage>;
        })
        .then((result) => {
          if (!cancelled) {
            applyFirstPage(result);
            setError("");
          }
        })
        .catch(() => {
          if (!cancelled) setError("Messages could not be loaded.");
        })
        .finally(() => {
          busy = false;
          if (!cancelled) setLoadingMessages(false);
        });
    };
    load();
    const timer = setInterval(load, 20_000);
    document.addEventListener("visibilitychange", load);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [accountId, mailboxId, base, applyFirstPage]);

  useEffect(() => {
    const target = loadMoreRef.current;
    const root = listRef.current;
    if (!target || !root || !nextCursor || loadingMessages || paginationError)
      return;
    let cancelled = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting || loadingPageRef.current) return;
        loadingPageRef.current = true;
        const requestId = ++pageRequestIdRef.current;
        setLoadingMore(true);
        fetch(`${base}?pageSize=50&cursor=${encodeURIComponent(nextCursor)}`, {
          cache: "no-store",
        })
          .then(async (response) => {
            if (!response.ok)
              throw new Error("Older messages could not be loaded.");
            return response.json() as Promise<MessagePage>;
          })
          .then((page) => {
            if (cancelled || pageRequestIdRef.current !== requestId) return;
            loadedMoreRef.current = true;
            setMessages((current) => {
              const existingIds = new Set(current.map((item) => item.id));
              return [
                ...current,
                ...page.items.filter((item) => !existingIds.has(item.id)),
              ];
            });
            setNextCursor(page.nextCursor);
          })
          .catch(() => {
            if (!cancelled && pageRequestIdRef.current === requestId)
              setPaginationError("Older messages could not be loaded.");
          })
          .finally(() => {
            if (pageRequestIdRef.current === requestId) {
              loadingPageRef.current = false;
              setLoadingMore(false);
              setPageRequestVersion((value) => value + 1);
            }
          });
      },
      { root, rootMargin: "0px 0px 240px 0px" },
    );
    observer.observe(target);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [base, nextCursor, loadingMessages, paginationError, pageRequestVersion]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const url = `${base}/${selectedId}`;
    async function load() {
      const response = await fetch(url);
      if (!response.ok) throw new Error("Message could not be loaded.");
      const value = (await response.json()) as Detail;
      if (cancelled) return;
      setDetail(value);
      setLoadingDetail(false);
      if (value.content.status === "not_fetched") {
        const queued = await fetch(`${url}/content`, { method: "POST" });
        if (!queued.ok) {
          const body = (await queued.json()) as { error?: string };
          throw new Error(body.error ?? "Content could not be requested.");
        }
        timer = setTimeout(() => void load().catch(handleError), 2500);
      } else if (
        value.content.status === "pending" ||
        value.content.status === "fetching"
      ) {
        timer = setTimeout(() => void load().catch(handleError), 2500);
      }
    }
    function handleError(failure: unknown) {
      if (!cancelled) {
        setLoadingDetail(false);
        setError(
          failure instanceof Error
            ? failure.message
            : "Message could not be loaded.",
        );
      }
    }
    void load().catch(handleError);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [base, selectedId, retryNonce]);

  async function retryContent() {
    if (!selectedId) return;
    setRetrying(true);
    setError("");
    try {
      const response = await fetch(`${base}/${selectedId}/content`, {
        method: "POST",
      });
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error ?? "Content could not be requested.");
      }
      setDetail((current) =>
        current
          ? {
              ...current,
              content: { ...current.content, status: "pending", error: null },
            }
          : current,
      );
      setRetryNonce((value) => value + 1);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Content could not be requested.",
      );
    } finally {
      setRetrying(false);
    }
  }

  async function refresh() {
    if (!mailboxId) return;
    setRefreshing(true);
    setError("");
    try {
      const response = await fetch(`${base}/refresh`, { method: "POST" });
      if (!response.ok)
        throw new Error("Synchronization could not be requested.");
      window.setTimeout(async () => {
        const result = await fetch(`${base}?pageSize=50`);
        if (result.ok) applyFirstPage((await result.json()) as MessagePage);
        setFolderReloadNonce((value) => value + 1);
        setRefreshing(false);
      }, 2500);
    } catch {
      setError("Synchronization could not be requested.");
      setRefreshing(false);
    }
  }

  const activeAccount = accounts.find((account) => account.id === accountId);
  const visibleFolders = folders.filter(
    (item) => item.selectable && item.lifecycleStatus === "active",
  );
  const sender = detail?.from[0];
  const senderName = sender?.name || sender?.address || "Unknown sender";

  return (
    <main className="mail-app">
      <header className="app-bar">
        <div className="app-brand">
          <span className="brand-mark">
            <Mail size={16} strokeWidth={2} />
          </span>
          Maildock
        </div>
        <div className="app-bar-right">
          <span>Personal mail</span>
          <ThemeControl />
        </div>
      </header>
      <aside className="mail-sidebar">
        {accounts.length > 0 ? (
          <>
            <div className="account-identity">
              <span className="account-avatar">
                {activeAccount?.displayName?.charAt(0) || "M"}
              </span>
              <select
                aria-label="Account"
                value={accountId}
                onChange={(event) => {
                  const id = event.target.value;
                  setMessages([]);
                  setNextCursor(null);
                  setPaginationError("");
                  setLoadingMore(false);
                  pageRequestIdRef.current += 1;
                  loadingPageRef.current = false;
                  loadedMoreRef.current = false;
                  listRef.current?.scrollTo({ top: 0 });
                  setSelectedId("");
                  setDetail(null);
                  setError("");
                  setLoadingMessages(true);
                  setAccountId(id);
                  const next = liveMailboxesByAccount[id] ?? [];
                  const nextMailboxId =
                    next.find(
                      (item) => item.remotePath.toUpperCase() === "INBOX",
                    )?.id ??
                    next.find((item) => item.selectable)?.id ??
                    "";
                  activeLocationRef.current = `${id}:${nextMailboxId}`;
                  setMailboxId(nextMailboxId);
                }}
              >
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.displayName}
                  </option>
                ))}
              </select>
            </div>
            <div className="account-email" title={activeAccount?.email}>
              {activeAccount?.email}
            </div>
            <div className="sidebar-label">Mailboxes</div>
            <button
              className="button compose-action"
              disabled={!accounts.some(sendingAccountAvailable)}
              onClick={() => setComposing(true)}
            >
              <Plus size={15} />
              Compose
            </button>
            <nav className="mail-folders" aria-label="Mailboxes">
              {visibleFolders.map((item) => {
                const inbox = item.remotePath.toUpperCase() === "INBOX";
                const Icon = inbox ? Inbox : Archive;
                const projected =
                  item.unseenCount === null
                    ? null
                    : BigInt(item.unseenCount) +
                      BigInt(
                        countAdjustments
                          .filter(
                            (adjustment) => adjustment.mailboxId === item.id,
                          )
                          .reduce(
                            (sum, adjustment) => sum + adjustment.delta,
                            0,
                          ),
                      );
                const unread =
                  projected !== null && projected > 0n
                    ? projected.toString()
                    : null;
                return (
                  <button
                    key={item.id}
                    className={item.id === mailboxId ? "active" : ""}
                    title={item.remotePath}
                    aria-current={item.id === mailboxId ? "page" : undefined}
                    onClick={() => {
                      if (item.id === mailboxId) return;
                      setMessages([]);
                      setNextCursor(null);
                      setPaginationError("");
                      setLoadingMore(false);
                      pageRequestIdRef.current += 1;
                      loadingPageRef.current = false;
                      loadedMoreRef.current = false;
                      listRef.current?.scrollTo({ top: 0 });
                      setSelectedId("");
                      setDetail(null);
                      setError("");
                      setLoadingMessages(true);
                      activeLocationRef.current = `${accountId}:${item.id}`;
                      setMailboxId(item.id);
                    }}
                  >
                    <Icon size={16} strokeWidth={1.8} />
                    <span className="folder-name">{item.name}</span>
                    {unread ? (
                      <span
                        className="folder-count unread"
                        title="Unread messages"
                      >
                        {formatCount(unread)}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </nav>
          </>
        ) : (
          <div className="pane-empty">
            <Mail size={25} />
            <strong>No accounts yet</strong>
            <p>Add an account to see your mailboxes.</p>
          </div>
        )}
        <div className="mail-sidebar-footer">
          <Link href="/accounts">
            <Settings2 size={15} />
            Accounts & settings
          </Link>
          <Link href="/accounts/new">
            <Plus size={15} />
            Add account
          </Link>
          <LogoutButton />
        </div>
      </aside>
      <section className="mail-list-pane" aria-label="Messages">
        <header className="mail-pane-header">
          <div>
            <h1>{folder?.name ?? "Mail"}</h1>
            <small>
              {folder
                ? formatCount(folder.synchronizedMessageCount) +
                  " synchronized messages"
                : "Select a mailbox"}
            </small>
          </div>
          <button
            className="icon-button"
            onClick={() => void refresh()}
            disabled={refreshing || !mailboxId}
            title="Sync mailbox"
            aria-label="Sync mailbox"
          >
            <RefreshCw size={17} className={refreshing ? "animate-spin" : ""} />
          </button>
        </header>
        {error ? (
          <p className="mail-error error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="mail-rows" ref={listRef}>
          {loadingMessages && mailboxId
            ? Array.from({ length: 5 }, (_, index) => (
                <div className="skeleton-row" key={index}>
                  <div
                    className="skeleton"
                    style={{ width: "55%", height: 12 }}
                  />
                  <div
                    className="skeleton"
                    style={{ width: "80%", height: 10 }}
                  />
                  <div
                    className="skeleton"
                    style={{ width: "35%", height: 9 }}
                  />
                </div>
              ))
            : messages.map((message) => (
                <button
                  key={message.id}
                  className={
                    "mail-list-row " +
                    (selectedId === message.id ? "selected " : "") +
                    (!message.seen ? "unread" : "")
                  }
                  aria-current={selectedId === message.id ? "true" : undefined}
                  onClick={() => {
                    if (selectedId === message.id) return;
                    setDetail(null);
                    setLoadingDetail(true);
                    setError("");
                    setSelectedId(message.id);
                  }}
                >
                  <span className="mail-row-top">
                    <span className="mail-row-marker">
                      {!message.seen ? (
                        <span className="unread-dot" aria-label="Unread" />
                      ) : null}
                    </span>
                    <strong>
                      {message.from[0]?.name ||
                        message.from[0]?.address ||
                        "Unknown sender"}
                    </strong>
                    <time dateTime={message.date}>
                      {new Date(message.date).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                        year:
                          new Date(message.date).getFullYear() ===
                          new Date().getFullYear()
                            ? undefined
                            : "numeric",
                      })}
                    </time>
                  </span>
                  <span className="mail-row-subject">
                    {message.subject || "(No subject)"}
                  </span>
                  <span className="mail-row-bottom">
                    {message.hasAttachments ? (
                      <>
                        <Paperclip size={12} /> Attachment
                      </>
                    ) : null}
                  </span>
                </button>
              ))}
          {!loadingMessages && nextCursor ? (
            <div
              className="mail-load-more"
              ref={loadMoreRef}
              aria-live="polite"
            >
              {paginationError ? (
                <>
                  <span>{paginationError}</span>
                  <button
                    className="button secondary"
                    onClick={() => setPaginationError("")}
                  >
                    Retry
                  </button>
                </>
              ) : loadingMore ? (
                <span>Loading older messages…</span>
              ) : (
                <span>Scroll for older messages</span>
              )}
            </div>
          ) : null}
          {!loadingMessages && !messages.length && !error ? (
            <div className="pane-empty">
              <MailOpen size={26} strokeWidth={1.5} />
              <strong>
                {mailboxId ? "Nothing here yet" : "No mailbox selected"}
              </strong>
              <p>
                {mailboxId
                  ? "Messages will appear here when synchronized."
                  : "Choose a mailbox from the sidebar."}
              </p>
            </div>
          ) : null}
        </div>
      </section>
      <section className="mail-detail-pane" aria-label="Message detail">
        {Object.entries(outgoing).map(([id, item]) => (
          <div
            className={`send-feedback send-${item.status}${item.status === "sent" && ["failed", "uncertain"].includes(item.sentCopyStatus ?? "") ? " send-copy-warning" : ""}`}
            role="status"
            key={id}
          >
            <span>
              {item.status === "sent" && item.sentCopyError
                ? item.sentCopyError
                : sendStatusText(item.status, item.sentCopyStatus)}
              {item.status === "sent" && item.error ? ` · ${item.error}` : ""}
              {item.status === "failed" && item.error ? ` · ${item.error}` : ""}
            </span>
            {!["queued", "sending"].includes(item.status) ? (
              <button
                className="icon-button"
                aria-label="Dismiss send status"
                onClick={() =>
                  setOutgoing((current) => {
                    const next = { ...current };
                    delete next[id];
                    return next;
                  })
                }
              >
                ×
              </button>
            ) : null}
          </div>
        ))}
        {composing ? (
          <MailComposer
            accounts={accounts}
            accountId={accountId}
            onClose={() => setComposing(false)}
            onQueued={(id) => {
              setOutgoing((current) => ({
                ...current,
                [id]: { status: "queued" },
              }));
              setComposing(false);
            }}
          />
        ) : (
          <>
            {!selectedId ? (
              <div className="pane-empty reader-empty">
                <MailOpen size={30} strokeWidth={1.4} />
                <strong>Select a message</strong>
                <p>Choose a message from the list to read it here.</p>
              </div>
            ) : null}
            {selectedId && loadingDetail && !detail ? (
              <div className="mail-detail-header">
                <div
                  className="skeleton"
                  style={{ width: "60%", height: 22 }}
                />
                <div
                  className="skeleton"
                  style={{ width: "40%", height: 13, marginTop: 24 }}
                />
              </div>
            ) : null}
            {detail ? (
              <>
                <header className="mail-detail-header">
                  <div
                    className="message-actions"
                    role="toolbar"
                    aria-label="Message actions"
                  >
                    <button
                      className="icon-button"
                      title="Archive"
                      aria-label="Archive"
                      disabled={!moveAvailable("archive")}
                      onClick={() => void act("archive")}
                    >
                      <Archive size={17} />
                    </button>
                    <button
                      className="icon-button"
                      title="Move to Trash"
                      aria-label="Move to Trash"
                      disabled={!moveAvailable("trash")}
                      onClick={() => void act("trash")}
                    >
                      <Trash2 size={17} />
                    </button>
                    <button
                      className="icon-button"
                      title={
                        selectedMessage?.seen ? "Mark unread" : "Mark read"
                      }
                      aria-label={
                        selectedMessage?.seen ? "Mark unread" : "Mark read"
                      }
                      onClick={() =>
                        void act(
                          selectedMessage?.seen ? "mark_unread" : "mark_read",
                        )
                      }
                    >
                      {selectedMessage?.seen ? (
                        <EyeOff size={17} />
                      ) : (
                        <Eye size={17} />
                      )}
                    </button>
                    <button
                      className="icon-button"
                      title={selectedMessage?.flagged ? "Unflag" : "Flag"}
                      aria-label={selectedMessage?.flagged ? "Unflag" : "Flag"}
                      onClick={() =>
                        void act(selectedMessage?.flagged ? "unflag" : "flag")
                      }
                    >
                      <Star
                        size={17}
                        fill={
                          selectedMessage?.flagged ? "currentColor" : "none"
                        }
                      />
                    </button>
                  </div>
                  <h2>{detail.subject || "(No subject)"}</h2>
                  <div className="reader-sender">
                    <span className="sender-avatar">
                      {senderName.charAt(0)}
                    </span>
                    <div className="reader-addresses">
                      <strong>{senderName}</strong>
                      <small>
                        {sender?.name ? sender.address : address(detail.from)}
                      </small>
                    </div>
                    <time
                      className="reader-date"
                      dateTime={detail.sentAt ?? detail.date}
                    >
                      {new Date(detail.sentAt ?? detail.date).toLocaleString()}
                    </time>
                  </div>
                  <div className="reader-meta">
                    To: {address(detail.to)}
                    {detail.cc.length ? " · Cc: " + address(detail.cc) : ""}
                  </div>
                </header>
                {detail.content.remoteContentBlocked ? (
                  <div className="mail-privacy">
                    <ShieldOff size={15} />
                    Remote content blocked for your privacy
                  </div>
                ) : null}
                <div className="mail-body">
                  {detail.content.status === "ready" ? (
                    detail.content.sanitizedHtml !== null ? (
                      <iframe
                        title="Email content"
                        sandbox=""
                        referrerPolicy="no-referrer"
                        srcDoc={shell(detail.content.sanitizedHtml)}
                      />
                    ) : (
                      <pre>{detail.content.plainText}</pre>
                    )
                  ) : detail.content.status === "failed" ? (
                    <div className="mail-content-failure">
                      <p className="error">
                        <CircleAlert size={15} />{" "}
                        {detail.content.error ?? "Content fetch failed."}
                      </p>
                      <button
                        className="button secondary"
                        onClick={() => void retryContent()}
                        disabled={retrying}
                      >
                        Retry download
                      </button>
                    </div>
                  ) : (
                    <div className="pane-empty">
                      <div
                        className="skeleton"
                        style={{ width: 180, height: 11 }}
                      />
                      <p>Downloading message content…</p>
                    </div>
                  )}
                </div>
                {detail.attachments.length > 0 ? (
                  <div className="mail-attachments">
                    <h3>Attachments</h3>
                    {detail.attachments.map((item, index) => (
                      <span key={index} className="mail-attachment">
                        <Paperclip size={13} />
                        {item.filename ?? "Unnamed attachment"}
                        {item.size
                          ? " · " + Math.ceil(Number(item.size) / 1024) + " KB"
                          : ""}{" "}
                        · Not available yet
                      </span>
                    ))}
                  </div>
                ) : null}
              </>
            ) : null}
          </>
        )}
      </section>
    </main>
  );
}
