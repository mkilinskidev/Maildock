import { asc, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { Database } from "../../../shared/infrastructure/database/database";
import {
  mailAccounts,
  mailPublications,
} from "../../../shared/infrastructure/database/schema";
import { MailboxService, type MailboxView } from "./mailbox-service";
import {
  MailboxRoleService,
  type MailboxRoleView,
} from "./mailbox-role-service";
import { MessageService, type MessagePage } from "./message-service";
import { gmailNeedsAttention } from "../domain/sync-observability";

export type MailPublication = {
  revision: string;
  boxes: Record<string, MailboxView[]>;
  roles: Record<string, MailboxRoleView[]>;
  enabledAccountIds: string[];
  allInboxesUnread: string;
  reader?: { id: string; seen: boolean; flagged: boolean } | null;
  coverage: Record<
    string,
    {
      historyIncomplete: boolean;
      blocked: boolean;
      syncing: boolean;
      currentFreshness: "unknown";
    }
  >;
};

export class MailPublicationService {
  constructor(private readonly database: Database) {}

  async snapshot(input: {
    accountId?: string;
    mailboxId?: string;
    pageSize: number;
    cursor?: string;
    revision?: string;
    reader?: { accountId: string; mailboxId: string; id: string };
  }): Promise<MessagePage & { unchanged?: boolean }> {
    return this.database.transaction(
      async (tx) => {
        // Short local-only MVCC snapshot: no provider calls or synchronization locks.
        const accounts = await tx
          .select({
            id: mailAccounts.id,
            enabled: mailAccounts.enabled,
            transport: mailAccounts.receiveTransport,
            oauthStatus: mailAccounts.oauthStatus,
            revision: sql<string>`coalesce(${mailPublications.revision}, 0)::text`,
          })
          .from(mailAccounts)
          .leftJoin(
            mailPublications,
            eq(mailPublications.accountId, mailAccounts.id),
          )
          .orderBy(asc(mailAccounts.id));
        const [settings] = await tx.execute(
          sql`select conversation_view from instance_state where id = 1`,
        );
        // Bound the poll URL while binding the account vector to its list scope.
        const revision = createHash("sha256")
          .update(
            JSON.stringify([
              input.accountId ?? null,
              input.mailboxId ?? null,
              accounts,
              settings?.conversation_view ?? false,
            ]),
          )
          .digest("hex");
        if (!input.cursor && revision === input.revision)
          return { items: [], nextCursor: null, unchanged: true };
        // Services only use query methods shared by Database and its transaction.
        const database = tx as unknown as Database;
        const boxes: MailPublication["boxes"] = {};
        const roles: MailPublication["roles"] = {};
        const coverage: MailPublication["coverage"] = {};
        const gmailStates = await tx.execute(
          sql`select s.account_id,s.inventory_complete,s.status,s.error_category,s.next_attempt_at,statement_timestamp() as sampled_at from gmail_account_sync_state s join mail_accounts a on a.id=s.account_id and a.work_revision=s.account_revision`,
        );
        for (const account of accounts) {
          boxes[account.id] = await new MailboxService(database).listForAccount(
            account.id,
          );
          roles[account.id] = await new MailboxRoleService(database).list(
            account.id,
          );
          const gmail = gmailStates.find((s) => s.account_id === account.id);
          const reconnectRequired =
            account.oauthStatus === "reconnect_required";
          coverage[account.id] =
            account.transport === "gmail"
              ? {
                  historyIncomplete: !gmail?.inventory_complete,
                  blocked:
                    reconnectRequired ||
                    gmailNeedsAttention(
                      gmail?.status as string | null,
                      gmail?.error_category as string | null,
                      gmail?.next_attempt_at
                        ? new Date(
                            gmail.next_attempt_at as string,
                          ).toISOString()
                        : null,
                      new Date(
                        (gmail?.sampled_at as string) ?? Date.now(),
                      ).getTime(),
                    ),
                  syncing:
                    account.enabled &&
                    gmail?.status !== "ready" &&
                    !gmail?.error_category &&
                    !reconnectRequired,
                  currentFreshness: "unknown",
                }
              : {
                  historyIncomplete: boxes[account.id].some(
                    (b) => b.selectable && b.backfill.status !== "complete",
                  ),
                  blocked:
                    reconnectRequired ||
                    boxes[account.id].some(
                      (b) =>
                        b.recentSync.status === "failed" ||
                        b.deltaSync.status === "failed" ||
                        b.backfill.status === "failed",
                    ),
                  syncing: boxes[account.id].some((b) =>
                    [
                      b.recentSync.status,
                      b.deltaSync.status,
                      b.backfill.status,
                    ].some((s) => s === "pending" || s === "running"),
                  ),
                  currentFreshness: "unknown",
                };
        }
        const service = new MessageService(database);
        const page =
          input.accountId && input.mailboxId
            ? await service.list(
                input.accountId,
                input.mailboxId,
                input.pageSize,
                input.cursor,
              )
            : await service.listAllInboxes(input.pageSize, input.cursor);
        const [count] = await tx.execute(sql`
        select count(distinct (m.account_id, m.id))::text as unread
        from messages m join mailbox_messages p on p.message_id = m.id
        join mailboxes b on b.id = p.mailbox_id and b.account_id = m.account_id
        join mail_accounts a on a.id = m.account_id
        where a.enabled and b.selectable and b.lifecycle_status = 'active'
          and upper(b.remote_path) = 'INBOX' and not p.action_hidden
          and m.remote_missing_at is null and not ('\\Seen' = any(p.flags))`);
        let reader: MailPublication["reader"];
        if (input.reader) {
          const rows = await tx.execute(sql`
          select p.flags from mailbox_messages p join messages m on m.id = p.message_id
          join mailboxes b on b.id = p.mailbox_id
          join mail_accounts a on a.id = m.account_id
          where m.id = ${input.reader.id}::uuid and m.account_id = ${input.reader.accountId}::uuid
            and p.mailbox_id = ${input.reader.mailboxId}::uuid and not p.action_hidden
            and b.selectable and b.lifecycle_status = 'active' and m.remote_missing_at is null
            and (${Boolean(input.accountId)} or a.enabled)
          order by (p.flags @> ARRAY['\\Seen']::text[]), p.id limit 1`);
          reader = rows[0]
            ? {
                id: input.reader.id,
                seen: (rows[0].flags as string[]).includes("\\Seen"),
                flagged: (rows[0].flags as string[]).includes("\\Flagged"),
              }
            : null;
        }
        return {
          ...page,
          publication: {
            revision,
            boxes,
            roles,
            enabledAccountIds: accounts
              .filter((a) => a.enabled)
              .map((a) => a.id),
            allInboxesUnread: String(count.unread),
            reader,
            coverage,
          },
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }
}
