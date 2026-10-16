import { sql } from "drizzle-orm";
import type { Database } from "../../../shared/infrastructure/database/database";

export type ReceivingWakeTarget = Readonly<{
  /** Bounded hint only. The elected coordinator must reload durable eligibility. */
  notify(accountId: string): Promise<void>;
}>;

/** Demand commits before best-effort transport. Delivery never clears demand.
 * Evidence/frontiers and their Stage 1 revision/fences remain separate. */
export class ReceivingDemand {
  constructor(
    private readonly database: Database,
    private readonly wake: (accountId: string) => Promise<unknown>,
  ) {}

  async request(accountId: string, mailboxId?: string): Promise<boolean> {
    const row = await this.record(accountId, mailboxId);
    if (!row.accepted) return false;
    await this.deliver(accountId);
    return true; // Accepted durable demand, including coalesced/failed delivery.
  }

  async record(accountId: string, mailboxId?: string) {
    const [row] = await this.database.execute(
      sql`select * from maildock_receiving_request(${accountId}::uuid,${mailboxId ?? null}::uuid)`,
    );
    return { accepted: row?.accepted === true, inbox: row?.inbox === true };
  }

  async deliver(accountId: string): Promise<boolean> {
    try {
      await this.wake(accountId);
      return true;
    } catch {
      return false; // Next repair revisits the unchanged PostgreSQL hint.
    }
  }

  async eligible(accountId: string): Promise<boolean> {
    const [row] = await this.database.execute(sql`
      select exists(select from mail_accounts a where a.id=${accountId}::uuid
        and a.enabled and (${receivingEligibility})) as eligible`);
    return row?.eligible === true;
  }

  /** Keyset over ALL accounts, then evaluate eligibility. Each tick reads at
   * most one page and retains one cursor; failed sends remain due next sweep. */
  async repairPage(after: string | null, limit = 128) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128)
      throw new Error("Invalid receiving repair page size");
    const rows = await this.database.execute(sql`
      select a.id, a.enabled and (${receivingEligibility}) as eligible
      from mail_accounts a where (${after}::uuid is null or a.id>${after}::uuid)
      order by a.id limit ${limit}`);
    let delivered = 0;
    for (const row of rows)
      if (row.eligible && (await this.deliver(row.id as string))) delivered++;
    return {
      read: rows.length,
      delivered,
      next: rows.length === limit ? (rows.at(-1)!.id as string) : null,
    };
  }
}

// No recent/history-success prerequisite. E>1 is the only history progress test;
// no enrollment is itself fresh work. Secondary execution awaits Stage 5.
const receivingEligibility = sql`
  a.receiving_due_at<=clock_timestamp() or exists(
    select from mailboxes m left join receiving_mailboxes s on s.mailbox_id=m.id
    where m.account_id=a.id and m.selectable and m.lifecycle_status='active'
      and (m.receiving_due_at<=clock_timestamp() or s.mailbox_id is null or s.history_before>1)
  ) or exists(select from message_commands c where c.account_id=a.id
    and c.status in ('pending','executing'))
  or exists(select from message_contents c join messages msg on msg.id=c.message_id
    where msg.account_id=a.id and c.status in ('pending','fetching'))
  or exists(select from message_attachments c join messages msg on msg.id=c.message_id
    where msg.account_id=a.id and c.status in ('pending','fetching'))
  or exists(select from outgoing_messages o where o.account_id=a.id and o.status='sent'
    and o.sent_copy_policy='maildock' and (o.sent_copy_status in ('pending','saving','uncertain') or o.sent_copy_sync_pending))`;

/** Isolated repair driver; Stage 4C owns its eventual startup/timer lifecycle. */
export class ReceivingDueRepair {
  private cursor: string | null = null;
  private running = false;
  constructor(
    private readonly demand: ReceivingDemand,
    private readonly pageSize = 128,
  ) {}

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const page = await this.demand.repairPage(this.cursor, this.pageSize);
      this.cursor = page.next;
      return page;
    } finally {
      this.running = false;
    }
  }
}
