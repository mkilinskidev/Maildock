import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../../../shared/infrastructure/database/database";
import {
  mailboxRoles,
  mailboxes,
} from "../../../shared/infrastructure/database/schema";

export const systemMailboxRoles = [
  "archive",
  "trash",
  "sent",
  "drafts",
  "junk",
] as const;
export type SystemMailboxRole = (typeof systemMailboxRoles)[number];
export const roleSpecialUse: Record<SystemMailboxRole, string> = {
  archive: "\\Archive",
  trash: "\\Trash",
  sent: "\\Sent",
  drafts: "\\Drafts",
  junk: "\\Junk",
};

type RoleRow = typeof mailboxRoles.$inferSelect;
type MailboxRow = typeof mailboxes.$inferSelect;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export class MailboxRoleUnavailableError extends Error {}

export function resolveMappedMailbox(
  accountId: string,
  role: SystemMailboxRole,
  mapping: Pick<RoleRow, "accountId" | "mailboxId" | "source"> | undefined,
  candidates: readonly MailboxRow[],
): MailboxRow | null {
  if (!mapping || mapping.accountId !== accountId) return null;
  const selected = candidates.find(
    (item) => item.id === mapping.mailboxId && item.accountId === accountId,
  );
  if (
    !selected ||
    !selected.selectable ||
    selected.lifecycleStatus !== "active"
  )
    return null;
  if (mapping.source === "manual") return selected;
  if (mapping.source !== "special_use") return null;
  const matches = candidates.filter(
    (item) =>
      item.accountId === accountId &&
      item.selectable &&
      item.lifecycleStatus === "active" &&
      item.specialUse.includes(roleSpecialUse[role]),
  );
  return matches.length === 1 && matches[0]?.id === selected.id
    ? selected
    : null;
}

export type MailboxRoleView = Readonly<{
  role: SystemMailboxRole;
  mailboxId: string | null;
  mailboxName: string | null;
  source: "special_use" | "manual" | null;
  available: boolean;
}>;

async function autodetectMissing(
  tx: Transaction,
  accountId: string,
  now: Date,
) {
  const [mappings, candidates] = await Promise.all([
    tx.select().from(mailboxRoles).where(eq(mailboxRoles.accountId, accountId)),
    tx.select().from(mailboxes).where(eq(mailboxes.accountId, accountId)),
  ]);
  for (const role of systemMailboxRoles) {
    if (mappings.some((mapping) => mapping.role === role)) continue;
    const matches = candidates.filter(
      (item) =>
        item.selectable &&
        item.lifecycleStatus === "active" &&
        item.specialUse.includes(roleSpecialUse[role]),
    );
    if (matches.length !== 1) continue;
    await tx
      .insert(mailboxRoles)
      .values({
        accountId,
        role,
        mailboxId: matches[0]!.id,
        source: "special_use",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [mailboxRoles.accountId, mailboxRoles.role],
      });
  }
}

export class MailboxRoleService {
  constructor(private readonly database: Database) {}

  async list(accountId: string): Promise<MailboxRoleView[]> {
    const [mappings, candidates] = await Promise.all([
      this.database
        .select()
        .from(mailboxRoles)
        .where(eq(mailboxRoles.accountId, accountId)),
      this.database
        .select()
        .from(mailboxes)
        .where(eq(mailboxes.accountId, accountId)),
    ]);
    return systemMailboxRoles.map((role) => {
      const mapping = mappings.find((item) => item.role === role);
      const selected = candidates.find(
        (item) => item.id === mapping?.mailboxId,
      );
      return {
        role,
        mailboxId: mapping?.mailboxId ?? null,
        mailboxName: selected?.name ?? null,
        source: (mapping?.source as MailboxRoleView["source"]) ?? null,
        available: Boolean(
          resolveMappedMailbox(accountId, role, mapping, candidates),
        ),
      };
    });
  }

  async autodetect(accountId: string): Promise<void> {
    await this.database.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`mailbox-discovery:${accountId}`}, 0))`,
      );
      await autodetectMissing(tx, accountId, new Date());
    });
  }

  async setManual(
    accountId: string,
    role: SystemMailboxRole,
    mailboxId: string,
  ): Promise<void> {
    await this.database.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`mailbox-discovery:${accountId}`}, 0))`,
      );
      const [selected] = await tx
        .select()
        .from(mailboxes)
        .where(
          and(eq(mailboxes.id, mailboxId), eq(mailboxes.accountId, accountId)),
        )
        .limit(1);
      if (!selected?.selectable || selected.lifecycleStatus !== "active")
        throw new MailboxRoleUnavailableError(
          "Select an active mailbox from this account.",
        );
      if (
        selected.receiveTransport === "gmail" &&
        ((role === "trash" && selected.providerMailboxId !== "TRASH") ||
          (role === "sent" && selected.providerMailboxId !== "SENT") ||
          (role === "junk" && selected.providerMailboxId !== "SPAM") ||
          role === "drafts" ||
          (role === "archive" &&
            selected.viewKind !== "all_mail" &&
            !selected.providerMailboxId?.startsWith("Label_")))
      )
        throw new MailboxRoleUnavailableError(
          "Use native Gmail system labels, or a custom label for Archive. Drafts remain local.",
        );
      const now = new Date();
      await tx
        .insert(mailboxRoles)
        .values({
          accountId,
          role,
          mailboxId,
          source: "manual",
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [mailboxRoles.accountId, mailboxRoles.role],
          set: { mailboxId, source: "manual", updatedAt: now },
        });
    });
  }

  async clearManual(accountId: string, role: SystemMailboxRole): Promise<void> {
    await this.database.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`mailbox-discovery:${accountId}`}, 0))`,
      );
      const [mapping] = await tx
        .select()
        .from(mailboxRoles)
        .where(
          and(
            eq(mailboxRoles.accountId, accountId),
            eq(mailboxRoles.role, role),
          ),
        )
        .limit(1);
      if (mapping?.source !== "manual")
        throw new MailboxRoleUnavailableError(
          "Only a manual mapping can be cleared.",
        );
      await tx
        .delete(mailboxRoles)
        .where(
          and(
            eq(mailboxRoles.accountId, accountId),
            eq(mailboxRoles.role, role),
          ),
        );
      await autodetectMissing(tx, accountId, new Date());
    });
  }
}
