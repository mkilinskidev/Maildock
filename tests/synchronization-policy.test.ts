import { describe, expect, it } from "vitest";
import {
  mailboxCounterObservation,
  synchronizationPriority,
} from "@/modules/mail/domain/synchronization-policy";

const sample = {
  localMessageCount: "75",
  localUnreadCount: "3",
  remoteMessageCount: "150",
  remoteUnreadCount: "20",
  sampledAt: "2026-10-10T10:00:00.000Z",
  lastSuccessfulDeltaSyncAt: null,
};

describe("provider-neutral synchronization contract", () => {
  it("classifies current affected scope including old-message INBOX removals", () => {
    expect(
      synchronizationPriority({ currentChange: true, affectsInbox: true }),
    ).toBe("P0");
    expect(
      synchronizationPriority({ currentChange: true, affectsInbox: false }),
    ).toBe("P1");
    expect(
      synchronizationPriority({ currentChange: false, affectsInbox: true }),
    ).toBe("P2");
  });
  it("keeps materialized unread separate from remote observations during import", () => {
    expect(mailboxCounterObservation(sample)).toEqual({
      local: {
        provenance: "local_materialized",
        messageCount: "75",
        unreadCount: "3",
        sampledAt: sample.sampledAt,
      },
      remote: {
        provenance: "remote_observation",
        messageCount: "150",
        unreadCount: "20",
        observedAt: null,
      },
      coverage: "remote_sample_exceeds_local",
      lastSuccessfulDeltaSyncAt: null,
    });
  });
  it.each([null, "75", "50"])(
    "does not infer complete coverage from remote total %s",
    (remoteMessageCount) => {
      const observation = mailboxCounterObservation({
        ...sample,
        remoteMessageCount,
        remoteUnreadCount: "3",
        lastSuccessfulDeltaSyncAt: sample.sampledAt,
      });
      expect(observation.coverage).toBe("unknown");
      expect(observation.remote.observedAt).toBeNull();
      expect(observation.lastSuccessfulDeltaSyncAt).toBe(sample.sampledAt);
    },
  );
  it("counts using decimal precision beyond JavaScript safe integers", () => {
    const observation = mailboxCounterObservation({
      ...sample,
      localMessageCount: "9007199254740992",
      remoteMessageCount: "9007199254740993",
    });
    expect(observation.coverage).toBe("remote_sample_exceeds_local");
  });
});
