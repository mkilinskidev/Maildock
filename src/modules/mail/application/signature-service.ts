import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../../shared/infrastructure/database/database";
import {
  signatures,
  signatureResources,
  stagedAttachments,
  accountSignatureDefaults,
  mailAccounts,
  blobs,
} from "../../../shared/infrastructure/database/schema";
import {
  richDocumentSchema,
  richResourceIds,
  validateRichDocument,
} from "../domain/rich-document";
import { DraftConflictError } from "../domain/draft";
import { OutgoingValidationError } from "./outgoing-message-service";
import type { AttachmentService } from "./attachment-service";

const fields = z
  .object({
    name: z.string().trim().min(1).max(100),
    richDocument: richDocumentSchema,
  })
  .strict();
const defaultsSchema = z
  .object({
    new: z.uuid().nullable(),
    reply: z.uuid().nullable(),
    forward: z.uuid().nullable(),
  })
  .strict();
class SignatureConflictError extends DraftConflictError {
  constructor() {
    super();
    this.message =
      "This signature changed in another tab or was deleted. Reload it before continuing.";
  }
}
export class SignatureService {
  constructor(
    private readonly db: Database,
    private readonly attachments: AttachmentService,
  ) {}
  async catalog() {
    const [definitions, defaults] = await Promise.all([
      this.db
        .select({ id: signatures.id, name: signatures.name })
        .from(signatures)
        .orderBy(signatures.name),
      this.db.select().from(accountSignatureDefaults),
    ]);
    return {
      signatures: definitions,
      defaults: Object.fromEntries(
        defaults.map(({ accountId, ...values }) => [accountId, values]),
      ),
    };
  }
  async get(id: string) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(signatures)
        .where(eq(signatures.id, id))
        .for("share");
      if (!row) throw new OutgoingValidationError("Signature unavailable.");
      const resources = await tx
        .select({ a: signatureResources, size: blobs.size })
        .from(signatureResources)
        .innerJoin(blobs, eq(blobs.id, signatureResources.blobId))
        .where(eq(signatureResources.signatureId, id));
      return {
        ...row,
        richDocument: validateRichDocument(row.richDocument),
        attachments: resources.map(({ a, size }) => ({
          id: a.id,
          kind: "draft" as const,
          filename: a.filename,
          type: a.contentType,
          size: size.toString(),
          inline: true,
          visible: false,
          status: "ready",
          error: null,
        })),
      };
    });
  }
  async save(id: string, input: unknown, expectedRevision?: number) {
    z.uuid().parse(id);
    const values = fields.parse(input);
    const ids = richResourceIds(values.richDocument);
    // Template definitions cannot contain automatic draft identity.
    if (
      values.richDocument.editor.root.children!.some(
        (n) => n.type === "maildock-signature",
      )
    )
      throw new OutgoingValidationError(
        "A signature cannot contain an automatic signature.",
      );
    for (const resourceId of ids) {
      try {
        await this.attachments.composeResource(id, resourceId);
      } catch {
        throw new OutgoingValidationError(
          "Signature image unavailable or not owned by this signature.",
        );
      }
    }
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(signatures)
        .where(eq(signatures.id, id))
        .for("update");
      if (
        row ? row.revision !== expectedRevision : expectedRevision !== undefined
      )
        throw new SignatureConflictError();
      if (row)
        await tx
          .update(signatures)
          .set({ ...values, revision: row.revision + 1 })
          .where(eq(signatures.id, id));
      else {
        const inserted = await tx
          .insert(signatures)
          .values({ id, ...values })
          .onConflictDoNothing()
          .returning({ id: signatures.id });
        if (!inserted.length) throw new SignatureConflictError();
      }
      const previous = await tx
        .select()
        .from(signatureResources)
        .where(eq(signatureResources.signatureId, id));
      const selected: (typeof signatureResources.$inferInsert)[] = [];
      for (const resourceId of ids) {
        const saved = previous.find((a) => a.id === resourceId);
        if (saved) {
          selected.push(saved);
          continue;
        }
        const [upload] = await tx
          .select()
          .from(stagedAttachments)
          .where(eq(stagedAttachments.id, resourceId))
          .for("update");
        if (
          !upload ||
          upload.draftId !== id ||
          upload.status !== "ready" ||
          upload.expiresAt <= new Date()
        )
          throw new OutgoingValidationError(
            "Image does not belong to this signature.",
          );
        selected.push({
          signatureId: id,
          id: resourceId,
          blobId: upload.blobId,
          filename: upload.filename,
          contentType: upload.contentType,
        });
        await tx
          .update(stagedAttachments)
          .set({ status: "consumed" })
          .where(eq(stagedAttachments.id, resourceId));
      }
      await tx
        .delete(signatureResources)
        .where(eq(signatureResources.signatureId, id));
      if (selected.length) await tx.insert(signatureResources).values(selected);
      return { id, ...values, revision: (row?.revision ?? 0) + 1 };
    });
  }
  async delete(id: string, expectedRevision: number) {
    const removed = await this.db
      .delete(signatures)
      .where(
        and(eq(signatures.id, id), eq(signatures.revision, expectedRevision)),
      )
      .returning();
    if (!removed.length) throw new SignatureConflictError();
    // FK SET NULL clears defaults; association cascade never deletes shared bytes.
  }
  async setDefaults(accountId: string, input: unknown) {
    const values = defaultsSchema.parse(input);
    return this.db.transaction(async (tx) => {
      const [account] = await tx
        .select({ id: mailAccounts.id })
        .from(mailAccounts)
        .where(eq(mailAccounts.id, accountId))
        .for("share");
      if (!account) throw new OutgoingValidationError("Account unavailable.");
      for (const id of new Set(
        Object.values(values).filter((v) => v !== null),
      )) {
        const [row] = await tx
          .select({ id: signatures.id })
          .from(signatures)
          .where(eq(signatures.id, id))
          .for("share");
        if (!row) throw new OutgoingValidationError("Signature unavailable.");
      }
      await tx
        .insert(accountSignatureDefaults)
        .values({ accountId, ...values })
        .onConflictDoUpdate({
          target: accountSignatureDefaults.accountId,
          set: values,
        });
      return values;
    });
  }
  async snapshot(id: string, draftId: string) {
    z.uuid().parse(draftId);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(signatures)
        .where(eq(signatures.id, id))
        .for("share");
      if (!row) throw new OutgoingValidationError("Signature unavailable.");
      const document = validateRichDocument(row.richDocument);
      const resources = await tx
        .select({ a: signatureResources, size: blobs.size })
        .from(signatureResources)
        .innerJoin(blobs, eq(blobs.id, signatureResources.blobId))
        .where(eq(signatureResources.signatureId, id));
      const remap = new Map<string, string>();
      const attachments = [];
      for (const { a, size } of resources) {
        const resourceId = randomUUID();
        remap.set(a.id, resourceId);
        // New binding, same blob. DraftService claims/pins through its normal path.
        await tx.insert(stagedAttachments).values({
          id: resourceId,
          draftId,
          blobId: a.blobId,
          filename: a.filename,
          contentType: a.contentType,
          expiresAt: new Date(Date.now() + 24 * 3600_000),
        });
        attachments.push({
          id: resourceId,
          kind: "staged" as const,
          filename: a.filename,
          type: a.contentType,
          size: size.toString(),
          inline: true,
          visible: false,
          status: "ready",
          error: null,
        });
      }
      const visit = (n: import("../domain/rich-document").RichNode) => {
        if (n.resourceId) {
          const mapped = remap.get(n.resourceId);
          if (!mapped)
            throw new OutgoingValidationError("Signature image unavailable.");
          n.resourceId = mapped;
        }
        n.children?.forEach(visit);
      };
      visit(document.editor.root);
      return { richDocument: document, attachments };
    });
  }
}
