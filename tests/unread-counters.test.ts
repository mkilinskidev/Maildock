import { describe, expect, it } from "vitest";
import type { MailboxView } from "@/modules/mail/application/mailbox-service";
import {
  applyMailboxCounterSnapshot,
  counterIncludesAction,
  mergeMailboxCounters,
  projectedUnreadCount,
  type CountAdjustment,
  type UnreadCounterState,
} from "@/modules/mail/domain/unread-counters";

const before = "2026-10-10T10:00:00.000Z";
const completedAt = "2026-10-10T10:00:01.000Z";
const after = "2026-10-10T10:00:02.000Z";
function mailbox(count: string | null, observedAt = before) {
  return {
    id: "inbox",
    unseenCount: count,
    unseenCountObservedAt: observedAt,
    deltaSync: { lastSuccessfulAt: after },
  } as MailboxView;
}
function adjustment(
  delta: number,
  done: string | null = null,
): CountAdjustment {
  return { key: "command", mailboxId: "inbox", delta, completedAt: done };
}
describe("authoritative remote counters with optimistic actions", () => {
  it.each(["snapshot-first", "completion-first"])(
    "reconciles a counter and command completion atomically: %s",
    (order) => {
      const pending = adjustment(1);
      let state: UnreadCounterState = {
        boxes: { account: [mailbox("2")] },
        adjustments: [pending],
      };
      const remote = mailbox("3", after);
      if (order === "snapshot-first")
        state = applyMailboxCounterSnapshot(state, "account", [remote]);
      state = { ...state, adjustments: [adjustment(1, completedAt)] };
      state = applyMailboxCounterSnapshot(state, "account", [remote]);
      expect(
        projectedUnreadCount(state.boxes.account[0], state.adjustments),
      ).toBe("3");
      expect(state.adjustments).toEqual([]);
      state = applyMailboxCounterSnapshot(state, "account", [mailbox("2")]);
      expect(
        projectedUnreadCount(state.boxes.account[0], state.adjustments),
      ).toBe("3");
    },
  );
  it("applies an external INBOX change from two to zero", () => {
    const [updated] = mergeMailboxCounters(
      [mailbox("2")],
      [mailbox("0", after)],
      [],
    );
    expect(projectedUnreadCount(updated, [])).toBeNull();
  });
  it.each([-1, 1])("does not count a pending local delta %s twice", (delta) => {
    const previous = mailbox("2");
    const remote = mailbox(String(2 + delta), after);
    const pending = adjustment(delta);
    const [held] = mergeMailboxCounters([previous], [remote], [pending]);
    expect(projectedUnreadCount(held, [pending])).toBe(String(2 + delta));
    const done = adjustment(delta, completedAt);
    const [confirmed] = mergeMailboxCounters([held], [remote], [done]);
    expect(projectedUnreadCount(confirmed, [done])).toBe(String(2 + delta));
  });
  it("does not acknowledge a label counter merely because history completed", () => {
    const stale = mailbox("2");
    const done = adjustment(-1, completedAt);
    expect(counterIncludesAction(stale, done)).toBe(false);
    expect(projectedUnreadCount(stale, [done])).toBe("1");
  });
  it("ignores delayed or unversioned counter responses after a newer snapshot", () => {
    const current = mailbox("0", after);
    const unversioned = { ...mailbox("2"), unseenCountObservedAt: null };
    for (const response of [mailbox("2"), unversioned]) {
      const [merged] = mergeMailboxCounters([current], [response], []);
      expect(merged.unseenCount).toBe("0");
      expect(merged.unseenCountObservedAt).toBe(after);
    }
  });
  it("keeps a subsequent intent while acknowledging an earlier one", () => {
    const actions = [
      adjustment(-1, completedAt),
      { ...adjustment(1), key: "later" },
    ];
    expect(projectedUnreadCount(mailbox("1", after), actions)).toBe("2");
  });
  it("does not produce negative counts or guess unknown remote counts", () => {
    expect(projectedUnreadCount(mailbox("0"), [adjustment(-1)])).toBeNull();
    expect(projectedUnreadCount(mailbox(null), [adjustment(1)])).toBeNull();
  });
  it("does not replace identical observations or rerender their consumers", () => {
    const current = [mailbox("2")];
    expect(mergeMailboxCounters(current, structuredClone(current), [])).toBe(
      current,
    );
  });
});
