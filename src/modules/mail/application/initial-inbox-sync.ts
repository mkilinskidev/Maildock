import { syncPriority } from "./inbox-first-policy";

// Stable across retries and worker restarts; never based on requested/startedAt.
export const INITIAL_INBOX_PROTECTION_MS = 60_000;

export function recentSyncPriority(remotePath: string): number {
  return syncPriority("fresh", remotePath);
}

export function protectsInitialInbox(
  inbox:
    | {
        selectable: boolean;
        lifecycleStatus: string;
        firstDiscoveredAt: Date;
        recentSyncStatus: string;
        recentSyncCompletedAt: Date | null;
        lastSuccessfulRecentSyncAt: Date | null;
      }
    | undefined,
  now = Date.now(),
): boolean {
  return Boolean(
    inbox?.selectable &&
    inbox.lifecycleStatus === "active" &&
    !inbox.lastSuccessfulRecentSyncAt &&
    !inbox.recentSyncCompletedAt &&
    inbox.recentSyncStatus !== "failed" &&
    inbox.recentSyncStatus !== "success" &&
    now < inbox.firstDiscoveredAt.getTime() + INITIAL_INBOX_PROTECTION_MS,
  );
}
