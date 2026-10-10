import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../../shared/infrastructure/database/database";
import { gmailAccountSyncState } from "../../../shared/infrastructure/database/schema";
import { GmailApiError } from "../../accounts/infrastructure/gmail-client";

export const gmailQuotaConfig = z.object({
  MAILDOCK_GMAIL_USER_UNITS_PER_MINUTE: z.coerce
    .number()
    .int()
    .min(100)
    .max(6000)
    .default(4000),
  MAILDOCK_GMAIL_PROJECT_UNITS_PER_MINUTE: z.coerce
    .number()
    .int()
    .min(100)
    .max(1200000)
    .default(100000),
  MAILDOCK_GMAIL_DAILY_UNITS: z.coerce
    .number()
    .int()
    .min(100)
    .max(80000000)
    .default(2000000),
});
export type GmailQuotaConfig = z.infer<typeof gmailQuotaConfig>;
/** Short reservations on the caller's connection; never hold a transaction over HTTP.
 * All configured Google accounts share one application Google Cloud project. */
export async function reserveGmailQuota(
  db: Database,
  accountId: string,
  revision: bigint,
  units: number,
  interactive: boolean,
  limits: GmailQuotaConfig,
  now = Date.now(),
) {
  const minute = BigInt(Math.floor(now / 60000));
  const day = BigInt(Math.floor(now / 86400000));
  const admitted = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('maildock-gmail-project-quota'))`,
    );
    const rows = await tx.select().from(gmailAccountSyncState);
    const current = rows.find(
      (row) => row.accountId === accountId && row.accountRevision === revision,
    );
    if (!current) throw new GmailApiError("authentication");
    const rolling = (r: typeof current) =>
      r.quotaMinute === minute
        ? r.quotaCurrentUnits + r.quotaPreviousUnits
        : r.quotaMinute === minute - 1n
          ? r.quotaCurrentUnits
          : 0n;
    const daily = rows.reduce(
      (sum, r) => sum + (r.quotaDay === day ? r.quotaDailyUnits : 0n),
      0n,
    );
    const project = rows.reduce((sum, r) => sum + rolling(r), 0n);
    const fraction = interactive ? 1 : 0.7;
    const dailyLimit = BigInt(
      Math.floor(limits.MAILDOCK_GMAIL_DAILY_UNITS * fraction),
    );
    if (
      rolling(current) + BigInt(units) >
        BigInt(
          Math.floor(limits.MAILDOCK_GMAIL_USER_UNITS_PER_MINUTE * fraction),
        ) ||
      project + BigInt(units) >
        BigInt(
          Math.floor(limits.MAILDOCK_GMAIL_PROJECT_UNITS_PER_MINUTE * fraction),
        ) ||
      daily + BigInt(units) > dailyLimit
    )
      return daily + BigInt(units) > dailyLimit
        ? 86400000 - (now % 86400000)
        : 120000 - (now % 60000);
    await tx
      .update(gmailAccountSyncState)
      .set({
        quotaMinute: minute,
        quotaPreviousUnits:
          current.quotaMinute === minute
            ? current.quotaPreviousUnits
            : current.quotaMinute === minute - 1n
              ? current.quotaCurrentUnits
              : 0n,
        quotaCurrentUnits:
          (current.quotaMinute === minute ? current.quotaCurrentUnits : 0n) +
          BigInt(units),
        quotaDay: day,
        quotaDailyUnits:
          (current.quotaDay === day ? current.quotaDailyUnits : 0n) +
          BigInt(units),
      })
      .where(
        and(
          eq(gmailAccountSyncState.accountId, accountId),
          eq(gmailAccountSyncState.accountRevision, revision),
        ),
      );
    return 0;
  });
  if (admitted) throw new GmailApiError("quota", admitted);
}
