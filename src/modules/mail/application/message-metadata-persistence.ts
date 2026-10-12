import { randomUUID } from "node:crypto";
import { and, eq, lt, or, sql } from "drizzle-orm";
import type { Database } from "../../../shared/infrastructure/database/database";
import type { RemoteMessageMetadata } from "../../accounts/domain/mail-provider";
import {
  mailboxMessages,
  messages,
  messageCommands,
  outgoingMessages,
  instanceState,
  notificationEvents,
} from "../../../shared/infrastructure/database/schema";
import { persistAttachmentMetadata } from "./attachment-metadata";

function messageValues(
  accountId: string,
  remote: RemoteMessageMetadata,
  now: Date,
) {
  const envelope = remote.envelope;
  return {
    accountId,
    providerMessageId: remote.providerEmailId ?? null,
    rfcMessageId: envelope.messageId ?? null,
    subject: envelope.subject ?? null,
    sentAt: envelope.date ? new Date(envelope.date) : null,
    internalDate: new Date(remote.internalDate),
    size: BigInt(remote.size),
    from: envelope.from,
    sender: envelope.sender,
    replyTo: envelope.replyTo,
    to: envelope.to,
    cc: envelope.cc,
    bcc: envelope.bcc,
    inReplyTo: envelope.inReplyTo ?? null,
    references: envelope.references ?? null,
    mimeStructure: remote.mimeStructure ?? null,
    hasAttachments: remote.hasAttachments,
    updatedAt: now,
  };
}

export async function persistMessageMetadata(
  db: Pick<Database, "select" | "insert" | "update" | "delete">,
  accountId: string,
  mailboxId: string,
  uidValidity: bigint,
  batch: readonly RemoteMessageMetadata[],
  publishArrival: boolean,
  pruneEvents = true,
  synchronizedAt = new Date(),
  // Receiving-only caller preloads an exact distinct bounded set under its
  // mailbox lock. Legacy callers retain the per-record lookup behavior.
  receivingPlacements?: ReadonlyMap<
    bigint,
    typeof mailboxMessages.$inferSelect
  >,
) {
  for (const remote of batch) {
    const uid = BigInt(remote.uid);
    const placement = receivingPlacements
      ? receivingPlacements.get(uid)
      : (
          await db
            .select()
            .from(mailboxMessages)
            .where(
              and(
                eq(mailboxMessages.mailboxId, mailboxId),
                eq(mailboxMessages.uidValidity, uidValidity),
                eq(mailboxMessages.uid, uid),
              ),
            )
            .limit(1)
        )[0];
    if (placement) {
      const staleFlags =
        remote.modseq !== undefined &&
        placement.modseq !== null &&
        BigInt(remote.modseq) < placement.modseq;
      await db
        .update(mailboxMessages)
        .set({
          ...(staleFlags
            ? {}
            : {
                flags: [...remote.flags],
                modseq: remote.modseq ? BigInt(remote.modseq) : null,
              }),
          lastSynchronizedAt: synchronizedAt,
          updatedAt: synchronizedAt,
        })
        .where(eq(mailboxMessages.id, placement.id));
      await db
        .update(messages)
        .set(messageValues(accountId, remote, synchronizedAt))
        .where(eq(messages.id, placement.messageId));
      await persistAttachmentMetadata(
        db,
        placement.messageId,
        mailboxId,
        uidValidity,
        uid,
        remote.mimeStructure,
      );
      continue;
    }
    const messageId = randomUUID();
    await db.insert(messages).values({
      id: messageId,
      ...messageValues(accountId, remote, synchronizedAt),
      createdAt: synchronizedAt,
    });
    await persistAttachmentMetadata(
      db,
      messageId,
      mailboxId,
      uidValidity,
      uid,
      remote.mimeStructure,
    );
    await db.insert(mailboxMessages).values({
      id: randomUUID(),
      mailboxId,
      messageId,
      uidValidity,
      uid,
      modseq: remote.modseq ? BigInt(remote.modseq) : null,
      flags: [...remote.flags],
      firstSynchronizedAt: synchronizedAt,
      lastSynchronizedAt: synchronizedAt,
      createdAt: synchronizedAt,
      updatedAt: synchronizedAt,
    });
    if (publishArrival) {
      // Known command destinations use UID/epoch. Servers without COPYUID
      // (including uncertain outcomes) use the source's metadata identity.
      const [command] = await db
        .select({ id: messageCommands.id })
        .from(messageCommands)
        .innerJoin(messages, eq(messages.id, messageCommands.messageId))
        .where(
          and(
            eq(messageCommands.accountId, accountId),
            eq(messages.accountId, accountId),
            eq(messageCommands.destinationMailboxId, mailboxId),
            sql`${messageCommands.startedAt} is not null`,
            or(
              and(
                eq(messageCommands.destinationUidValidity, uidValidity),
                eq(messageCommands.destinationUid, uid),
              ),
              and(
                sql`${messageCommands.destinationUid} is null`,
                or(
                  remote.providerEmailId
                    ? eq(messages.providerMessageId, remote.providerEmailId)
                    : sql`false`,
                  remote.envelope.messageId
                    ? eq(messages.rfcMessageId, remote.envelope.messageId)
                    : sql`false`,
                  and(
                    sql`${messages.providerMessageId} is null`,
                    sql`${messages.rfcMessageId} is null`,
                    eq(messages.internalDate, new Date(remote.internalDate)),
                    eq(messages.size, BigInt(remote.size)),
                    sql`${messages.subject} is not distinct from ${remote.envelope.subject ?? null}`,
                    sql`${messages.from} = ${JSON.stringify(remote.envelope.from)}::jsonb`,
                  ),
                ),
              ),
            ),
          ),
        )
        .limit(1);
      const [outgoing] = await db
        .select({ id: outgoingMessages.id })
        .from(outgoingMessages)
        .where(
          and(
            eq(outgoingMessages.accountId, accountId),
            or(
              remote.envelope.messageId
                ? eq(outgoingMessages.messageId, remote.envelope.messageId)
                : sql`false`,
              and(
                eq(outgoingMessages.sentCopyMailboxId, mailboxId),
                eq(outgoingMessages.sentCopyUidValidity, uidValidity),
                eq(outgoingMessages.sentCopyUid, uid),
              ),
            ),
          ),
        )
        .limit(1);
      if (!command && !outgoing) {
        await db.insert(instanceState).values({ id: 1 }).onConflictDoNothing();
        const [state] = await db
          .update(instanceState)
          .set({
            notificationSequence: sql`${instanceState.notificationSequence} + 1`,
          })
          .where(eq(instanceState.id, 1))
          .returning({ sequence: instanceState.notificationSequence });
        const sender = remote.envelope.from[0] ?? remote.envelope.sender[0];
        await db
          .insert(notificationEvents)
          .values({
            sequence: state.sequence,
            accountId,
            mailboxId,
            messageId,
            uidValidity,
            uid,
            sender: (sender?.name || sender?.address || "Unknown sender").slice(
              0,
              256,
            ),
            subject: (remote.envelope.subject ?? "(No subject)").slice(0, 512),
            createdAt: synchronizedAt,
          })
          .onConflictDoNothing();
        if (pruneEvents)
          await db
            .delete(notificationEvents)
            .where(
              lt(notificationEvents.createdAt, sql`now() - interval '7 days'`),
            );
      }
    }
  }
}
