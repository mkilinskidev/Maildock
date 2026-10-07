import { z } from "zod";
import type { Database } from "@/shared/infrastructure/database/database";
import type { AccountsService } from "./accounts-service";
import { accountIdentitySchema } from "../domain/account";
import { MailboxRoleService } from "@/modules/mail/application/mailbox-role-service";
import { SignatureService } from "@/modules/mail/application/signature-service";
import type { AttachmentService } from "@/modules/mail/application/attachment-service";

const settingsSchema = z
  .object({
    identity: accountIdentitySchema,
    // Only changed mappings are submitted. Null restores server autodetection.
    folders: z
      .object({
        sent: z.uuid().nullable().optional(),
        drafts: z.uuid().nullable().optional(),
        archive: z.uuid().nullable().optional(),
        junk: z.uuid().nullable().optional(),
        trash: z.uuid().nullable().optional(),
      })
      .strict(),
    signatures: z
      .object({
        new: z.uuid().nullable(),
        reply: z.uuid().nullable(),
        forward: z.uuid().nullable(),
      })
      .strict(),
  })
  .strict();

export class AccountSettingsService {
  constructor(
    private readonly db: Database,
    private readonly accounts: AccountsService,
    private readonly attachments: AttachmentService,
  ) {}
  async saveGeneral(id: string, input: unknown) {
    const values = settingsSchema.parse(input);
    await this.db.transaction(async (tx) => {
      const database = tx as unknown as Database;
      // Acquire the existing discovery lock before the account row lock.
      const roles = new MailboxRoleService(database);
      for (const role of [
        "sent",
        "drafts",
        "archive",
        "junk",
        "trash",
      ] as const) {
        const mailboxId = values.folders[role];
        if (mailboxId === undefined) continue;
        if (mailboxId === null) await roles.clearManual(id, role);
        else await roles.setManual(id, role, mailboxId);
      }
      await this.accounts.updateIdentity(id, values.identity, database);
      await new SignatureService(database, this.attachments).setDefaults(
        id,
        values.signatures,
      );
    });
    return this.accounts.get(id);
  }
}
