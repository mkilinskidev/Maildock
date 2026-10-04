"use client";
import { MailboxTree } from "./mailbox-tree";
import { DraftList } from "./draft-list";
import { GlobalSearchResults } from "./global-search-results";
import type { SearchResult } from "@/modules/mail/application/search-service";
import {
  contentPollDelay,
  DEFAULT_CONTENT_POLL_INTERVAL_MS,
} from "@/shared/application/content-polling";
import { FlatMessageList } from "./flat-message-list";
import { ConversationMessageList } from "./conversation-message-list";
import { MessageReader, type MessageDetail } from "./message-reader";
import type { DraftView } from "@/modules/mail/domain/draft";

import Link from "next/link";
import {
  Mail,
  MailOpen,
  Plus,
  RefreshCw,
  Settings2,
  Search,
  X,
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

import type {
  ComposeMode,
  ComposePrefill,
} from "@/modules/mail/domain/compose-source";

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
type CountAdjustment = {
  key: string;
  mailboxId: string;
  delta: number;
  completedAt: string | null;
};
function formatCount(value: string): string {
  return new Intl.NumberFormat().format(BigInt(value));
}

export function MailClient({
  accounts,
  mailboxesByAccount,
  rolesByAccount,
  initialConversationView = false,
  contentPollIntervalMs = DEFAULT_CONTENT_POLL_INTERVAL_MS,
}: {
  accounts: MailAccountView[];
  mailboxesByAccount: Record<string, MailboxView[]>;
  rolesByAccount: Record<string, MailboxRoleView[]>;
  initialConversationView?: boolean;
  contentPollIntervalMs?: number;
}) {
  const conversationView = initialConversationView;
  const listModeRef = useRef(conversationView);
  const [listReloadNonce, setListReloadNonce] = useState(0);
  const [memberSelection, setMemberSelection] = useState<{
    message: MessageListItem & { mailboxId: string };
    location: string;
  }>();
  const [showDrafts, setShowDrafts] = useState(false);
  const [draft, setDraft] = useState<DraftView | undefined>();
  const [draftListGeneration, setDraftListGeneration] = useState(0);
  const first = accounts[0];
  const [prefill, setPrefill] = useState<ComposePrefill | undefined>();
  const [preparingState, setPreparing] = useState(false);
  const [prepareErrorState, setPrepareError] = useState("");
  const preparationGeneration = useRef(0);
  const [prepareLocation, setPrepareLocation] = useState("");
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
  const [allInboxes, setAllInboxes] = useState(false);
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
  const [normalSelectedId, setSelectedId] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchSelection, setSearchSelection] = useState<SearchResult>();
  const [searchRefresh, setSearchRefresh] = useState(0);
  const searchActive = Boolean(searchQuery.trim());
  const selectedId = searchActive
    ? (searchSelection?.id ?? "")
    : normalSelectedId;
  const [detail, setDetail] = useState<MessageDetail | null>(null);
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
  const base = allInboxes
    ? "/api/mail/all-inboxes"
    : `/api/accounts/${accountId}/mailboxes/${mailboxId}/messages`;
  const location = allInboxes ? "all-inboxes" : `${accountId}:${mailboxId}`;
  const selectedMember =
    (conversationView || allInboxes) &&
    memberSelection?.location === location &&
    memberSelection.message.id === selectedId
      ? memberSelection.message
      : undefined;
  function selectMessage(message: MessageListItem, placementMailboxId: string) {
    if (
      selectedId === message.id &&
      (selectedMember?.mailboxId ?? mailboxId) === placementMailboxId
    )
      return;
    setMemberSelection({
      message: { ...message, mailboxId: placementMailboxId },
      location,
    });
    setSelectedId(message.id);
    setDetail(null);
    setLoadingDetail(true);
    setError("");
  }
  const inboxSelection = allInboxes
    ? (selectedMember ?? messages.find((item) => item.id === selectedId))
    : undefined;
  const actionAccountId = searchActive
    ? (searchSelection?.accountId ?? accountId)
    : (inboxSelection?.accountId ?? accountId);
  const actionMailboxId = searchActive
    ? (searchSelection?.mailboxId ?? mailboxId)
    : (inboxSelection?.mailboxId ?? selectedMember?.mailboxId ?? mailboxId);
  const messageBase = `/api/accounts/${actionAccountId}/mailboxes/${actionMailboxId}/messages`;
  const preparationKey = `${actionAccountId}:${actionMailboxId}:${selectedId}`;
  const preparing = preparingState && prepareLocation === preparationKey;
  const prepareError =
    prepareLocation === preparationKey ? prepareErrorState : "";

  useEffect(() => {
    const generation = preparationGeneration;
    generation.current++;
    return () => {
      generation.current++;
    };
  }, [accountId, mailboxId, actionAccountId, actionMailboxId, selectedId]);
  async function prepare(mode: ComposeMode) {
    if (!selectedId || preparing) return;
    const generation = ++preparationGeneration.current;
    setPrepareLocation(preparationKey);
    setPreparing(true);
    setPrepareError("");
    try {
      for (let attempt = 0; attempt < 60; attempt++) {
        const response = await fetch(
          `${messageBase}/${selectedId}/prepare?mode=${mode}`,
          { method: "POST" },
        );
        const result = (await response.json()) as {
          status?: string;
          prefill?: ComposePrefill;
          error?: string;
        };
        if (generation !== preparationGeneration.current) return;
        if (!response.ok)
          throw Error(result.error ?? "Message could not be prepared.");
        if (result.status === "ready" && result.prefill) {
          setDraft(undefined);
          setPrefill(result.prefill);
          setComposing(true);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (generation !== preparationGeneration.current) return;
      }
      throw Error("Content is still loading. Please try again shortly.");
    } catch (error) {
      if (generation === preparationGeneration.current)
        setPrepareError(
          error instanceof Error
            ? error.message
            : "Message could not be prepared.",
        );
    } finally {
      if (generation === preparationGeneration.current) setPreparing(false);
    }
  }

  const selectedMessage = searchActive
    ? searchSelection
    : conversationView && detail?.id === selectedId
      ? detail
      : ((conversationView ? selectedMember : undefined) ??
        messages.find((item) => item.id === selectedId));
  const moveAvailable = (action: "archive" | "trash") => {
    const mapping = liveRolesByAccount[actionAccountId]?.find(
      (item) => item.role === action,
    );
    return Boolean(
      readerAccount?.enabled &&
      readerAccount.mailboxDiscovery.capabilities.includes("MOVE") &&
      mapping?.available &&
      mapping.mailboxId !== actionMailboxId,
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
        {
          key: adjustmentKey,
          mailboxId: actionMailboxId,
          delta: countDelta,
          completedAt: null,
        },
      ]);
    setError("");
    if (
      !searchActive &&
      !conversationView &&
      (action === "archive" || action === "trash")
    ) {
      const index = messages.findIndex((item) => item.id === targetId);
      const next = messages[index + 1] ?? messages[index - 1];
      setMessages((current) => current.filter((item) => item.id !== targetId));
      setSelectedId(next?.id ?? "");
      setDetail(null);
      setLoadingDetail(Boolean(next));
    } else if (!searchActive && !conversationView) {
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
      const response = await fetch(`${messageBase}/${targetId}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const result = (await response.json()) as { id?: string; error?: string };
      if (!response.ok || !result.id)
        throw new Error(result.error ?? "Message action could not be queued.");
      setPendingCommands((current) => ({
        ...current,
        [result.id!]: {
          accountId: actionAccountId,
          mailboxId: actionMailboxId,
          adjustmentKey,
        },
      }));
      if (searchActive) {
        setSearchRefresh((n) => n + 1);
        if (action === "archive" || action === "trash") {
          setSearchSelection((current) =>
            current?.id === targetId ? undefined : current,
          );
          setDetail((current) => (current?.id === targetId ? null : current));
        } else {
          setSearchSelection((current) =>
            current?.id === targetId
              ? {
                  ...current,
                  seen:
                    action === "mark_read"
                      ? true
                      : action === "mark_unread"
                        ? false
                        : current.seen,
                  flagged:
                    action === "flag"
                      ? true
                      : action === "unflag"
                        ? false
                        : current.flagged,
                }
              : current,
          );
        }
      }
    } catch (failure) {
      if (adjustmentKey)
        setCountAdjustments((current) =>
          current.filter((item) => item.key !== adjustmentKey),
        );
      if (activeLocationRef.current === `${accountId}:${mailboxId}`) {
        if (!searchActive) {
          setMessages(previous);
          setSelectedId(targetId);
        }
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
            if (finished.some((item) => item.status === "succeeded")) {
              setFolderReloadNonce((value) => value + 1);
              if (conversationView) {
                setListReloadNonce((value) => value + 1);
                setRetryNonce((value) => value + 1);
              }
            }
            const failure = finished.find((item) => item.status === "failed");
            if (failure) {
              const source = pendingCommands[failure.id];
              if (
                source &&
                (source.accountId === accountId || searchActive || allInboxes)
              ) {
                setError(failure.error ?? "Message action failed.");
                if (source.mailboxId === mailboxId || allInboxes)
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
  }, [
    accountId,
    mailboxId,
    base,
    pendingCommands,
    conversationView,
    searchActive,
    actionAccountId,
    allInboxes,
  ]);

  const applyFirstPage = useCallback((page: MessagePage) => {
    setMessages((current) => {
      if (!loadedMoreRef.current) return [...page.items];
      const firstPageIds = new Set(page.items.map((item) => item.id));
      const firstPageConversations = new Set(
        page.items.map((item) => item.conversationId).filter(Boolean),
      );
      return [
        ...page.items,
        ...current.filter(
          (item) =>
            !firstPageIds.has(item.id) &&
            !firstPageConversations.has(item.conversationId),
        ),
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
      void Promise.allSettled(
        accounts.map(async ({ id: pollAccountId }) => {
          return fetch(`/api/accounts/${pollAccountId}/mailboxes`, {
            cache: "no-store",
          })
            .then(async (response) => {
              if (!response.ok)
                throw new Error("Mailboxes could not be loaded.");
              return response.json() as Promise<{
                mailboxes: MailboxView[];
                roles: MailboxRoleView[];
              }>;
            })
            .then((result) => {
              if (!cancelled) {
                setLiveMailboxesByAccount((current) => ({
                  ...current,
                  [pollAccountId]: result.mailboxes,
                }));
                setLiveRolesByAccount((current) => ({
                  ...current,
                  [pollAccountId]: result.roles,
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
            });
        }),
      ).finally(() => {
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
  }, [accounts, accountId, folderReloadNonce]);

  useEffect(() => {
    if (!allInboxes && (!accountId || !mailboxId)) return;
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
            if (listModeRef.current !== conversationView) {
              listModeRef.current = conversationView;
              loadedMoreRef.current = false;
              loadingPageRef.current = false;
              pageRequestIdRef.current++;
              setLoadingMore(false);
              setPaginationError("");
              setSelectedId("");
              setMemberSelection(undefined);
              setDetail(null);
              listRef.current?.scrollTo({ top: 0 });
            }
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
  }, [
    accountId,
    mailboxId,
    base,
    applyFirstPage,
    allInboxes,
    conversationView,
    listReloadNonce,
  ]);

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
              const existingConversations = new Set(
                current.map((item) => item.conversationId).filter(Boolean),
              );
              return [
                ...current,
                ...page.items.filter(
                  (item) =>
                    !existingIds.has(item.id) &&
                    !existingConversations.has(item.conversationId),
                ),
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
    const url = `${messageBase}/${selectedId}`;
    const startedAt = Date.now();
    const controller = new AbortController();
    function scheduleNext() {
      if (cancelled) return;
      timer = setTimeout(
        () => void load().catch(handleError),
        contentPollDelay(contentPollIntervalMs, Date.now() - startedAt),
      );
    }
    async function load() {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error("Message could not be loaded.");
      const value = (await response.json()) as MessageDetail;
      if (cancelled) return;
      setDetail(value);
      setLoadingDetail(false);
      if (value.content.status === "not_fetched") {
        const queued = await fetch(`${url}/content`, {
          method: "POST",
          signal: controller.signal,
        });
        if (!queued.ok) {
          const body = (await queued.json()) as { error?: string };
          throw new Error(body.error ?? "Content could not be requested.");
        }
        scheduleNext();
      } else if (
        value.content.status === "pending" ||
        value.content.status === "fetching"
      ) {
        scheduleNext();
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
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [
    messageBase,
    selectedId,
    retryNonce,
    contentPollIntervalMs,
    searchActive,
  ]);

  async function retryContent() {
    if (!selectedId) return;
    setRetrying(true);
    setError("");
    try {
      const response = await fetch(`${messageBase}/${selectedId}/content`, {
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

  const readerAccount = accounts.find(
    (account) => account.id === actionAccountId,
  );
  function navigate(nextAccountId: string, nextMailboxId: string, all = false) {
    setSearchQuery("");
    setSearchSelection(undefined);
    setShowDrafts(false);
    if (
      all === allInboxes &&
      nextAccountId === accountId &&
      nextMailboxId === mailboxId
    )
      return;
    setMessages([]);
    setNextCursor(null);
    setPaginationError("");
    setLoadingMore(false);
    pageRequestIdRef.current++;
    loadingPageRef.current = false;
    loadedMoreRef.current = false;
    listRef.current?.scrollTo({ top: 0 });
    setSelectedId("");
    setMemberSelection(undefined);
    setDetail(null);
    setError("");
    setLoadingDetail(false);
    setLoadingMessages(all || Boolean(nextMailboxId));
    activeLocationRef.current = `${nextAccountId}:${nextMailboxId}`;
    setAccountId(nextAccountId);
    setMailboxId(nextMailboxId);
    setAllInboxes(all);
  }
  function unread(item: MailboxView) {
    if (item.unseenCount === null) return null;
    const projected =
      BigInt(item.unseenCount) +
      BigInt(
        countAdjustments
          .filter((a) => a.mailboxId === item.id)
          .reduce((sum, a) => sum + a.delta, 0),
      );
    return projected > 0n ? projected.toString() : null;
  }

  return (
    <main className="mail-app">
      <header className="app-bar">
        <button
          className="button compose-action"
          disabled={composing || !accounts.some(sendingAccountAvailable)}
          onClick={() => {
            preparationGeneration.current++;
            setPreparing(false);
            setDraft(undefined);
            setPrefill(undefined);
            setComposing(true);
          }}
        >
          <Plus size={15} />
          New message
        </button>
        <div className="global-search-input">
          <Search size={16} aria-hidden="true" />
          <input
            aria-label="Search all mail"
            placeholder="Search all mail..."
            maxLength={256}
            value={searchQuery}
            onChange={(event) => {
              setSearchQuery(event.target.value);
              setSearchSelection(undefined);
              if (searchActive || event.target.value.trim()) setDetail(null);
              setError("");
              setLoadingDetail(
                searchActive &&
                  !event.target.value.trim() &&
                  Boolean(normalSelectedId),
              );
            }}
          />
          {searchQuery ? (
            <button
              className="icon-button"
              aria-label="Clear search"
              onClick={() => {
                setSearchQuery("");
                setSearchSelection(undefined);
                if (searchActive) setDetail(null);
                setError("");
                setLoadingDetail(searchActive && Boolean(normalSelectedId));
              }}
            >
              <X size={15} />
            </button>
          ) : null}
        </div>
        <div className="app-bar-right">
          <span>Personal mail</span>
          <ThemeControl />
        </div>
      </header>
      <aside className="mail-sidebar">
        <div className="sidebar-brand">
          <Mail size={18} />
          Maildock
        </div>
        <MailboxTree
          accounts={accounts}
          boxes={liveMailboxesByAccount}
          roles={liveRolesByAccount}
          accountId={accountId}
          mailboxId={mailboxId}
          allInboxes={allInboxes}
          showDrafts={showDrafts}
          searchActive={searchActive}
          unread={unread}
          onSelect={navigate}
          onDrafts={() => {
            setSearchQuery("");
            setSearchSelection(undefined);
            setShowDrafts(true);
            setDraftListGeneration((n) => n + 1);
          }}
        />
        {!accounts.length ? (
          <div className="pane-empty">
            <strong>No accounts yet</strong>
            <p>Add an account to see your mailboxes.</p>
          </div>
        ) : null}
        <div className="mail-sidebar-footer">
          <Link href="/accounts">
            <Settings2 size={15} />
            Accounts & settings
          </Link>
          <LogoutButton />
        </div>
      </aside>
      <section className="mail-list-pane" aria-label="Messages">
        <header className="mail-pane-header">
          <div>
            <h1>
              {searchActive
                ? "Search results"
                : showDrafts
                  ? "Local drafts"
                  : allInboxes
                    ? "All Inboxes"
                    : (folder?.name ?? "Mail")}
            </h1>
            <small>
              {searchActive
                ? "All accounts · All mailboxes"
                : showDrafts
                  ? "Stored in Maildock only"
                  : allInboxes
                    ? "Enabled accounts · Inbox mailboxes"
                    : folder
                      ? formatCount(folder.synchronizedMessageCount) +
                        " synchronized messages"
                      : "Select a mailbox"}
            </small>
          </div>
          <button
            className="icon-button"
            onClick={() => void refresh()}
            disabled={
              searchActive ||
              showDrafts ||
              refreshing ||
              !mailboxId ||
              allInboxes
            }
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
        {searchActive ? (
          <GlobalSearchResults
            key={searchQuery}
            query={searchQuery}
            selectedId={selectedId}
            refreshKey={searchRefresh + folderReloadNonce}
            onSelect={(item) => {
              if (
                searchSelection?.id === item.id &&
                searchSelection.accountId === item.accountId &&
                searchSelection.mailboxId === item.mailboxId
              )
                return;
              setSearchSelection(item);
              setDetail(null);
              setLoadingDetail(true);
              setError("");
            }}
          />
        ) : showDrafts ? (
          <DraftList
            disabled={composing}
            refreshKey={draftListGeneration}
            onResume={(value) => {
              if (composing) return;
              setDraft(value);
              setPrefill(undefined);
              setComposing(true);
            }}
          />
        ) : (
          <div className="mail-rows" ref={listRef}>
            {loadingMessages && (mailboxId || allInboxes) ? (
              Array.from({ length: 5 }, (_, index) => (
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
            ) : conversationView ? (
              <ConversationMessageList
                key={location}
                accountId={accountId}
                mailboxId={mailboxId}
                messages={messages}
                selectedId={selectedId}
                refreshKey={retryNonce + folderReloadNonce + listReloadNonce}
                onSelect={(message) =>
                  selectMessage(message, message.mailboxId ?? mailboxId)
                }
              />
            ) : (
              <FlatMessageList
                messages={messages}
                selectedId={selectedId}
                onSelect={(message) =>
                  selectMessage(message, message.mailboxId ?? mailboxId)
                }
              />
            )}

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
                  {mailboxId || allInboxes
                    ? "Nothing here yet"
                    : "No mailbox selected"}
                </strong>
                <p>
                  {mailboxId || allInboxes
                    ? "Messages will appear here when synchronized."
                    : "Choose a mailbox from the sidebar."}
                </p>
              </div>
            ) : null}
          </div>
        )}
      </section>
      <section
        className={`mail-detail-pane${!composing && detail ? " mail-reader" : ""}`}
        aria-label="Message detail"
      >
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
            key={draft?.id ?? "compose"}
            draft={draft}
            accounts={accounts}
            accountId={prefill?.accountId ?? accountId}
            prefill={prefill}
            onSaved={() => setDraftListGeneration((n) => n + 1)}
            onClose={() => {
              setComposing(false);
              setDraft(undefined);
              setDraftListGeneration((n) => n + 1);
            }}
            onQueued={(id) => {
              setOutgoing((current) => ({
                ...current,
                [id]: { status: "queued" },
              }));
              setComposing(false);
              setDraft(undefined);
              setDraftListGeneration((n) => n + 1);
            }}
          />
        ) : (
          <MessageReader
            contentPollIntervalMs={contentPollIntervalMs}
            renderUrl={`${messageBase}/${selectedId}/render`}
            selectedId={selectedId}
            detail={detail}
            loadingDetail={loadingDetail}
            selectedMessage={selectedMessage}
            preparing={preparing}
            prepareError={prepareError}
            retrying={retrying}
            prepare={prepare}
            act={act}
            moveAvailable={moveAvailable}
            retryContent={retryContent}
          />
        )}
      </section>
    </main>
  );
}
