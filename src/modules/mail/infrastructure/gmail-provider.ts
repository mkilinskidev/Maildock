import { and, eq, ne, sql } from "drizzle-orm";
import type { Database } from "../../../shared/infrastructure/database/database";
import {
  gmailAccountSyncState,
  mailAccounts,
} from "../../../shared/infrastructure/database/schema";
import type { AccountsService } from "../../accounts/application/accounts-service";
import { GmailClient } from "../../accounts/infrastructure/gmail-client";
import {
  assertAccountWork,
  StaleAccountWorkError,
} from "../../accounts/domain/receive-transport";
import {
  reserveGmailQuota,
  gmailQuotaConfig,
  type GmailQuotaConfig,
} from "./gmail-quota";

export async function assertGmailPublication(
  tx: Pick<Database, "select">,
  accountId: string,
  revision: string,
) {
  const [account] = await tx
    .select()
    .from(mailAccounts)
    .where(eq(mailAccounts.id, accountId))
    .for("share");
  if (!account || assertAccountWork(account, revision) !== "gmail")
    throw new StaleAccountWorkError();
}
export class GmailProvider {
  readonly limits: GmailQuotaConfig;
  constructor(
    private readonly db: Database,
    private readonly accounts: AccountsService,
    private readonly fetcher?: typeof fetch,
    limits?: GmailQuotaConfig,
    private readonly maxResponseBytes = 40 * 1024 * 1024,
  ) {
    this.limits = limits ?? gmailQuotaConfig.parse(process.env);
  }
  async lease(accountId: string, revision?: string) {
    const lease = await this.accounts.getProviderGmailAccountForWork(
      accountId,
      revision,
    );
    await this.db.transaction(async (tx) => {
      await assertGmailPublication(tx, accountId, lease.revision);
      await tx
        .insert(gmailAccountSyncState)
        .values({ accountId, accountRevision: BigInt(lease.revision) })
        .onConflictDoNothing();
      // Changing credentials invalidates old runs but keeps cached message identity.
      await tx
        .update(gmailAccountSyncState)
        .set({
          accountRevision: BigInt(lease.revision),
          status: "not_started",
          needsWork: true,
          errorCategory: sql`case when ${gmailAccountSyncState.errorCategory}='quota' then 'quota' else null end`,
          nextAttemptAt: sql`case when ${gmailAccountSyncState.errorCategory}='quota' then ${gmailAccountSyncState.nextAttemptAt} else null end`,
          updatedAt: new Date(),
          historyId: null,
          baselineHistoryId: null,
          inventoryRunId: null,
          inventoryPhase: null,
          inventoryNextPageToken: null,
          inventoryPagesComplete: false,
          historyRunId: null,
          historyStartId: null,
          historyNextPageToken: null,
          historyCandidateId: null,
          historyPagesComplete: false,
          historyPageOffset: 0,
          historyPageDigest: null,
          historyPageCount: 0,
          historyTokenTrail: [],
          inventoryPageCount: 0,
          inventoryTokenTrail: [],
          recentReady: false,
          inventoryComplete: false,
        })
        .where(
          and(
            eq(gmailAccountSyncState.accountId, accountId),
            // SQL inequality also keeps quota reservations across reconnects.
            ne(gmailAccountSyncState.accountRevision, BigInt(lease.revision)),
          ),
        );
    });
    return lease;
  }
  client(
    db: Database,
    lease: Awaited<ReturnType<GmailProvider["lease"]>>,
    interactive: boolean,
    signal?: AbortSignal,
  ) {
    return new GmailClient({
      token: async () => {
        const [account] = await db
          .select()
          .from(mailAccounts)
          .where(eq(mailAccounts.id, lease.accountId));
        if (!account || assertAccountWork(account, lease.revision) !== "gmail")
          throw new StaleAccountWorkError();
        return lease.accessToken;
      },
      reserve: (units) =>
        reserveGmailQuota(
          db,
          lease.accountId,
          BigInt(lease.revision),
          units,
          interactive,
          this.limits,
        ),
      fetcher: this.fetcher,
      signal,
      retries: 0,
      deferAuthenticationRefresh: true,
      maxBytes: this.maxResponseBytes,
    });
  }
  async interactive(accountId: string, revision?: string) {
    const lease = await this.lease(accountId, revision);
    // Interactive sources hold no reserved sync connection. The existing resolver
    // can refresh on 401 and fences every acquisition against reconnect/disable.
    let first = true;
    const client = new GmailClient({
      token: async () => {
        if (first) {
          first = false;
          return lease.accessToken;
        }
        return (
          await this.accounts.getProviderGmailAccountForWork(
            accountId,
            lease.revision,
          )
        ).accessToken;
      },
      reserve: (units) =>
        reserveGmailQuota(
          this.db,
          accountId,
          BigInt(lease.revision),
          units,
          true,
          this.limits,
        ),
      fetcher: this.fetcher,
      maxBytes: this.maxResponseBytes,
    });
    return { client, revision: lease.revision };
  }
}
