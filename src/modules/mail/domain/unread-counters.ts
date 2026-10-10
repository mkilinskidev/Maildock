import type { MailboxView } from "../application/mailbox-service";

export type CountAdjustment = {
  key: string;
  mailboxId: string;
  delta: number;
  completedAt: string | null;
};
export type UnreadCounterState = {
  boxes: Record<string, MailboxView[]>;
  adjustments: CountAdjustment[];
};

export function applyMailboxCounterSnapshot(
  state: UnreadCounterState,
  accountId: string,
  incoming: MailboxView[],
): UnreadCounterState {
  const previous = state.boxes[accountId] ?? [];
  const merged = mergeMailboxCounters(previous, incoming, state.adjustments);
  const remaining = state.adjustments.filter((adjustment) => {
    const mailbox = merged.find((item) => item.id === adjustment.mailboxId);
    return !mailbox || !counterIncludesAction(mailbox, adjustment);
  });
  const adjustments =
    remaining.length === state.adjustments.length
      ? state.adjustments
      : remaining;
  if (merged === previous && adjustments === state.adjustments) return state;
  return {
    boxes:
      merged === previous
        ? state.boxes
        : { ...state.boxes, [accountId]: merged },
    adjustments,
  };
}

export function counterObservedAt(mailbox: MailboxView) {
  return mailbox.unseenCountObservedAt === undefined
    ? mailbox.deltaSync.lastSuccessfulAt
    : mailbox.unseenCountObservedAt;
}

export function counterIncludesAction(
  mailbox: MailboxView,
  adjustment: CountAdjustment,
) {
  const observedAt = counterObservedAt(mailbox);
  return Boolean(
    adjustment.completedAt &&
    observedAt &&
    Date.parse(observedAt) > Date.parse(adjustment.completedAt),
  );
}

export function mergeMailboxCounters(
  current: MailboxView[],
  incoming: MailboxView[],
  adjustments: readonly CountAdjustment[],
): MailboxView[] {
  const merged = incoming.map((mailbox) => {
    const previous = current.find((item) => item.id === mailbox.id);
    if (!previous) return mailbox;
    const oldTime = counterObservedAt(previous);
    const newTime = counterObservedAt(mailbox);
    // A remote count may already include a command whose status has not reached
    // the browser. Hold the baseline until that command's completion is known.
    const pending = adjustments.some(
      (item) => item.mailboxId === mailbox.id && !item.completedAt,
    );
    const stale =
      oldTime && (!newTime || Date.parse(newTime) < Date.parse(oldTime));
    return pending || stale
      ? {
          ...mailbox,
          unseenCount: previous.unseenCount,
          unseenCountObservedAt: previous.unseenCountObservedAt,
          ...(mailbox.unseenCountObservedAt === undefined
            ? {
                deltaSync: {
                  ...mailbox.deltaSync,
                  lastSuccessfulAt: previous.deltaSync.lastSuccessfulAt,
                },
              }
            : {}),
        }
      : mailbox;
  });
  return JSON.stringify(merged) === JSON.stringify(current) ? current : merged;
}

export function projectedUnreadCount(
  mailbox: MailboxView,
  adjustments: readonly CountAdjustment[],
): string | null {
  if (mailbox.unseenCount === null) return null;
  const delta = adjustments
    .filter(
      (item) =>
        item.mailboxId === mailbox.id && !counterIncludesAction(mailbox, item),
    )
    .reduce((sum, item) => sum + item.delta, 0);
  const count = BigInt(mailbox.unseenCount) + BigInt(delta);
  return count > 0n ? count.toString() : null;
}
