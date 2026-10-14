import { sql } from "drizzle-orm";
import type { Database } from "../../../shared/infrastructure/database/database";

type Reader = Pick<Database, "execute">;

export async function receivingAccountEnrolled(db: Reader, accountId: string) {
  const [row] = await db.execute(
    sql`select maildock_receiving_account_enrolled(${accountId}::uuid) as enrolled`,
  );
  return row?.enrolled === true;
}

export async function receivingIntentSource(
  db: Reader,
  accountId: string,
  mailboxId: string,
  messageId: string,
) {
  await db.execute(
    sql`select maildock_receiving_intent_source(${accountId}::uuid,${mailboxId}::uuid,${messageId}::uuid)`,
  );
}

/** Validation errors cross the API boundary as existing domain errors. SQL
 * still validates again under locks, including when called without a service. */
export function receivingRequestRejected(error: unknown): boolean {
  const cause = (error as { cause?: { message?: string }; message?: string })
    ?.cause;
  const message = cause?.message ?? (error as Error)?.message;
  return (
    typeof message === "string" &&
    /^Receiving (request|content in-flight|attachment frozen)/.test(message)
  );
}
