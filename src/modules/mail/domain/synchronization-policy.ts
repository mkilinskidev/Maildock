/** Architectural classes, not pg-boss priorities. Message age is irrelevant. */
export type SynchronizationPriority = "P0" | "P1" | "P2";

export function synchronizationPriority(scope: {
  currentChange: boolean;
  affectsInbox: boolean;
}): SynchronizationPriority {
  return scope.currentChange ? (scope.affectsInbox ? "P0" : "P1") : "P2";
}

/** A DB observation of materialized messages; never a publication generation. */
export type MailboxCounterObservation = Readonly<{
  local: Readonly<{
    provenance: "local_materialized";
    messageCount: string;
    unreadCount: string;
    sampledAt: string;
  }>;
  remote: Readonly<{
    provenance: "remote_observation";
    messageCount: string | null;
    unreadCount: string | null;
    observedAt: null;
  }>;
  coverage: "remote_sample_exceeds_local" | "unknown";
  lastSuccessfulDeltaSyncAt: string | null;
}>;

export function mailboxCounterObservation(input: {
  localMessageCount: string;
  localUnreadCount: string;
  remoteMessageCount: string | null;
  remoteUnreadCount: string | null;
  sampledAt: string;
  lastSuccessfulDeltaSyncAt: string | null;
}): MailboxCounterObservation {
  return {
    local: {
      provenance: "local_materialized",
      messageCount: input.localMessageCount,
      unreadCount: input.localUnreadCount,
      sampledAt: input.sampledAt,
    },
    remote: {
      provenance: "remote_observation",
      messageCount: input.remoteMessageCount,
      unreadCount: input.remoteUnreadCount,
      // Existing generic row/phase timestamps do not date every counter writer.
      observedAt: null,
    },
    // A larger remote sample records a count gap, not proof of import state. Equality proves neither
    // identity coverage nor freshness, including during history repair.
    coverage:
      (input.remoteMessageCount !== null &&
        BigInt(input.remoteMessageCount) > BigInt(input.localMessageCount)) ||
      (input.remoteUnreadCount !== null &&
        BigInt(input.remoteUnreadCount) > BigInt(input.localUnreadCount))
        ? "remote_sample_exceeds_local"
        : "unknown",
    lastSuccessfulDeltaSyncAt: input.lastSuccessfulDeltaSyncAt,
  };
}
