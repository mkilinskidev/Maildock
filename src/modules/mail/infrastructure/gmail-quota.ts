import { and, eq, sql, gte, or, lt } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Database } from "../../../shared/infrastructure/database/database";
import {
  gmailAccountSyncState,
  gmailQuotaBuckets,
  mailAccounts,
} from "../../../shared/infrastructure/database/schema";
import { GmailApiError } from "../../accounts/infrastructure/gmail-client";
import {
  assertAccountWork,
  StaleAccountWorkError,
} from "../../accounts/domain/receive-transport";

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
  now?: number,
) {
  const admitted = await db.transaction(async (tx) => {
    const [account] = await tx
      .select()
      .from(mailAccounts)
      .where(eq(mailAccounts.id, accountId))
      .for("share");
    if (!account || assertAccountWork(account, revision.toString()) !== "gmail")
      throw new StaleAccountWorkError();
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('maildock-gmail-project-quota'))`,
    );
    // Timestamp admission after lock acquisition, using one shared DB clock.
    // Explicit time is only an injection seam for deterministic fixtures.
    const [clock] =
      now === undefined
        ? await tx.execute<{ ms: string }>(
            sql`select floor(extract(epoch from clock_timestamp())*1000)::text as ms`,
          )
        : [];
    const admittedAt = now ?? Number(clock.ms);
    const minute = BigInt(Math.floor(admittedAt / 60000));
    const second = BigInt(Math.floor(admittedAt / 1000));
    const day = BigInt(Math.floor(admittedAt / 86400000));
    const [current] = await tx
      .select()
      .from(gmailAccountSyncState)
      .where(
        and(
          eq(gmailAccountSyncState.accountId, accountId),
          eq(gmailAccountSyncState.accountRevision, revision),
        ),
      );
    if (!current) throw new GmailApiError("authentication");
    const user = `user:${createHash("sha256").update(account.oauthHomeAccountId!).digest("hex")}`;
    // Include the entire boundary second: at most 1s conservative, never an
    // underestimate at a minute boundary. Ledger has no account-delete cascade.
    await tx
      .delete(gmailQuotaBuckets)
      .where(
        or(
          and(
            eq(gmailQuotaBuckets.kind, "second"),
            lt(gmailQuotaBuckets.bucket, second - 60n),
          ),
          and(
            eq(gmailQuotaBuckets.kind, "day"),
            lt(gmailQuotaBuckets.bucket, day),
          ),
        ),
      );
    const rows = await tx
      .select()
      .from(gmailQuotaBuckets)
      .where(
        or(
          and(
            eq(gmailQuotaBuckets.kind, "second"),
            gte(gmailQuotaBuckets.bucket, second - 60n),
            or(
              eq(gmailQuotaBuckets.scope, "project"),
              eq(gmailQuotaBuckets.scope, user),
            ),
          ),
          and(
            eq(gmailQuotaBuckets.kind, "day"),
            eq(gmailQuotaBuckets.bucket, day),
            eq(gmailQuotaBuckets.scope, "project"),
          ),
        ),
      );
    const daily = rows.find((r) => r.kind === "day")?.units ?? 0n;
    const fraction = interactive ? 1 : 0.7;
    const dailyLimit = BigInt(
      Math.floor(limits.MAILDOCK_GMAIL_DAILY_UNITS * fraction),
    );
    if (daily + BigInt(units) > dailyLimit)
      return 86400000 - (admittedAt % 86400000);
    let retryAfter = 0;
    for (const [scope, limit] of [
      [user, limits.MAILDOCK_GMAIL_USER_UNITS_PER_MINUTE],
      ["project", limits.MAILDOCK_GMAIL_PROJECT_UNITS_PER_MINUTE],
    ] as const) {
      const buckets = rows
        .filter((r) => r.kind === "second" && r.scope === scope)
        .sort((a, b) => (a.bucket < b.bucket ? -1 : 1));
      let usage = buckets.reduce((sum, r) => sum + r.units, 0n);
      const ceiling = BigInt(Math.floor(limit * fraction));
      for (const bucket of buckets) {
        if (usage + BigInt(units) <= ceiling) break;
        usage -= bucket.units;
        retryAfter = Math.max(
          retryAfter,
          Number(bucket.bucket) * 1000 + 61000 - admittedAt,
        );
      }
      if (BigInt(units) > ceiling) retryAfter = Math.max(retryAfter, 61000);
    }
    if (retryAfter) return retryAfter;
    for (const value of [
      { scope: user, kind: "second", bucket: second },
      { scope: "project", kind: "second", bucket: second },
      { scope: "project", kind: "day", bucket: day },
    ])
      await tx
        .insert(gmailQuotaBuckets)
        .values({ ...value, units: BigInt(units) })
        .onConflictDoUpdate({
          target: [
            gmailQuotaBuckets.scope,
            gmailQuotaBuckets.kind,
            gmailQuotaBuckets.bucket,
          ],
          set: { units: sql`${gmailQuotaBuckets.units}+${BigInt(units)}` },
        });
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
