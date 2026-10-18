import type { MailboxView } from "../../modules/mail/application/mailbox-service";

export function initialInboxPollDelay(
  folder: MailboxView | undefined,
  viewingInbox: boolean,
  now = Date.now(),
): number {
  const sync = folder?.recentSync;
  return viewingInbox &&
    folder?.remotePath.toUpperCase() === "INBOX" &&
    folder.selectable &&
    folder.lifecycleStatus === "active" &&
    sync &&
    !sync.lastSuccessfulAt &&
    !sync.completedAt &&
    ["not_started", "pending", "running"].includes(sync.status) &&
    now < Date.parse(folder.firstDiscoveredAt) + 60_000
    ? 2_000
    : 20_000;
}
