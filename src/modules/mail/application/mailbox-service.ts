import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { RemoteMailbox } from "../../accounts/domain/mail-provider";
import { MailboxRoleService } from "./mailbox-role-service";
import type { Database } from "../../../shared/infrastructure/database/database";
import {
  messagePlacementProjection as mailboxMessages,
  mailboxes,
  receivingMailboxes,
} from "../../../shared/infrastructure/database/schema";

type MailboxRow = typeof mailboxes.$inferSelect;

export type MailboxView = Readonly<{
  receiving?: Readonly<{
    mode: "inbox" | "mailbox" | "deferred";
    historyComplete: boolean;
    freshThrough: string | null;
  }>;
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
  synchronizedMessageCount: string;
  countsIncludePendingActions?: boolean;
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
  countsIncludePendingActions = false,
  receiving?: MailboxView["receiving"],
): MailboxView {
  return {
    ...(receiving ? { receiving } : {}),
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
    synchronizedMessageCount,
    ...(countsIncludePendingActions
      ? { countsIncludePendingActions: true }
      : {}),
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
    const [rows, counts] = await Promise.all([
      this.database
        .select()
        .from(mailboxes)
        .where(
          includeMissing
            ? eq(mailboxes.accountId, accountId)
            : and(
                eq(mailboxes.accountId, accountId),
                eq(mailboxes.lifecycleStatus, "active"),
              ),
        )
        .orderBy(asc(mailboxes.remotePath)),
      this.database
        .select({
          mailboxId: mailboxes.id,
          count: sql<string>`count(${mailboxMessages.id})::text`,
          unread: sql<string>`count(${mailboxMessages.id}) FILTER (WHERE NOT ${mailboxMessages.flags} @> ARRAY['\\Seen']::text[])::text`,
          enrolled: sql<boolean>`maildock_receiving_account_enrolled(${mailboxes.accountId})`,
          receiving: sql<
            MailboxView["receiving"]
          >`case when maildock_receiving_account_enrolled(${mailboxes.accountId}) and ${mailboxes.selectable} and ${mailboxes.lifecycleStatus}='active' then
            jsonb_build_object('mode',case when ${mailboxes.remotePath}='INBOX' then 'inbox' else 'mailbox' end,
              'historyComplete',coalesce(${receivingMailboxes.historyBefore}=1,false),
              'freshThrough',${receivingMailboxes.freshThrough}::text) end`,
        })
        .from(mailboxes)
        .leftJoin(
          receivingMailboxes,
          and(
            eq(receivingMailboxes.mailboxId, mailboxes.id),
            sql`${receivingMailboxes.configurationBinding}=(select configuration_version from mail_accounts where id=${mailboxes.accountId})`,
          ),
        )
        .leftJoin(
          mailboxMessages,
          and(
            eq(mailboxes.id, mailboxMessages.mailboxId),
            eq(mailboxMessages.actionHidden, false),
          ),
        )
        .where(and(eq(mailboxes.accountId, accountId)))
        .groupBy(mailboxes.id, receivingMailboxes.mailboxId),
    ]);
    const countsByMailbox = new Map(counts.map((row) => [row.mailboxId, row]));
    return rows.map((row) => {
      const count = countsByMailbox.get(row.id);
      return view(
        count?.enrolled
          ? {
              ...row,
              reportedMessageCount: BigInt(count.count),
              reportedUnseenCount: BigInt(count.unread),
            }
          : row,
        count?.count ?? "0",
        count?.enrolled,
        count?.receiving,
      );
    });
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
  ): Promise<void> {
    await this.database.transaction(async (tx) => {
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
