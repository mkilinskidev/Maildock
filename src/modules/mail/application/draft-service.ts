import { OutgoingValidationError } from "./outgoing-message-service";
import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../../../shared/infrastructure/database/database";
import {
  drafts,
  draftAttachments,
  stagedAttachments,
  messageAttachments,
  blobs,
  mailboxMessages,
  mailboxes,
  messages,
} from "../../../shared/infrastructure/database/schema";
import { draftCreate, draftUpdate, DraftConflictError } from "../domain/draft";
import type { z } from "zod";
import type { draftFields } from "../domain/draft";
type DraftTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export class DraftService {
  constructor(private readonly db: Database) {}
  async list() {
    return this.db
      .select({
        id: drafts.id,
        accountId: drafts.accountId,
        subject: drafts.subject,
        to: drafts.to,
        updatedAt: drafts.updatedAt,
      })
      .from(drafts)
      .where(eq(drafts.status, "active"))
      .orderBy(desc(drafts.updatedAt));
  }
  async get(id: string) {
    return this.db.transaction((tx) => this.read(tx, id));
  }
  private async read(tx: DraftTransaction, id: string) {
    const [row] = await tx
      .select()
      .from(drafts)
      .where(eq(drafts.id, id))
      .for("update");
    if (!row || row.status !== "active") throw new DraftConflictError();
    // Promote newly cached Forward selections to durable blob references.
    const pending = await tx
      .select({ a: draftAttachments, incoming: messageAttachments })
      .from(draftAttachments)
      .innerJoin(
        messageAttachments,
        eq(messageAttachments.id, draftAttachments.id),
      )
      .where(eq(draftAttachments.draftId, id))
      .for("share");
    for (const { a, incoming } of pending)
      if (!a.blobId && incoming.blobId)
        await tx
          .update(draftAttachments)
          .set({ blobId: incoming.blobId })
          .where(
            and(
              eq(draftAttachments.draftId, id),
              eq(draftAttachments.id, a.id),
            ),
          );
    const selection = await tx
      .select({
        a: draftAttachments,
        blob: blobs,
        incoming: messageAttachments,
      })
      .from(draftAttachments)
      .leftJoin(blobs, eq(blobs.id, draftAttachments.blobId))
      .leftJoin(
        messageAttachments,
        eq(messageAttachments.id, draftAttachments.id),
      )
      .where(eq(draftAttachments.draftId, id))
      .orderBy(draftAttachments.position);
    return {
      ...row,
      attachments: selection.map(({ a, blob, incoming }) => ({
        id: a.id,
        kind: blob ? ("draft" as const) : ("incoming" as const),
        filename: a.filename,
        type: a.contentType,
        size:
          blob?.size.toString() ?? incoming?.declaredSize?.toString() ?? null,
        status: blob ? "ready" : (incoming?.status ?? "failed"),
        error: blob ? null : (incoming?.error ?? null),
        visible: true,
        inline: false,
      })),
    };
  }

  private async attachments(
    tx: DraftTransaction,
    id: string,
    values: z.infer<typeof draftFields>,
    source: (typeof drafts.$inferSelect)["source"],
  ) {
    const previous = await tx
      .select()
      .from(draftAttachments)
      .where(eq(draftAttachments.draftId, id));
    const rows = [];
    for (const [position, selected] of values.attachments.entries()) {
      const saved = previous.find((a) => a.id === selected.id);
      if (saved?.blobId) {
        rows.push({ ...saved, position });
        continue;
      }
      if (selected.kind === "staged") {
        const [a] = await tx
          .select()
          .from(stagedAttachments)
          .where(eq(stagedAttachments.id, selected.id))
          .for("update");
        if (!a || a.status !== "ready" || a.expiresAt <= new Date())
          throw new OutgoingValidationError(
            "Attachment unavailable or expired.",
          );
        rows.push({
          draftId: id,
          id: a.id,
          kind: "staged",
          blobId: a.blobId,
          filename: a.filename,
          contentType: a.contentType,
          position,
        });
      } else {
        const [a] = await tx
          .select()
          .from(messageAttachments)
          .where(eq(messageAttachments.id, selected.id))
          .for("share");
        if (
          !a ||
          source?.mode !== "forward" ||
          a.messageId !== source.messageId ||
          !a.visible
        )
          throw new OutgoingValidationError("Forward attachment unavailable.");
        rows.push({
          draftId: id,
          id: a.id,
          kind: "incoming",
          blobId: a.blobId,
          filename: a.filename ?? "Attachment",
          contentType: a.contentType,
          position,
        });
      }
    }
    await tx.delete(draftAttachments).where(eq(draftAttachments.draftId, id));
    if (rows.length) await tx.insert(draftAttachments).values(rows);
  }
  async create(input: unknown) {
    const { id, source, attachments, ...fields } = draftCreate.parse(input);
    return this.db.transaction(async (tx) => {
      // A stable client UUID also makes retry after a lost create response safe.
      const inserted = await tx
        .insert(drafts)
        .values({
          id,
          ...fields,
          source: source ?? null,
          composeMode: source?.mode ?? "new",
        })
        .onConflictDoNothing()
        .returning();
      const [row] = await tx
        .select()
        .from(drafts)
        .where(eq(drafts.id, id))
        .for("update");
      if (row.status !== "active") throw new DraftConflictError();
      // Existing create retries must never replace subsequently edited content.
      if (!inserted.length) return this.read(tx, id);
      if (source) {
        const [original] = await tx
          .select({ id: messages.id })
          .from(messages)
          .innerJoin(
            mailboxMessages,
            eq(mailboxMessages.messageId, messages.id),
          )
          .innerJoin(mailboxes, eq(mailboxes.id, mailboxMessages.mailboxId))
          .where(
            and(
              eq(messages.id, source.messageId),
              eq(messages.accountId, source.accountId),
              eq(mailboxes.id, source.mailboxId),
              eq(mailboxes.accountId, source.accountId),
            ),
          );
        if (!original)
          throw new OutgoingValidationError("Source message unavailable.");
      }
      await this.attachments(tx, id, { ...fields, attachments }, row.source);
      return this.read(tx, id);
    });
  }
  async update(id: string, input: unknown) {
    const { expectedRevision, attachments, ...fields } =
      draftUpdate.parse(input);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(drafts)
        .where(eq(drafts.id, id))
        .for("update");
      if (!row || row.status !== "active" || row.revision !== expectedRevision)
        throw new DraftConflictError();
      await this.attachments(tx, id, { ...fields, attachments }, row.source);
      await tx
        .update(drafts)
        .set({ ...fields, revision: row.revision + 1, updatedAt: new Date() })
        .where(eq(drafts.id, id));
      return this.read(tx, id);
    });
  }
  async discard(id: string, expectedRevision: number) {
    const rows = await this.db
      .delete(drafts)
      .where(
        and(
          eq(drafts.id, id),
          eq(drafts.status, "active"),
          eq(drafts.revision, expectedRevision),
        ),
      )
      .returning();
    if (!rows.length) throw new DraftConflictError();
    // Cascade removes associations only. Shared blob bytes remain referenced elsewhere.
  }
}
