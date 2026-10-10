import type { RemoteFlagDelta, RemoteMessageMetadata } from "./mail-provider";

/** A fixed UID horizon and an original MODSEQ, never a moving STATUS checkpoint. */
export type ImapSyncProgress = {
  revision: string;
  uidValidity: string;
  frontier: string;
  cursor: string;
  phase: "messages" | "reconcile";
  localCursor: string;
  highestModseq: string | null;
  cutoff: string | null;
  messageCount: number;
};

export type ImapSliceLimits = {
  uidSpan: number;
  batchSize: number;
  timeoutMs: number;
};
export type ImapSliceObservation = {
  uidNext: string;
  messageCount: string;
  unseenCount: string;
};
export type ImapSliceSink = {
  selected(
    epoch: string,
    frontier: string,
    modseq: string | null,
  ): Promise<ImapSyncProgress>;
  messages(batch: readonly RemoteMessageMetadata[]): Promise<void>;
  localUids(after: string, through: string, limit: number): Promise<string[]>;
  flags(batch: readonly RemoteFlagDelta[]): Promise<void>;
  removed(uids: readonly string[]): Promise<void>;
  checkpoint(progress: ImapSyncProgress): Promise<void>;
  completed(
    progress: ImapSyncProgress,
    observation: ImapSliceObservation,
  ): Promise<void>;
};
