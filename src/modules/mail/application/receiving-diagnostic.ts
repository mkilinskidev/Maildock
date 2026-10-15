import { sql } from "drizzle-orm";
import { sanitizeError } from "../../accounts/infrastructure/imap-smtp-mail-provider";
import type { ReceivingOperationHandler } from "./receiving-operation";

/** No SELECT, enrollment, epoch or coverage writes: authentication only. */
export const receivingDiagnosticHandler: ReceivingOperationHandler = async (
  operation,
  context,
) => {
  let result;
  try {
    await context.client.connect();
    context.assertCurrent();
    result = { success: true } as const;
  } catch (error) {
    const failure = sanitizeError(error, "IMAP");
    result = { success: false, category: failure.category } as const;
  }
  await context.retireSocket();
  context.assertCurrent();
  if ("account" in operation.identity && !operation.diagnosticConnection) {
    const identity = operation.identity;
    await context.transaction(async (db) => {
      await db.execute(sql`select maildock_receiving_diagnostic_result(
        ${context.owner.actor}::uuid,${context.owner.generation}::bigint,
        ${identity.account}::uuid,${identity.configurationVersion}::bigint,
        ${context.receivingLifecycleVersion ?? null}::bigint,
        ${result.success},${result.success ? null : result.category})`);
    });
  }
  return result;
};
