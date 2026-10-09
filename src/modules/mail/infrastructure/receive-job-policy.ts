import type { PgBoss } from "pg-boss";
import {
  MailTransportRouter,
  StaleAccountWorkError,
} from "../../accounts/domain/receive-transport";

const router = new MailTransportRouter();
export async function imapJobRevision(
  boss: PgBoss,
  accountId: string,
  expected?: string,
): Promise<string> {
  const result = await boss.getDb().executeSql(
    `select provider_type, auth_method, oauth_provider_id, oauth_status, enabled, work_revision::text
     from public.mail_accounts where id = $1`,
    [accountId],
  );
  const row = result.rows[0];
  if (!row) throw new StaleAccountWorkError();
  const account = {
    providerType: row.provider_type,
    authMethod: row.auth_method,
    oauthProviderId: row.oauth_provider_id,
    oauthStatus: row.oauth_status,
    enabled: row.enabled,
    workRevision: BigInt(row.work_revision),
  };
  router.requireImap(account, expected);
  return account.workRevision.toString();
}

export async function assertImapJob(
  boss: PgBoss,
  payload: { accountId: string; accountRevision?: string },
): Promise<void> {
  if (!payload.accountRevision) throw new StaleAccountWorkError();
  await imapJobRevision(boss, payload.accountId, payload.accountRevision);
}
