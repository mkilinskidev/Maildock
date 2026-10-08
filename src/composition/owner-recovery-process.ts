import { parseConfig } from "../shared/infrastructure/config/config";
import { createWorkerDatabase } from "../shared/infrastructure/database/database-worker";
import { validateDatabaseAuthority } from "../shared/infrastructure/database/database-authority";
import { verifyRecoverySchema } from "../shared/infrastructure/database/restore-verification";
import type { Database } from "../shared/infrastructure/database/database";
import { ownerPasswordSchema } from "../modules/auth/domain/password-policy";
import {
  inspectOwnerRecovery,
  recoverOwner,
  OwnerRecoveryRejected,
} from "../modules/auth/application/owner-recovery";
import { lockOwnerRecovery } from "../modules/auth/application/owner-recovery-state";
import { readTerminal, TerminalInterrupted } from "./owner-recovery-terminal";

let database: ReturnType<typeof createWorkerDatabase> | undefined;
let submitted = false;
try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--restart-pending"))
    throw new OwnerRecoveryRejected();
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new OwnerRecoveryRejected("owner_recovery_tty_required");
  const restart = args[0] === "--restart-pending";
  const config = parseConfig(process.env);
  database = createWorkerDatabase({ ...config, databasePoolSize: 1 });
  await validateDatabaseAuthority(database.client);
  await verifyRecoverySchema(database.db);
  const checked = await database.db.transaction(
    async (transaction) => {
      const tx = transaction as unknown as Database;
      await lockOwnerRecovery(tx);
      return inspectOwnerRecovery(tx, config);
    },
    { isolationLevel: "read committed" },
  );
  if ((checked.status === "recovery") !== restart)
    throw new OwnerRecoveryRejected(
      checked.status === "recovery"
        ? "owner_recovery_pending"
        : "owner_recovery_refused",
    );
  process.stdout.write(
    `Maildock owner recovery\n\nOwner username: ${checked.owner.username}\n\n${restart ? "WARNING: This restarts pending recovery and invalidates its new authenticator and browser authority.\n\n" : ""}This operation will:\n  - replace the owner's password\n  - revoke all active sessions\n  - invalidate the existing authenticator\n  - invalidate existing recovery codes\n  - invalidate pending authentication/MFA ceremonies\n  - require new MFA enrollment\n\nMail accounts, messages, OAuth configuration and application\nsettings will NOT be modified.\n\n`,
  );
  if (
    (await readTerminal("Type RECOVER OWNER to continue: ", false)) !==
    "RECOVER OWNER"
  )
    throw new OwnerRecoveryRejected("owner_recovery_confirmation");
  let password = await readTerminal("New password: ");
  let confirmation = await readTerminal("Confirm password: ");
  if (password !== confirmation)
    throw new OwnerRecoveryRejected("owner_recovery_password_mismatch");
  if (!ownerPasswordSchema.safeParse(password).success)
    throw new OwnerRecoveryRejected("owner_recovery_password_policy");
  submitted = true;
  await recoverOwner(
    database.db,
    config,
    { id: checked.owner.id, username: checked.owner.username! },
    password,
    restart,
  );
  password = confirmation = "";
  process.stdout.write(
    "Owner recovery committed. Sign in with the new password and enroll a new authenticator. Normal access requires verified MFA and a fresh login.\n",
  );
} catch (error) {
  if (error instanceof TerminalInterrupted) {
    process.stderr.write(
      "Owner recovery interrupted before submission; no changes made.\n",
    );
    process.exitCode = 130;
  } else {
    const category =
      error instanceof OwnerRecoveryRejected
        ? error.category
        : "owner_recovery_failed";
    process.stderr.write(
      `${category}: ${submitted ? "Recovery was not confirmed. The commit outcome may be unknown; inspect the instance before retrying. Do not automatically restart pending recovery." : "No changes submitted. For an uninitialized instance use setup; pending recovery requires completion or explicit --restart-pending."}\n`,
    );
    process.exitCode = 1;
  }
} finally {
  await database?.client.end().catch(() => undefined);
}
