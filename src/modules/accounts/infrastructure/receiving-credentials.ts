import { receivingDiagnostic } from "../../../shared/infrastructure/logging/receiving-diagnostics";
import { and, eq } from "drizzle-orm";
import type { AccountsService } from "../application/accounts-service";
import type { ElectedReceivingCoordinator } from "../../mail/application/receiving-election";
import { mailAccounts } from "../../../shared/infrastructure/database/schema";

/** Composition for isolated receiving lifetimes. Never refresh/decrypt during
 * elected acquisition. The placeholder cannot authenticate; every admitted turn
 * resolves the current captured identity outside its receiving SQL scope. */
export function receivingCredentialBindings(accounts: AccountsService) {
  type Config = ConstructorParameters<typeof ElectedReceivingCoordinator>[0];
  const load: NonNullable<Config["loadOperationConnection"]> = async (
    db,
    id,
    configuration,
  ) => {
    const [row] = await db
      .select()
      .from(mailAccounts)
      .where(
        and(
          eq(mailAccounts.id, id),
          eq(mailAccounts.configurationVersion, configuration),
        ),
      );
    if (!row?.enabled || row.removalRequestedAt)
      throw new Error("Receiving account unavailable");
    return {
      host: row.imapHost,
      port: row.imapPort,
      security: row.imapSecurity as "tls" | "starttls",
      username: row.imapUsername,
      credential: { kind: "password", password: "" },
    };
  };
  const loadAccount: Config["loadAccount"] = async (db, candidate) => {
    const [row] = await db
      .select()
      .from(mailAccounts)
      .where(eq(mailAccounts.id, candidate.account));
    if (!row?.enabled || row.removalRequestedAt)
      throw new Error("Receiving account unavailable");
    const configurationVersion = row.configurationVersion;
    const receivingLifecycleVersion = row.receivingLifecycleVersion;
    return {
      ...candidate,
      onError: () =>
        receivingDiagnostic({
          event: "receiving.credentials",
          operation: "metadata",
          stage: "turn",
          category: "unavailable_or_remote_failure",
          disposition: "retry",
        }),
      connection: await load(db, candidate.account, configurationVersion),
      resolveConnection: (budget) =>
        accounts.resolveReceivingConnection(candidate.account, {
          ...budget,
          configurationVersion,
          receivingLifecycleVersion,
        }),
    };
  };
  const resolveOperationConnection: NonNullable<
    Config["resolveOperationConnection"]
  > = async (operation, captured) => {
    if (!("account" in operation.identity))
      throw new Error("Saved credentials require account identity");
    return accounts.resolveReceivingConnection(operation.identity.account, {
      deadline: operation.deadline,
      signal: operation.signal,
      configurationVersion: operation.identity.configurationVersion,
      receivingLifecycleVersion: captured.receivingLifecycleVersion,
    });
  };
  return {
    loadAccount,
    loadOperationConnection: load,
    resolveOperationConnection,
  };
}
