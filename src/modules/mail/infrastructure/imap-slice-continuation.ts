import type { Logger } from "pino";
import type { PgBoss } from "pg-boss";
import { enqueueCoalescedSync } from "./coalesced-sync-job";
import { bestEffortDiagnostic } from "../../../shared/infrastructure/logging/diagnostics";

export async function enqueueImapContinuation(
  boss: PgBoss,
  queue: string,
  payload: { accountId: string; mailboxId: string; accountRevision: string },
  logger?: Pick<Logger, "debug">,
): Promise<void> {
  // Stately permits one created successor while its predecessor is active.
  // Use the SAME key so retry exclusion, IDLE and producer coalescing still apply.
  await enqueueCoalescedSync(boss, queue, payload, {
    singletonKey: payload.mailboxId,
    priority: 10,
    startAfter: 1,
  });
  const result = await boss
    .getDb()
    .executeSql(
      `
    select exists(select 1 from pgboss.job j join public.mailboxes m
      on m.id::text=j.data->>'mailboxId'
      where j.name in ('mailbox-recent-sync-v1','mailbox-delta-sync-v1')
        and j.state<'active' and not j.blocked and j.start_after<=now()
        and upper(m.remote_path)='INBOX' and j.data->>'mailboxId'<>$1
        and exists(select 1 from public.mailboxes source
          where source.id::text=$1 and upper(source.remote_path)<>'INBOX')) as higher`,
      [payload.mailboxId],
    )
    .catch(() => ({ rows: [] }));
  bestEffortDiagnostic(() =>
    logger?.debug(
      {
        event: "mail.imap_slice_yield",
        accountId: payload.accountId,
        mailboxId: payload.mailboxId,
        continuationReason: "bounded_work",
        higherPriorityWaiting: result.rows[0]?.higher ?? false,
      },
      "IMAP slice released authority to admission",
    ),
  );
}
