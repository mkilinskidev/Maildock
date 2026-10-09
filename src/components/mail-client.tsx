"use client";
import { MailboxTree } from "./mailbox-tree";
import { DesktopNotifications } from "./desktop-notifications";
import { MaildockBrand } from "./maildock-brand";
import { DraftList } from "./draft-list";
import { GlobalSearchResults } from "./global-search-results";
import type { SearchResult } from "@/modules/mail/application/search-service";
import {
  contentPollDelay,
  DEFAULT_CONTENT_POLL_INTERVAL_MS,
} from "@/shared/application/content-polling";
import { FlatMessageList } from "./flat-message-list";
import { ConversationMessageList } from "./conversation-message-list";
import { MailToolbar } from "./mail-toolbar";
import {
  autoReadDelay,
  defaultAutoRead,
  editingTarget,
  type AutoReadPreference,
} from "@/modules/mail/domain/mail-interactions";
import {
  MessageReader,
  type MessageAction,
  type MessageDetail,
} from "./message-reader";
import type { DraftView } from "@/modules/mail/domain/draft";

import Link from "next/link";
import { MailOpen, Plus, RefreshCw, Settings2, Search, X } from "lucide-react";
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

type ActionTarget = {
  id: string;
  accountId: string;
  mailboxId: string;
  seen: boolean;
  flagged: boolean;
};
const targetKey = (item: ActionTarget) =>
  `${item.accountId}:${item.mailboxId}:${item.id}`;

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
  initialAutoRead = defaultAutoRead,
  contentPollIntervalMs = DEFAULT_CONTENT_POLL_INTERVAL_MS,
  initialNotificationsEnabled = false,
  initialNotification,
}: {
  accounts: MailAccountView[];
  mailboxesByAccount: Record<string, MailboxView[]>;
  rolesByAccount: Record<string, MailboxRoleView[]>;
  initialConversationView?: boolean;
  initialAutoRead?: AutoReadPreference;
  contentPollIntervalMs?: number;
  initialNotificationsEnabled?: boolean;
  initialNotification?: {
    accountId: string;
    mailboxId?: string;
    messageId?: string;
  };
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
  const [allInboxes, setAllInboxes] = useState(!initialNotification);
  const [accountId, setAccountId] = useState(
    initialNotification?.accountId ?? first?.id ?? "",
  );
  const [liveMailboxesByAccount, setLiveMailboxesByAccount] =
    useState(mailboxesByAccount);
  const [liveRolesByAccount, setLiveRolesByAccount] = useState(rolesByAccount);
  const [folderReloadNonce, setFolderReloadNonce] = useState(0);
  const folders = liveMailboxesByAccount[accountId] ?? [];
  const [mailboxId, setMailboxId] = useState(
    () =>
      initialNotification?.mailboxId ??
      folders.find((item) => item.remotePath.toUpperCase() === "INBOX")?.id ??
      folders.find((item) => item.selectable)?.id ??
      "",
  );
  const activeLocationRef = useRef(
    allInboxes ? "all-inboxes" : `${accountId}:${mailboxId}`,
  );
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
  const [normalSelectedId, setSelectedId] = useState(
    initialNotification?.messageId ?? "",
  );
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
  const [readerError, setReaderError] = useState("");
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
        targetKey: string;
        feedbackId?: string;
        target: ActionTarget;
        previous?: MessageListItem;
        index: number;
        location: string;
      }
    >
  >({});
  const [bulkSelection, setBulkSelection] = useState<ActionTarget[]>([]);
  const [conversationRows, setConversationRows] = useState<
    Record<string, MessageListItem[]>
  >({});
  const registerConversationRows = useCallback(
    (key: string, rows: MessageListItem[]) => {
      setConversationRows((current) => ({ ...current, [key]: rows }));
    },
    [],
  );
  const activeActions = useRef(new Set<string>());
  const reconciledCommands = useRef(new Set<string>());
  const feedbackGroups = useRef(
    new Map<
      string,
      {
        action: MessageAction;
        remaining: number;
        succeeded: number;
        failed: number;
      }
    >(),
  );
  const [actionFeedback, setActionFeedback] = useState("");
  const [actionError, setActionError] = useState("");
  function finishFeedback(id: string | undefined, succeeded: boolean) {
    if (!id) return;
    const group = feedbackGroups.current.get(id);
    if (!group) return;
    group.remaining--;
    group[succeeded ? "succeeded" : "failed"]++;
    if (group.remaining) return;
    feedbackGroups.current.delete(id);
    const verb = {
      mark_read: "marked as read",
      mark_unread: "marked as unread",
      archive: "archived",
      trash: "moved to Trash",
      flag: "flagged",
      unflag: "unflagged",
    }[group.action];
    setActionFeedback(
      [
        group.succeeded
          ? `${group.succeeded === 1 ? "Message" : `${group.succeeded} messages`} ${verb}`
          : "",
        group.failed
          ? `${group.failed} message action${group.failed === 1 ? "" : "s"} failed`
          : "",
      ]
        .filter(Boolean)
        .join(" · "),
    );
  }
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
    setReaderError("");
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

  const selectedMessage =
    detail?.id === selectedId
      ? detail
      : searchActive
        ? searchSelection
        : ((conversationView ? selectedMember : undefined) ??
          messages.find((item) => item.id === selectedId));
  function canMove(target: ActionTarget, action: "archive" | "trash") {
    const account = accounts.find((item) => item.id === target.accountId);
    const mapping = liveRolesByAccount[target.accountId]?.find(
      (item) => item.role === action,
    );
    return Boolean(
      account?.enabled &&
      (account.capabilities?.moveMessages ??
        account.mailboxDiscovery.capabilities.includes("MOVE")) &&
      mapping?.available &&
      mapping.mailboxId !== target.mailboxId,
    );
  }
  const openedTarget: ActionTarget | undefined =
    selectedId && selectedMessage && (!showDrafts || searchActive)
      ? {
          id: selectedId,
          accountId: actionAccountId,
          mailboxId: actionMailboxId,
          seen: selectedMessage.seen,
          flagged: selectedMessage.flagged,
        }
      : undefined;
  const moveAvailable = (action: "archive" | "trash") =>
    Boolean(openedTarget && canMove(openedTarget, action));

  async function act(
    action: MessageAction,
    explicitTarget?: ActionTarget,
    feedbackId?: string,
    automatic = false,
  ) {
    const target = explicitTarget ?? openedTarget;
    if (!target) return;
    const key = targetKey(target);
    if (
      activeActions.current.has(key) ||
      (action === "mark_read" && target.seen) ||
      ((action === "archive" || action === "trash") && !canMove(target, action))
    ) {
      finishFeedback(feedbackId, false);
      return;
    }
    if (!automatic && !feedbackId) {
      feedbackId = crypto.randomUUID();
      feedbackGroups.current.set(feedbackId, {
        action,
        remaining: 1,
        succeeded: 0,
        failed: 0,
      });
    }
    setActionError("");
    activeActions.current.add(key);
    const targetId = target.id;
    const requestLocation = location;
    const previous = messages.find((item) => item.id === targetId);
    const index = messages.findIndex((item) => item.id === targetId);
    const moving = action === "archive" || action === "trash";
    const countDelta =
      action === "mark_read" && !target.seen
        ? -1
        : action === "mark_unread" && target.seen
          ? 1
          : 0;
    const adjustmentKey = countDelta === 0 ? null : crypto.randomUUID();
    if (adjustmentKey)
      setCountAdjustments((current) => [
        ...current,
        {
          key: adjustmentKey,
          mailboxId: target.mailboxId,
          delta: countDelta,
          completedAt: null,
        },
      ]);
    const flags = {
      seen:
        action === "mark_read"
          ? true
          : action === "mark_unread"
            ? false
            : target.seen,
      flagged:
        action === "flag" ? true : action === "unflag" ? false : target.flagged,
    };
    setError("");
    if (!searchActive && !conversationView) {
      setMessages((current) =>
        moving
          ? current.filter((item) => item.id !== targetId)
          : current.map((item) =>
              item.id === targetId ? { ...item, ...flags } : item,
            ),
      );
    }
    if (openedTarget && targetKey(openedTarget) === key) {
      if (moving) {
        if (searchActive) setSearchSelection(undefined);
        else if (!conversationView && !explicitTarget) {
          const next = messages[index + 1] ?? messages[index - 1];
          setSelectedId(next?.id ?? "");
          setMemberSelection(
            next
              ? {
                  message: { ...next, mailboxId: next.mailboxId ?? mailboxId },
                  location,
                }
              : undefined,
          );
          setLoadingDetail(Boolean(next));
        } else setSelectedId("");
        setDetail(null);
        setReaderError("");
        if (conversationView || searchActive || explicitTarget)
          setLoadingDetail(false);
      } else {
        setDetail((current) =>
          current?.id === targetId ? { ...current, ...flags } : current,
        );
        setMemberSelection((current) =>
          current?.message.id === targetId
            ? { ...current, message: { ...current.message, ...flags } }
            : current,
        );
        setSearchSelection((current) =>
          current?.id === targetId ? { ...current, ...flags } : current,
        );
      }
    }
    setBulkSelection((current) =>
      moving
        ? current.filter((item) => targetKey(item) !== key)
        : current.map((item) =>
            targetKey(item) === key ? { ...item, ...flags } : item,
          ),
    );
    try {
      const response = await fetch(
        `/api/accounts/${target.accountId}/mailboxes/${target.mailboxId}/messages/${targetId}/actions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        },
      );
      const result = (await response.json()) as { id?: string; error?: string };
      if (!response.ok || !result.id)
        throw Error(result.error ?? "Message action could not be queued.");
      setPendingCommands((current) => ({
        ...current,
        [result.id!]: {
          accountId: target.accountId,
          mailboxId: target.mailboxId,
          adjustmentKey,
          targetKey: key,
          feedbackId,
          target,
          previous,
          index,
          location: selectionLocation,
        },
      }));
      if (searchActive) setSearchRefresh((n) => n + 1);
    } catch (failure) {
      activeActions.current.delete(key);
      finishFeedback(feedbackId, false);
      if (adjustmentKey)
        setCountAdjustments((current) =>
          current.filter((item) => item.key !== adjustmentKey),
        );
      if (activeLocationRef.current === requestLocation) {
        // Restore only this item: other queued commands retain their projection.
        if (!searchActive && !conversationView && previous)
          setMessages((current) => {
            if (current.some((item) => item.id === targetId))
              return current.map((item) =>
                item.id === targetId
                  ? { ...item, seen: target.seen, flagged: target.flagged }
                  : item,
              );
            const next = [...current];
            next.splice(Math.max(0, index), 0, {
              ...previous,
              seen: target.seen,
              flagged: target.flagged,
            });
            return next;
          });
        setBulkSelection((current) =>
          current.map((item) => (targetKey(item) === key ? target : item)),
        );
        if (!moving) {
          setDetail((current) =>
            current?.id === targetId
              ? { ...current, seen: target.seen, flagged: target.flagged }
              : current,
          );
          setMemberSelection((current) =>
            current?.message.id === targetId
              ? {
                  ...current,
                  message: {
                    ...current.message,
                    seen: target.seen,
                    flagged: target.flagged,
                  },
                }
              : current,
          );
          setSearchSelection((current) =>
            current?.id === targetId
              ? { ...current, seen: target.seen, flagged: target.flagged }
              : current,
          );
        }
        setRetryNonce((n) => n + 1);
        setSearchRefresh((n) => n + 1);
      }
      setActionError(
        failure instanceof Error
          ? failure.message
          : "Message action could not be queued.",
      );
    }
  }

  const selectionLocation = `${location}:${searchActive}:${showDrafts}:${conversationView}`;
  const [selectionScope, setSelectionScope] = useState(selectionLocation);
  const selectedTargets =
    selectionScope === selectionLocation ? bulkSelection : [];
  if (selectionScope !== selectionLocation) {
    setSelectionScope(selectionLocation);
    setBulkSelection([]);
    setConversationRows({});
  }
  function rowTarget(message: MessageListItem): ActionTarget | undefined {
    const contextAccount = allInboxes ? message.accountId : accountId;
    const contextMailbox = allInboxes
      ? message.mailboxId
      : (message.mailboxId ?? mailboxId);
    if (!contextAccount || !contextMailbox) return;
    return {
      id: message.id,
      accountId: contextAccount,
      mailboxId: contextMailbox,
      seen: message.seen,
      flagged: message.flagged,
    };
  }
  const loadedRows = conversationView
    ? Object.values(conversationRows).flat()
    : messages;
  const loadedTargets = loadedRows
    .map(rowTarget)
    .filter((item): item is ActionTarget => Boolean(item));
  function toggleSelection(message: MessageListItem) {
    const target = rowTarget(message);
    if (!target) return;
    setBulkSelection((current) =>
      current.some((item) => targetKey(item) === targetKey(target))
        ? current.filter((item) => targetKey(item) !== targetKey(target))
        : [...current, target],
    );
  }
  async function bulkAct(action: MessageAction) {
    const targets = selectedTargets
      .map((target) =>
        openedTarget && targetKey(openedTarget) === targetKey(target)
          ? openedTarget
          : (loadedTargets.find(
              (item) => targetKey(item) === targetKey(target),
            ) ?? target),
      )
      .filter(
        (target) =>
          !activeActions.current.has(targetKey(target)) &&
          (action !== "mark_read" || !target.seen) &&
          (action !== "mark_unread" || target.seen),
      );
    if (
      !targets.length ||
      ((action === "archive" || action === "trash") &&
        !targets.every((target) => canMove(target, action)))
    )
      return;
    const id = crypto.randomUUID();
    feedbackGroups.current.set(id, {
      action,
      remaining: targets.length,
      succeeded: 0,
      failed: 0,
    });
    await Promise.allSettled(targets.map((target) => act(action, target, id)));
  }

  const autoReadAction = useRef(act);
  useEffect(() => {
    autoReadAction.current = act;
  });
  const attemptedAutoRead = useRef("");
  const openKey =
    !composing && !showDrafts && openedTarget
      ? `${selectionLocation}:${targetKey(openedTarget)}`
      : "";
  const autoReadSeen = openedTarget?.seen;
  useEffect(() => {
    attemptedAutoRead.current = "";
  }, [openKey]);
  useEffect(() => {
    const delay = autoReadDelay(initialAutoRead);
    if (
      !openKey ||
      autoReadSeen !== false ||
      delay === null ||
      attemptedAutoRead.current === openKey
    )
      return;
    const timer = setTimeout(() => {
      attemptedAutoRead.current = openKey;
      void autoReadAction.current("mark_read", undefined, undefined, true);
    }, delay);
    return () => clearTimeout(timer);
  }, [openKey, autoReadSeen, initialAutoRead]);

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        event.altKey ||
        editingTarget(event.target)
      )
        return;
      if (event.ctrlKey || event.metaKey) {
        if (composing && event.key === "Enter" && !event.shiftKey) {
          const form =
            document.querySelector<HTMLFormElement>("form.mail-composer");
          if (form) {
            event.preventDefault();
            form.requestSubmit();
          }
        }
        return;
      }
      if (composing || event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key === "c" && accounts.some(sendingAccountAvailable)) {
        event.preventDefault();
        preparationGeneration.current++;
        setPreparing(false);
        setDraft(undefined);
        setPrefill(undefined);
        setComposing(true);
      } else if (
        !selectedTargets.length &&
        openedTarget &&
        ["r", "a", "f"].includes(key)
      ) {
        event.preventDefault();
        void prepare(
          key === "r" ? "reply" : key === "a" ? "reply_all" : "forward",
        );
      } else if (
        event.key === "Delete" &&
        (selectedTargets.length
          ? selectedTargets.every((item) => canMove(item, "trash"))
          : moveAvailable("trash"))
      ) {
        event.preventDefault();
        void (selectedTargets.length ? bulkAct("trash") : act("trash"));
      }
    }
    document.addEventListener("keydown", shortcut);
    return () => document.removeEventListener("keydown", shortcut);
  });

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
      const batches = [...idsByAccount].flatMap(([id, ids]) =>
        Array.from(
          { length: Math.ceil(ids.length / 50) },
          (_, index) => [id, ids.slice(index * 50, (index + 1) * 50)] as const,
        ),
      );
      for (const [commandAccountId, ids] of batches)
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
              (item) =>
                !reconciledCommands.current.has(item.id) &&
                (item.status === "failed" || item.status === "succeeded"),
            );
            if (!finished.length) return;
            for (const item of finished) {
              reconciledCommands.current.add(item.id);
              const command = pendingCommands[item.id];
              if (command) {
                activeActions.current.delete(command.targetKey);
                finishFeedback(command.feedbackId, item.status === "succeeded");
                if (
                  item.status === "failed" &&
                  command.location === selectionLocation
                ) {
                  const target = command.target;
                  if (!searchActive && !conversationView && command.previous) {
                    const previous = command.previous;
                    setMessages((current) => {
                      if (current.some((message) => message.id === target.id))
                        return current.map((message) =>
                          message.id === target.id
                            ? {
                                ...message,
                                seen: target.seen,
                                flagged: target.flagged,
                              }
                            : message,
                        );
                      const next = [...current];
                      next.splice(Math.max(0, command.index), 0, previous);
                      return next;
                    });
                  }
                  setDetail((current) =>
                    current?.id === target.id
                      ? {
                          ...current,
                          seen: target.seen,
                          flagged: target.flagged,
                        }
                      : current,
                  );
                  setMemberSelection((current) =>
                    current?.message.id === target.id
                      ? {
                          ...current,
                          message: {
                            ...current.message,
                            seen: target.seen,
                            flagged: target.flagged,
                          },
                        }
                      : current,
                  );
                  setSearchSelection((current) =>
                    current?.id === target.id
                      ? {
                          ...current,
                          seen: target.seen,
                          flagged: target.flagged,
                        }
                      : current,
                  );
                  setBulkSelection((current) =>
                    current.filter(
                      (item) => targetKey(item) !== command.targetKey,
                    ),
                  );
                }
              }
            }
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
              setActionError(failure.error ?? "Message action failed.");
              const source = pendingCommands[failure.id];
              if (
                source &&
                (source.accountId === accountId || searchActive || allInboxes)
              ) {
                setRetryNonce((n) => n + 1);
                setListReloadNonce((n) => n + 1);
                setSearchRefresh((n) => n + 1);
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
    selectionLocation,
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
              setReaderError("");
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
    if (!selectedId || (showDrafts && !searchActive)) return;
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
        setReaderError(
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
    showDrafts,
  ]);

  async function retryContent() {
    if (!selectedId) return;
    setRetrying(true);
    setReaderError("");
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
      setReaderError(
        failure instanceof Error
          ? failure.message
          : "Content could not be requested.",
      );
    } finally {
      setRetrying(false);
    }
  }

  async function refresh() {
    if (!mailboxId || refreshing) return;
    setRefreshing(true);
    setError("");
    try {
      const response = await fetch(`${base}/refresh`, { method: "POST" });
      if (!response.ok)
        throw new Error("Synchronization could not be requested.");
      setActionFeedback(
        "Sync requested. Messages update as synchronization completes.",
      );
      const result = await fetch(`${base}?pageSize=50`);
      if (!result.ok)
        throw new Error(
          "Sync was requested, but the message list could not be refreshed. Please retry.",
        );
      applyFirstPage((await result.json()) as MessagePage);
      setFolderReloadNonce((value) => value + 1);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Synchronization could not be requested. Please retry.",
      );
    } finally {
      setRefreshing(false);
    }
  }

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
    setReaderError("");
    setError("");
    setLoadingDetail(false);
    setLoadingMessages(all || Boolean(nextMailboxId));
    activeLocationRef.current = all
      ? "all-inboxes"
      : `${nextAccountId}:${nextMailboxId}`;
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
      {initialNotificationsEnabled ? (
        <DesktopNotifications
          onOpen={(event) => {
            navigate(event.accountId, event.mailboxId);
            setComposing(false);
            setBulkSelection([]);
            setSelectedId(event.messageId);
            setMemberSelection(undefined);
            setDetail(null);
            setReaderError("");
            setLoadingDetail(true);
            setListReloadNonce((value) => value + 1);
          }}
        />
      ) : null}
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
              setReaderError("");
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
                setReaderError("");
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
          <MaildockBrand />
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
            if (!composing) {
              setSelectedId("");
              setMemberSelection(undefined);
              setDetail(null);
              setReaderError("");
              setLoadingDetail(false);
            }
            setReaderError("");
            setError("");
            setDraftListGeneration((n) => n + 1);
          }}
        />
        {!accounts.length ? (
          <div className="pane-empty">
            <strong>No accounts yet</strong>
            <p>
              <Link href="/accounts?add=1">Add an account</Link> to see your
              mailboxes.
            </p>
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
                  ? "Maildock drafts"
                  : allInboxes
                    ? "All Inboxes"
                    : (folder?.name ?? "Mail")}
            </h1>
            <small>
              {searchActive
                ? "All accounts · All mailboxes"
                : showDrafts
                  ? "Saved in Maildock · Not synced to your email provider"
                  : allInboxes
                    ? "Enabled accounts · Inbox mailboxes"
                    : folder
                      ? formatCount(folder.synchronizedMessageCount) +
                        " synchronized messages"
                      : "Select a mailbox"}
            </small>
          </div>
          <div className="mail-pane-controls">
            {!searchActive && !showDrafts ? (
              <label
                className="mail-select-all"
                title="Select all loaded messages"
              >
                <input
                  type="checkbox"
                  aria-label="Select all loaded messages"
                  disabled={!loadedTargets.length}
                  checked={
                    Boolean(loadedTargets.length) &&
                    loadedTargets.every((target) =>
                      selectedTargets.some(
                        (item) => targetKey(item) === targetKey(target),
                      ),
                    )
                  }
                  onChange={(event) =>
                    setBulkSelection(event.target.checked ? loadedTargets : [])
                  }
                />
              </label>
            ) : null}
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
              <RefreshCw
                size={17}
                className={refreshing ? "animate-spin" : ""}
              />
            </button>
          </div>
        </header>
        {error || actionError ? (
          <p className="mail-error error" role="alert">
            {actionError || error}
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
              setReaderError("");
              setLoadingDetail(true);
              setError("");
            }}
          />
        ) : showDrafts ? (
          <DraftList
            disabled={composing}
            accounts={accounts}
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
                onLoaded={registerConversationRows}
                checkedIds={selectedTargets.map(targetKey)}
                onToggle={toggleSelection}
                refreshKey={retryNonce + folderReloadNonce + listReloadNonce}
                onSelect={(message) =>
                  selectMessage(message, message.mailboxId ?? mailboxId)
                }
              />
            ) : (
              <FlatMessageList
                checkedIds={selectedTargets.map((item) => item.id)}
                onToggle={toggleSelection}
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
                  {!accounts.length ||
                  !accounts.some((a) => a.enabled) ||
                  mailboxId ||
                  allInboxes
                    ? !accounts.length
                      ? "Add your first email account"
                      : !accounts.some((a) => a.enabled)
                        ? "All accounts are disabled"
                        : folder &&
                            [
                              folder.recentSync?.status,
                              folder.deltaSync?.status,
                            ].includes("failed")
                          ? "Mail could not be synchronized"
                          : folder &&
                              !folder.recentSync?.lastSuccessfulAt &&
                              !folder.deltaSync?.lastSuccessfulAt
                            ? "Waiting for mail to sync"
                            : "No messages"
                    : "No mailbox selected"}
                </strong>
                <p>
                  {!accounts.length ||
                  !accounts.some((a) => a.enabled) ||
                  mailboxId ||
                  allInboxes
                    ? !accounts.length
                      ? "Add an account in Settings to start reading and sending mail."
                      : !accounts.some((a) => a.enabled)
                        ? "Enable an account in Settings to synchronize mail."
                        : folder &&
                            [
                              folder.recentSync?.status,
                              folder.deltaSync?.status,
                            ].includes("failed")
                          ? "Check account Diagnostics in Settings, then request sync again."
                          : folder &&
                              !folder.recentSync?.lastSuccessfulAt &&
                              !folder.deltaSync?.lastSuccessfulAt
                            ? "Messages will appear as synchronization completes."
                            : "This mailbox has no messages to display."
                    : "Choose a mailbox from the sidebar."}
                </p>
                {!accounts.length ? (
                  <Link className="button-link" href="/accounts?add=1">
                    Add account
                  </Link>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </section>
      <section
        className={`mail-detail-pane${!composing && detail ? " mail-reader" : ""}`}
        aria-label="Message detail"
      >
        {actionFeedback ? (
          <div className="send-feedback" role="status">
            {actionFeedback}
            <button
              className="icon-button"
              aria-label="Dismiss action status"
              onClick={() => setActionFeedback("")}
            >
              ×
            </button>
          </div>
        ) : null}
        {!composing && (selectedTargets.length || openedTarget) ? (
          <MailToolbar
            count={selectedTargets.length}
            seen={openedTarget?.seen}
            flagged={openedTarget?.flagged}
            preparing={preparing}
            prepare={prepare}
            act={(action) =>
              selectedTargets.length ? bulkAct(action) : act(action)
            }
            moveAvailable={(action) =>
              selectedTargets.length
                ? selectedTargets.every((item) => canMove(item, action))
                : moveAvailable(action)
            }
          />
        ) : null}
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
            hideActions
            emptyTitle={showDrafts ? "Select a draft" : undefined}
            emptyDescription={
              showDrafts
                ? "Choose a Maildock draft to continue writing."
                : undefined
            }
            readerError={readerError}
            retryMessage={() => {
              setReaderError("");
              setLoadingDetail(true);
              setRetryNonce((n) => n + 1);
            }}
            providerDrafts={
              !searchActive &&
              !showDrafts &&
              liveRolesByAccount[accountId]?.some(
                (role) =>
                  role.role === "drafts" &&
                  role.available &&
                  role.mailboxId === mailboxId,
              )
            }
            contentPollIntervalMs={contentPollIntervalMs}
            renderUrl={`${messageBase}/${selectedId}/render`}
            selectedId={showDrafts && !searchActive ? "" : selectedId}
            detail={showDrafts && !searchActive ? null : detail}
            loadingDetail={showDrafts && !searchActive ? false : loadingDetail}
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
