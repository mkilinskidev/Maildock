import type { PgBoss } from "pg-boss";
import { z } from "zod";
import { sql } from "drizzle-orm";
import type { Database } from "../../../shared/infrastructure/database/database";
import { safeJobHandler } from "../../../shared/infrastructure/logging/diagnostics";
import {
  ReceivingDemand,
  type ReceivingWakeTarget,
} from "../application/receiving-demand";
import {
  MAILBOX_RECENT_SYNC_QUEUE,
  ensureRecentSyncQueue,
  recentSyncPayloadSchema,
} from "./recent-sync-jobs";
import { MAILBOX_DELTA_SYNC_QUEUE, ensureDeltaQueue } from "./delta-sync-jobs";
import {
  MAILBOX_BACKFILL_SYNC_QUEUE,
  ensureBackfillQueue,
} from "./backfill-sync-jobs";
import {
  MAILBOX_DISCOVERY_QUEUE,
  ensureMailboxDiscoveryQueue,
} from "./mailbox-discovery-jobs";
import { MESSAGE_CONTENT_QUEUE, ensureContentQueue } from "./content-jobs";
import {
  MESSAGE_COMMAND_QUEUE,
  ensureMessageCommandQueue,
} from "./message-command-jobs";
import { ATTACHMENT_QUEUE, ensureAttachmentQueue } from "./attachment-jobs";
import { SENT_COPY_QUEUE, ensureSentCopyQueue } from "./sent-copy-jobs";

/** Old queue payloads are hints. No callback here has a provider/client port.
 * Durable source-bound intents survive ACK, disabled accounts and lost wakes. */
export async function registerReceivingConversions(
  boss: PgBoss,
  db: Database,
  target: ReceivingWakeTarget,
) {
  const demand = new ReceivingDemand(db, (id) => target.notify(id));
  for (const ensure of [
    ensureRecentSyncQueue,
    ensureDeltaQueue,
    ensureBackfillQueue,
    ensureMailboxDiscoveryQueue,
    ensureContentQueue,
    ensureMessageCommandQueue,
    ensureAttachmentQueue,
    ensureSentCopyQueue,
  ])
    await ensure(boss);
  const work = (name: string, convert: (data: unknown) => Promise<void>) =>
    boss.work(
      name,
      { localConcurrency: 1 },
      safeJobHandler("receiving-conversion", async (batch) => {
        for (const job of batch) await convert(job.data);
      }),
    );
  const folder = async (data: unknown, delta = false) => {
    const p = (
      delta
        ? recentSyncPayloadSchema.extend({
            reason: z.enum(["idle", "poll", "manual", "post-discovery"]),
          })
        : recentSyncPayloadSchema
    ).parse(data);
    // record() validates account/folder ownership. Missing/disabled/obsolete
    // identities cannot execute; enabled live identities commit due before ACK.
    const result = await demand.record(p.accountId, p.mailboxId);
    if (result.accepted) await demand.deliver(p.accountId);
    else {
      const [identity] = await db.execute(sql`select
        exists(select from mail_accounts where id=${p.accountId}::uuid) as account_exists,
        exists(select from mailboxes where id=${p.mailboxId}::uuid) as mailbox_exists,
        exists(select from mailboxes where id=${p.mailboxId}::uuid and account_id=${p.accountId}::uuid) as matches,
        exists(select from mail_accounts where id=${p.accountId}::uuid and removal_requested_at is not null) as terminal,
        exists(select from mailboxes where id=${p.mailboxId}::uuid and account_id=${p.accountId}::uuid and lifecycle_status='missing') as obsolete`);
      if (
        identity.account_exists &&
        identity.mailbox_exists &&
        !identity.matches
      )
        throw new Error("Receiving conversion account/mailbox mismatch");
      if (
        identity.account_exists &&
        identity.mailbox_exists &&
        !identity.terminal &&
        !identity.obsolete
      )
        throw new Error(
          "Receiving conversion cannot accept this live identity",
        );
    }
  };
  await work(MAILBOX_RECENT_SYNC_QUEUE, (data) => folder(data));
  await work(MAILBOX_DELTA_SYNC_QUEUE, (data) => folder(data, true));
  await work(MAILBOX_BACKFILL_SYNC_QUEUE, (data) => folder(data));
  await work(MAILBOX_DISCOVERY_QUEUE, async (data) => {
    const { accountId } = z
      .object({ version: z.literal(1), accountId: z.uuid() })
      .strict()
      .parse(data);
    await db.execute(sql`update mail_accounts set mailbox_discovery_status='pending',
      mailbox_discovery_error=null,mailbox_discovery_requested_at=clock_timestamp()
      where id=${accountId}::uuid and enabled and removal_requested_at is null`);
    await demand.request(accountId);
  });
  await work(MESSAGE_CONTENT_QUEUE, async (data) => {
    const p = recentSyncPayloadSchema
      .extend({ messageId: z.uuid() })
      .parse(data);
    const rows =
      await db.execute(sql`select from message_contents where message_id=${p.messageId}::uuid
      and source_mailbox_id=${p.mailboxId}::uuid and exists(select from messages where id=${p.messageId}::uuid and account_id=${p.accountId}::uuid)`);
    if (rows.length) await demand.deliver(p.accountId);
  });
  await work(MESSAGE_COMMAND_QUEUE, async (data) => {
    const { commandId } = z
      .object({ commandId: z.uuid() })
      .strict()
      .parse(data);
    const [row] = await db.execute(
      sql`select account_id from message_commands where id=${commandId}::uuid`,
    );
    if (row) await demand.deliver(String(row.account_id));
  });
  await work(ATTACHMENT_QUEUE, async (data) => {
    const { attachmentId } = z
      .object({ attachmentId: z.uuid() })
      .strict()
      .parse(data);
    const [row] = await db.execute(
      sql`select m.account_id from message_attachments a join messages m on m.id=a.message_id where a.id=${attachmentId}::uuid`,
    );
    if (row) await demand.deliver(String(row.account_id));
  });
  await work(SENT_COPY_QUEUE, async (data) => {
    const { outgoingMessageId } = z
      .object({ outgoingMessageId: z.uuid() })
      .strict()
      .parse(data);
    const [row] = await db.execute(
      sql`select account_id from outgoing_messages where id=${outgoingMessageId}::uuid`,
    );
    if (row) await demand.deliver(String(row.account_id));
  });
}
