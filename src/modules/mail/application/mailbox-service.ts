import { assertImapPublication } from "../infrastructure/receive-publication-fence";
import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { RemoteMailbox } from "../../accounts/domain/mail-provider";
import {
  mailboxCounterObservation,
  type MailboxCounterObservation,
} from "../domain/synchronization-policy";
import { MailboxRoleService } from "./mailbox-role-service";
import type { Database } from "../../../shared/infrastructure/database/database";
import {
  mailboxMessages,
  mailboxes,
} from "../../../shared/infrastructure/database/schema";

type MailboxRow = typeof mailboxes.$inferSelect;

export type MailboxView = Readonly<{
  id: string;
  remotePath: string;
  name: string;
  delimiter: string | null;
  attributes: readonly string[];
  specialUse: readonly string[];
  selectable: boolean;
  subscribed: boolean | null;
  providerMailboxId: string | null;
  uidValidity: string | null;
  uidNext: string | null;
  highestModseq: string | null;
  messageCount: string | null;
  unseenCount: string | null;
  unseenCountObservedAt: string | null;
  synchronizedMessageCount: string;
  /** Additive Phase 1 observation; legacy badge fields await coherent refresh. */
  counterObservation?: MailboxCounterObservation;
  lifecycleStatus: "active" | "missing";
  firstDiscoveredAt: string;
  lastDiscoveredAt: string;
  missingSince: string | null;
  uidValidityChangedAt: string | null;
  uidValidityChangeCount: number;
  recentSync: Readonly<{
    status: "not_started" | "pending" | "running" | "success" | "failed";
    requestedAt: string | null;
    startedAt: string | null;
    completedAt: string | null;
    error: string | null;
    cutoff: string | null;
    messageCount: number;
    uidValidity: string | null;
    lastSuccessfulAt: string | null;
  }>;
  deltaSync: Readonly<{
    status: "not_started" | "pending" | "running" | "success" | "failed";
    error: string | null;
    uidValidity: string | null;
    lastSeenUid: string | null;
    highestModseq: string | null;
    startedAt: string | null;
    completedAt: string | null;
    lastSuccessfulAt: string | null;
  }>;
  backfill: Readonly<{
    status: "not_started" | "pending" | "running" | "complete" | "failed";
    uidValidity: string | null;
    frontierUid: string | null;
    error: string | null;
    completedAt: string | null;
  }>;
}>;

function view(
  row: MailboxRow,
  synchronizedMessageCount: string,
  counterObservation: MailboxCounterObservation,
): MailboxView {
  return {
    id: row.id,
    remotePath: row.remotePath,
    name: row.name,
    delimiter: row.delimiter,
    attributes: row.attributes,
    specialUse: row.specialUse,
    selectable: row.selectable,
    subscribed: row.subscribed,
    providerMailboxId: row.providerMailboxId,
    uidValidity: row.uidValidity?.toString() ?? null,
    uidNext: row.uidNext?.toString() ?? null,
    highestModseq: row.highestModseq?.toString() ?? null,
    messageCount: row.reportedMessageCount?.toString() ?? null,
    unseenCount: row.reportedUnseenCount?.toString() ?? null,
    // Native label projection preserves updatedAt until labels.get publishes
    // counters; a history checkpoint alone does not confirm this observation.
    unseenCountObservedAt:
      row.receiveTransport === "gmail"
        ? row.reportedUnseenCount !== null
          ? row.updatedAt.toISOString()
          : null
        : (row.lastSuccessfulDeltaSyncAt?.toISOString() ?? null),
    synchronizedMessageCount,
    counterObservation,
    lifecycleStatus: row.lifecycleStatus as "active" | "missing",
    firstDiscoveredAt: row.firstDiscoveredAt.toISOString(),
    lastDiscoveredAt: row.lastDiscoveredAt.toISOString(),
    missingSince: row.missingSince?.toISOString() ?? null,
    uidValidityChangedAt: row.uidValidityChangedAt?.toISOString() ?? null,
    uidValidityChangeCount: row.uidValidityChangeCount,
    recentSync: {
      status: row.recentSyncStatus as MailboxView["recentSync"]["status"],
      requestedAt: row.recentSyncRequestedAt?.toISOString() ?? null,
      startedAt: row.recentSyncStartedAt?.toISOString() ?? null,
      completedAt: row.recentSyncCompletedAt?.toISOString() ?? null,
      error: row.recentSyncError,
      cutoff: row.recentSyncCutoff?.toISOString() ?? null,
      messageCount: row.recentSyncMessageCount,
      uidValidity: row.recentSyncUidValidity?.toString() ?? null,
      lastSuccessfulAt: row.lastSuccessfulRecentSyncAt?.toISOString() ?? null,
    },
    deltaSync: {
      status: row.deltaSyncStatus as MailboxView["deltaSync"]["status"],
      error: row.deltaSyncError,
      uidValidity: row.deltaUidValidity?.toString() ?? null,
      lastSeenUid: row.deltaLastSeenUid?.toString() ?? null,
      highestModseq: row.deltaHighestModseq?.toString() ?? null,
      startedAt: row.deltaSyncStartedAt?.toISOString() ?? null,
      completedAt: row.deltaSyncCompletedAt?.toISOString() ?? null,
      lastSuccessfulAt: row.lastSuccessfulDeltaSyncAt?.toISOString() ?? null,
    },
    backfill: {
      status: row.backfillStatus as MailboxView["backfill"]["status"],
      uidValidity: row.backfillUidValidity?.toString() ?? null,
      frontierUid: row.backfillFrontierUid?.toString() ?? null,
      error: row.backfillError,
      completedAt: row.backfillCompletedAt?.toISOString() ?? null,
    },
  };
}

function integer(value: string | undefined): bigint | null {
  return value === undefined ? null : BigInt(value);
}

function observation(remote: RemoteMailbox) {
  return {
    remotePath: remote.remotePath,
    name: remote.name,
    delimiter: remote.delimiter,
    attributes: [...remote.attributes],
    specialUse: [...remote.specialUse],
    selectable: remote.selectable,
    subscribed: remote.subscribed ?? null,
    uidValidity: integer(remote.uidValidity),
    uidNext: integer(remote.uidNext),
    highestModseq: integer(remote.highestModseq),
    reportedMessageCount: integer(remote.messageCount),
    reportedUnseenCount: integer(remote.unseenCount),
  };
}

export class MailboxService {
  constructor(private readonly database: Database) {}

  async listForAccount(
    accountId: string,
    includeMissing = false,
  ): Promise<MailboxView[]> {
    // One SQL statement gives mailbox observations and local aggregates the
    // same DB snapshot. It does not coordinate the separate message-list API.
    const counts = this.database
      .select({
        mailboxId: mailboxMessages.mailboxId,
        count: sql<string>`count(*)::text`.as("placement_count"),
        visibleCount:
          sql<string>`count(distinct ${mailboxMessages.messageId}) filter (where not ${mailboxMessages.actionHidden})::text`.as(
            "visible_count",
          ),
        unreadCount:
          sql<string>`count(distinct ${mailboxMessages.messageId}) filter (where not ${mailboxMessages.actionHidden} and not (${"\\Seen"} = any(${mailboxMessages.flags})))::text`.as(
            "unread_count",
          ),
      })
      .from(mailboxMessages)
      .where(eq(mailboxMessages.accountId, accountId))
      .groupBy(mailboxMessages.mailboxId)
      .as("local_counts");
    const rows = await this.database
      .select({
        mailbox: mailboxes,
        count: counts.count,
        visibleCount: counts.visibleCount,
        unreadCount: counts.unreadCount,
        sampledAt: sql<string>`statement_timestamp()::text`,
      })
      .from(mailboxes)
      .leftJoin(counts, eq(mailboxes.id, counts.mailboxId))
      .where(
        includeMissing
          ? eq(mailboxes.accountId, accountId)
          : and(
              eq(mailboxes.accountId, accountId),
              eq(mailboxes.lifecycleStatus, "active"),
            ),
      )
      .orderBy(asc(mailboxes.remotePath));
    return rows.map((row) =>
      view(
        row.mailbox,
        row.count ?? "0",
        mailboxCounterObservation({
          localMessageCount: row.visibleCount ?? "0",
          localUnreadCount: row.unreadCount ?? "0",
          remoteMessageCount:
            row.mailbox.reportedMessageCount?.toString() ?? null,
          remoteUnreadCount:
            row.mailbox.reportedUnseenCount?.toString() ?? null,
          sampledAt: new Date(row.sampledAt).toISOString(),
          lastSuccessfulDeltaSyncAt:
            row.mailbox.receiveTransport === "imap"
              ? (row.mailbox.lastSuccessfulDeltaSyncAt?.toISOString() ?? null)
              : null,
        }),
      ),
    );
  }

  async countActive(accountId: string): Promise<number> {
    const [result] = await this.database
      .select({ count: sql<number>`count(*)::integer` })
      .from(mailboxes)
      .where(
        and(
          eq(mailboxes.accountId, accountId),
          eq(mailboxes.lifecycleStatus, "active"),
        ),
      );
    return result?.count ?? 0;
  }

  async reconcile(
    accountId: string,
    remoteMailboxes: readonly RemoteMailbox[],
    observedAt = new Date(),
    revision?: string,
  ): Promise<void> {
    await this.database.transaction(async (tx) => {
      // Offline metadata reconciliation remains available; remote discovery always supplies its revision.
      if (revision !== undefined)
        await assertImapPublication(tx, accountId, revision);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`mailbox-discovery:${accountId}`}, 0))`,
      );
      const local = await tx
        .select()
        .from(mailboxes)
        .where(eq(mailboxes.accountId, accountId));
      const used = new Set<string>();

      for (const remote of remoteMailboxes) {
        let match = remote.providerMailboxId
          ? local.find(
              (candidate) =>
                candidate.providerMailboxId === remote.providerMailboxId &&
                !used.has(candidate.id),
            )
          : undefined;

        if (!match) {
          const pathMatches = local.filter(
            (candidate) =>
              candidate.remotePath === remote.remotePath &&
              candidate.lifecycleStatus === "active" &&
              !used.has(candidate.id),
          );
          match = remote.providerMailboxId
            ? pathMatches.find((candidate) => !candidate.providerMailboxId)
            : pathMatches[0];
        }

        if (!match) {
          await tx.insert(mailboxes).values({
            id: randomUUID(),
            accountId,
            ...observation(remote),
            providerMailboxId: remote.providerMailboxId ?? null,
            lifecycleStatus: "active",
            firstDiscoveredAt: observedAt,
            lastDiscoveredAt: observedAt,
            createdAt: observedAt,
            updatedAt: observedAt,
          });
          continue;
        }

        used.add(match.id);
        const nextUidValidity = integer(remote.uidValidity);
        const uidValidityChanged =
          match.uidValidity !== null &&
          nextUidValidity !== null &&
          match.uidValidity !== nextUidValidity;
        await tx
          .update(mailboxes)
          .set({
            ...observation(remote),
            providerMailboxId:
              remote.providerMailboxId ?? match.providerMailboxId,
            lifecycleStatus: "active",
            missingSince: null,
            lastDiscoveredAt: observedAt,
            ...(uidValidityChanged
              ? {
                  uidValidityChangedAt: observedAt,
                  uidValidityChangeCount: match.uidValidityChangeCount + 1,
                }
              : {}),
            updatedAt: observedAt,
          })
          .where(eq(mailboxes.id, match.id));
      }

      const newlyMissing = local.filter(
        (candidate) =>
          candidate.lifecycleStatus === "active" && !used.has(candidate.id),
      );
      if (newlyMissing.length > 0) {
        await tx
          .update(mailboxes)
          .set({
            lifecycleStatus: "missing",
            missingSince: observedAt,
            updatedAt: observedAt,
          })
          .where(
            inArray(
              mailboxes.id,
              newlyMissing.map((candidate) => candidate.id),
            ),
          );
      }
    });
    await new MailboxRoleService(this.database).autodetect(accountId);
  }
}
