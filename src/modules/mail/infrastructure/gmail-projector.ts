import { randomUUID } from "node:crypto";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { Database } from "../../../shared/infrastructure/database/database";
import {
  gmailAccountSyncState,
  gmailSyncWork,
  mailAccounts,
  mailboxes,
  mailboxMessages,
  messages,
  messageAttachments,
  messageCommands,
  instanceState,
  notificationEvents,
  outgoingMessages,
} from "../../../shared/infrastructure/database/schema";
import type {
  GmailMessage,
  GmailLabel,
} from "../../accounts/infrastructure/gmail-client";
import {
  gmailEnvelope,
  gmailStructure,
  gmailParts,
  gmailHeader,
} from "./gmail-mime";
import { assertGmailPublication } from "./gmail-provider";
import { discoverAttachments } from "../domain/attachments";

const systemRoles: Record<string, string> = {
  INBOX: "\\Inbox",
  SENT: "\\Sent",
  TRASH: "\\Trash",
  SPAM: "\\Junk",
};
export async function persistGmailAttachments(
  db: Pick<Database, "insert">,
  accountId: string,
  messageId: string,
  remote: GmailMessage,
) {
  const nativeParts = gmailParts(remote.payload);
  for (const attachment of discoverAttachments(
    gmailStructure(remote.payload),
    "gmail",
  )) {
    const p = nativeParts.find((p) => p.partId === attachment.partId);
    await db
      .insert(messageAttachments)
      .values({
        ...attachment,
        id: randomUUID(),
        accountId,
        messageId,
        receiveTransport: "gmail",
        gmailAttachmentId: p?.body?.attachmentId ?? null,
      })
      .onConflictDoNothing({
        target: [messageAttachments.messageId, messageAttachments.partId],
      });
  }
}
export async function projectGmailLabels(
  db: Database,
  accountId: string,
  revision: string,
  labels: GmailLabel[],
) {
  await db.transaction(async (tx) => {
    await assertGmailPublication(tx, accountId, revision);
    const existing = await tx
      .select()
      .from(mailboxes)
      .where(eq(mailboxes.accountId, accountId));
    const now = new Date();
    const visible = labels.filter(
      (l) => systemRoles[l.id] || l.type === "user",
    );
    for (const label of [...visible, { id: "", name: "All Mail" }]) {
      const all = label.id === "";
      const previous = existing.find((b) =>
        all ? b.viewKind === "all_mail" : b.providerMailboxId === label.id,
      );
      const values = {
        name: label.name,
        remotePath:
          label.id === "INBOX"
            ? "INBOX"
            : all
              ? "@gmail/all-mail"
              : `@gmail/label/${label.id}`,
        specialUse: all
          ? ["\\Archive"]
          : systemRoles[label.id]
            ? [systemRoles[label.id]]
            : [],
        selectable: true,
        lifecycleStatus: "active",
        missingSince: null,
        lastDiscoveredAt: now,
        updatedAt: previous?.updatedAt ?? now,
        reportedMessageCount:
          "messagesTotal" in label && label.messagesTotal !== undefined
            ? BigInt(label.messagesTotal)
            : (previous?.reportedMessageCount ?? null),
        reportedUnseenCount:
          "messagesUnread" in label && label.messagesUnread !== undefined
            ? BigInt(label.messagesUnread)
            : (previous?.reportedUnseenCount ?? null),
      };
      if (previous)
        await tx
          .update(mailboxes)
          .set(values)
          .where(eq(mailboxes.id, previous.id));
      else
        await tx.insert(mailboxes).values({
          ...values,
          id: randomUUID(),
          accountId,
          receiveTransport: "gmail",
          viewKind: all ? "all_mail" : "remote",
          providerMailboxId: all ? null : label.id,
          firstDiscoveredAt: now,
        });
    }
    for (const previous of existing)
      if (
        previous.viewKind !== "all_mail" &&
        !visible.some((l) => l.id === previous.providerMailboxId)
      ) {
        await tx
          .update(mailboxes)
          .set({
            lifecycleStatus: "missing",
            selectable: false,
            missingSince: now,
          })
          .where(eq(mailboxes.id, previous.id));
        await tx
          .delete(mailboxMessages)
          .where(eq(mailboxMessages.mailboxId, previous.id));
      }
    await tx
      .update(mailAccounts)
      .set({
        mailboxDiscoveryStatus: "success",
        mailboxDiscoveryError: null,
        lastSuccessfulMailboxDiscoveryAt: now,
        imapStatus: "success",
        imapError: null,
        updatedAt: now,
      })
      .where(eq(mailAccounts.id, accountId));
  });
}
export type GmailReceipt = {
  runId: string;
  purpose: "inventory" | "history";
  generation?: bigint;
  notify?: boolean;
};
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type ProjectionContext = {
  tx: Transaction;
  state: typeof gmailAccountSyncState.$inferSelect;
  boxes: (typeof mailboxes.$inferSelect)[];
  envelope: Awaited<ReturnType<typeof gmailEnvelope>> | null;
};
export async function projectGmailBatch(
  db: Database,
  accountId: string,
  revision: string,
  items: { nativeId: string; remote: GmailMessage | null }[],
  receipt: GmailReceipt,
) {
  if (items.length > 12)
    throw new Error("Gmail projection batch is too large.");
  const prepared = await Promise.all(
    items.map(async (item) => ({
      ...item,
      envelope: item.remote ? await gmailEnvelope(item.remote) : null,
    })),
  );
  await db.transaction(async (tx) => {
    await assertGmailPublication(tx, accountId, revision);
    const [state] = await tx
      .select()
      .from(gmailAccountSyncState)
      .where(eq(gmailAccountSyncState.accountId, accountId))
      .for("update");
    const boxes = await tx
      .select()
      .from(mailboxes)
      .where(
        and(
          eq(mailboxes.accountId, accountId),
          eq(mailboxes.lifecycleStatus, "active"),
        ),
      );
    for (const item of prepared)
      await projectGmailMessage(
        db,
        accountId,
        revision,
        item.nativeId,
        item.remote,
        receipt,
        { tx, state, boxes, envelope: item.envelope },
      );
    if (items.length) {
      await tx
        .update(gmailSyncWork)
        .set({ status: "complete", updatedAt: new Date() })
        .where(
          and(
            eq(gmailSyncWork.accountId, accountId),
            eq(gmailSyncWork.accountRevision, BigInt(revision)),
            eq(gmailSyncWork.runId, receipt.runId),
            eq(gmailSyncWork.purpose, receipt.purpose),
            inArray(
              gmailSyncWork.gmailMessageId,
              items.map((i) => i.nativeId),
            ),
          ),
        );
      await tx
        .update(gmailAccountSyncState)
        .set({
          processedCount: sql`${gmailAccountSyncState.processedCount}+${items.length}`,
        })
        .where(eq(gmailAccountSyncState.accountId, accountId));
    }
  });
}
export async function projectGmailMessage(
  db: Database,
  accountId: string,
  revision: string,
  nativeId: string,
  remote: GmailMessage | null,
  receipt?: GmailReceipt,
  context?: ProjectionContext,
) {
  const envelope = context
    ? context.envelope
    : remote
      ? await gmailEnvelope(remote)
      : null;
  const publish = async (tx: Transaction) => {
    if (!context) await assertGmailPublication(tx, accountId, revision);
    const state =
      context?.state ??
      (
        await tx
          .select()
          .from(gmailAccountSyncState)
          .where(eq(gmailAccountSyncState.accountId, accountId))
          .for("update")
      )[0];
    if (
      receipt &&
      (state?.accountRevision !== BigInt(revision) ||
        (receipt.purpose === "inventory"
          ? state.inventoryRunId
          : state.historyRunId) !== receipt.runId)
    )
      throw new Error("Gmail run changed before publication.");
    let [local] = await tx
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.accountId, accountId),
          eq(messages.providerMessageId, nativeId),
        ),
      )
      .for("update");
    const fresh = !local;
    const now = new Date();
    if (remote && envelope) {
      const date = new Date(Number(remote.internalDate));
      if (!Number.isFinite(date.getTime()))
        throw new Error("Invalid Gmail message date.");
      const stale =
        local?.providerHistoryId &&
        BigInt(local.providerHistoryId) > BigInt(remote.historyId);
      const values = {
        ...envelope,
        providerThreadId: remote.threadId ?? null,
        providerHistoryId: remote.historyId,
        internalDate: date,
        size: BigInt(remote.sizeEstimate),
        remoteMissingAt: null,
        ...(receipt?.generation
          ? { inventoryGeneration: receipt.generation }
          : {}),
        ...(remote.payload?.mimeType
          ? {
              mimeStructure: gmailStructure(remote.payload),
              hasAttachments: gmailParts(remote.payload).some(
                (p) =>
                  !!p.filename ||
                  /^attachment/i.test(
                    gmailHeader(p, "content-disposition") ?? "",
                  ),
              ),
            }
          : {}),
        updatedAt: now,
      };
      if (!local) {
        [local] = await tx
          .insert(messages)
          .values({
            ...values,
            id: randomUUID(),
            accountId,
            receiveTransport: "gmail",
            providerMessageId: nativeId,
          })
          .returning();
      } else if (!stale)
        await tx.update(messages).set(values).where(eq(messages.id, local.id));
      else if (receipt?.generation)
        await tx
          .update(messages)
          .set({ inventoryGeneration: receipt.generation })
          .where(eq(messages.id, local.id));
      if (!stale) {
        const pending = await tx
          .select()
          .from(messageCommands)
          .where(
            and(
              eq(messageCommands.messageId, local.id),
              eq(messageCommands.accountRevision, BigInt(revision)),
              inArray(messageCommands.status, ["pending", "executing"]),
            ),
          )
          .orderBy(messageCommands.intentSequence);
        let flags = [
          ...(!remote.labelIds.includes("UNREAD") ? ["\\Seen"] : []),
          ...(remote.labelIds.includes("STARRED") ? ["\\Flagged"] : []),
        ];
        for (const command of pending) {
          const flag = command.action.startsWith("mark_")
            ? "\\Seen"
            : "\\Flagged";
          if (["mark_read", "flag"].includes(command.action))
            flags = [...new Set([...flags, flag])];
          if (["mark_unread", "unflag"].includes(command.action))
            flags = flags.filter((f) => f !== flag);
        }
        const boxes =
          context?.boxes ??
          (await tx
            .select()
            .from(mailboxes)
            .where(
              and(
                eq(mailboxes.accountId, accountId),
                eq(mailboxes.lifecycleStatus, "active"),
              ),
            ));
        const memberships = remote.labelIds.includes("DRAFT")
          ? []
          : boxes.filter((b) =>
              b.viewKind === "all_mail"
                ? !remote.labelIds.some((l) => ["TRASH", "SPAM"].includes(l))
                : remote.labelIds.includes(b.providerMailboxId ?? ""),
            );
        await tx.delete(mailboxMessages).where(
          and(
            eq(mailboxMessages.messageId, local.id),
            memberships.length
              ? notInArray(
                  mailboxMessages.mailboxId,
                  memberships.map((b) => b.id),
                )
              : undefined,
          ),
        );
        // Each upsert preserves the original placement UUID. Batch all label
        // memberships while keeping each pending command's hidden projection.
        if (memberships.length)
          await tx
            .insert(mailboxMessages)
            .values(
              memberships.map((box) => ({
                id: randomUUID(),
                accountId,
                receiveTransport: "gmail" as const,
                mailboxId: box.id,
                messageId: local.id,
                flags,
                actionHidden: pending.some(
                  (c) =>
                    c.action === "trash" ||
                    (c.action === "move" && c.mailboxId === box.id) ||
                    (c.action === "archive" &&
                      box.providerMailboxId === "INBOX"),
                ),
                firstSynchronizedAt: now,
                lastSynchronizedAt: now,
              })),
            )
            .onConflictDoUpdate({
              target: [mailboxMessages.mailboxId, mailboxMessages.messageId],
              targetWhere: sql`receive_transport='gmail'`,
              set: {
                flags,
                actionHidden: sql`excluded.action_hidden`,
                lastSynchronizedAt: now,
                updatedAt: now,
              },
            });
        await persistGmailAttachments(tx, accountId, local.id, remote);
        if (
          fresh &&
          receipt?.notify &&
          state?.historyId &&
          state.recentReady &&
          remote.labelIds.includes("INBOX") &&
          !remote.labelIds.includes("DRAFT") &&
          date >= state.createdAt
        ) {
          const inbox = boxes.find((b) => b.providerMailboxId === "INBOX");
          if (inbox) {
            await tx
              .insert(instanceState)
              .values({ id: 1 })
              .onConflictDoNothing();
            const [sequence] = await tx
              .update(instanceState)
              .set({
                notificationSequence: sql`${instanceState.notificationSequence} + 1`,
              })
              .where(eq(instanceState.id, 1))
              .returning({ value: instanceState.notificationSequence });
            await tx
              .insert(notificationEvents)
              .values({
                sequence: sequence.value,
                accountId,
                messageId: local.id,
                mailboxId: inbox.id,
                receiveTransport: "gmail",
                sender: (
                  envelope.from[0]?.name ||
                  envelope.from[0]?.address ||
                  "Unknown sender"
                ).slice(0, 256),
                subject: (envelope.subject ?? "(No subject)").slice(0, 512),
              })
              .onConflictDoNothing();
          }
        }
        if (remote.labelIds.includes("SENT") && envelope.rfcMessageId) {
          const candidates = await tx
            .select()
            .from(outgoingMessages)
            .where(
              and(
                eq(outgoingMessages.accountId, accountId),
                eq(outgoingMessages.messageId, envelope.rfcMessageId),
                eq(outgoingMessages.status, "sent"),
              ),
            )
            .limit(2);
          const other =
            candidates.length === 1
              ? await tx
                  .select({ id: messages.id })
                  .from(messages)
                  .where(
                    and(
                      eq(messages.accountId, accountId),
                      eq(messages.rfcMessageId, envelope.rfcMessageId),
                    ),
                  )
                  .limit(2)
              : [];
          if (
            candidates.length === 1 &&
            other.length === 1 &&
            Math.abs(
              date.getTime() -
                (
                  candidates[0].smtpAcceptedAt ?? candidates[0].createdAt
                ).getTime(),
            ) <=
              15 * 60000 &&
            envelope.from.some(
              (a) =>
                a.address?.toLowerCase() ===
                candidates[0].from.address.toLowerCase(),
            )
          )
            await tx
              .update(outgoingMessages)
              .set({ sentCopyMessageId: local.id, updatedAt: now })
              .where(eq(outgoingMessages.id, candidates[0].id));
        }
      }
    } else if (local) {
      await tx
        .update(messages)
        .set({ remoteMissingAt: now, updatedAt: now })
        .where(eq(messages.id, local.id));
      await tx
        .delete(mailboxMessages)
        .where(eq(mailboxMessages.messageId, local.id));
    }
    if (receipt && !context) {
      await tx
        .update(gmailSyncWork)
        .set({ status: "complete", updatedAt: now })
        .where(
          and(
            eq(gmailSyncWork.accountId, accountId),
            eq(gmailSyncWork.accountRevision, BigInt(revision)),
            eq(gmailSyncWork.runId, receipt.runId),
            eq(gmailSyncWork.purpose, receipt.purpose),
            eq(gmailSyncWork.gmailMessageId, nativeId),
          ),
        );
      await tx
        .update(gmailAccountSyncState)
        .set({
          processedCount: sql`${gmailAccountSyncState.processedCount} + 1`,
        })
        .where(eq(gmailAccountSyncState.accountId, accountId));
    }
  };
  if (context) await publish(context.tx);
  else await db.transaction(publish);
}
