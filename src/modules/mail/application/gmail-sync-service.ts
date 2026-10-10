import { randomUUID, createHash } from "node:crypto";
import { and, eq, ne, or, isNull, sql } from "drizzle-orm";
import type { Database } from "../../../shared/infrastructure/database/database";
import {
  gmailAccountSyncState,
  gmailSyncWork,
  mailAccounts,
  mailboxes,
  messages,
  messageCommands,
} from "../../../shared/infrastructure/database/schema";
import {
  GmailApiError,
  type GmailClient,
} from "../../accounts/infrastructure/gmail-client";
import { StaleAccountWorkError } from "../../accounts/domain/receive-transport";
import {
  GmailProvider,
  assertGmailPublication,
} from "../infrastructure/gmail-provider";
import type { GmailAccountLock } from "../infrastructure/gmail-account-lock";
import { GmailSyncRepository } from "../infrastructure/gmail-sync-repository";
import {
  projectGmailMessage,
  projectGmailBatch,
  projectGmailLabels,
} from "../infrastructure/gmail-projector";
import { MailboxRoleService } from "./mailbox-role-service";

type State = typeof gmailAccountSyncState.$inferSelect;
const resetHistory = {
  historyRunId: null,
  historyStartId: null,
  historyNextPageToken: null,
  historyCandidateId: null,
  historyPagesComplete: false,
  historyPageCount: 0,
  historyTokenTrail: [],
  historyPageOffset: 0,
  historyPageDigest: null,
};
const resetInventory = {
  inventoryRunId: null,
  inventoryPhase: null,
  inventoryNextPageToken: null,
  inventoryPagesComplete: false,
  inventoryPageCount: 0,
  inventoryTokenTrail: [],
};

/** A delivery performs one bounded slice. Queue acknowledgement never owns progress. */
export class GmailSyncService {
  constructor(
    private readonly db: Database,
    private readonly provider: GmailProvider,
    private readonly lock: GmailAccountLock,
    private readonly recentDays = 30,
  ) {}
  async wake(accountId: string) {
    const [account] = await this.db
      .select()
      .from(mailAccounts)
      .where(eq(mailAccounts.id, accountId));
    if (!account) throw new StaleAccountWorkError();
    await this.db
      .insert(gmailAccountSyncState)
      .values({ accountId, accountRevision: account.workRevision })
      .onConflictDoNothing();
    await this.db
      .update(gmailAccountSyncState)
      .set({
        needsWork: true,
        nextAttemptAt: sql`case when ${gmailAccountSyncState.errorCategory} is null then null else ${gmailAccountSyncState.nextAttemptAt} end`,
      })
      .where(eq(gmailAccountSyncState.accountId, accountId));
  }
  async run(
    accountId: string,
    revision: string,
    signal?: AbortSignal,
    refreshed = false,
  ): Promise<void> {
    // OAuth's DB-backed refresh happens before reserving execution authority.
    const lease = await this.provider.lease(accountId, revision);
    try {
      await this.lock(accountId, async (db) => {
        await db.transaction((tx) =>
          assertGmailPublication(tx, accountId, revision),
        );
        const [state] = await db
          .select()
          .from(gmailAccountSyncState)
          .where(eq(gmailAccountSyncState.accountId, accountId));
        await db.execute(
          sql`delete from public.gmail_sync_work where ctid in (select ctid from public.gmail_sync_work where account_id=${accountId}::uuid and (account_revision<>${BigInt(revision)} or (run_id is distinct from ${state.inventoryRunId}::uuid and run_id is distinct from ${state.historyRunId}::uuid)) limit 500)`,
        );
        // History is background receiving too; only user content/actions may
        // consume the interactive quota reserve.
        const client = this.provider.client(db, lease, false, signal);
        if (state.nextAttemptAt && state.nextAttemptAt > new Date()) return;
        const [command] = await db
          .select({ id: messageCommands.id })
          .from(messageCommands)
          .where(
            and(
              eq(messageCommands.accountId, accountId),
              eq(messageCommands.accountRevision, BigInt(revision)),
              or(
                eq(messageCommands.status, "pending"),
                eq(messageCommands.status, "executing"),
              ),
            ),
          )
          .limit(1);
        if (command) {
          await this.update(db, state, revision, {
            nextAttemptAt: new Date(Date.now() + 1000),
            needsWork: true,
          });
          return;
        }
        if (!state.baselineHistoryId || state.status === "reconcile_required") {
          await this.bootstrap(db, client, state, revision);
          return;
        }
        if (state.historyRunId) {
          await this.history(db, client, state, revision);
          return;
        }
        if (state.inventoryRunId) {
          await this.inventory(db, client, state, revision);
          return;
        }
        await this.update(db, state, revision, {
          ...resetHistory,
          historyRunId: randomUUID(),
          historyStartId: state.historyId ?? state.baselineHistoryId,
          needsWork: true,
        });
      });
    } catch (error) {
      if (error instanceof StaleAccountWorkError) return;
      if (error instanceof GmailApiError) {
        // HTTP work has released authority. Refresh once outside a pool=1 lease.
        if (error.category === "authentication" && !refreshed)
          return this.run(accountId, revision, signal, true);
        await this.db.transaction(async (tx) => {
          await assertGmailPublication(tx, accountId, revision);
          const category =
            error.category === "cursor_expired"
              ? "history_expired"
              : error.category === "access_denied"
                ? "api_disabled"
                : ["not_found", "cancelled"].includes(error.category)
                  ? "network"
                  : error.category;
          await tx
            .update(gmailAccountSyncState)
            .set({
              ...(["history_expired", "cursor_expired"].includes(error.category)
                ? {
                    status: "reconcile_required",
                    inventoryComplete: false,
                    ...resetHistory,
                  }
                : {}),
              ...(["authentication", "api_disabled", "access_denied"].includes(
                error.category,
              )
                ? { status: "blocked" }
                : {}),
              errorCategory: category,
              needsWork: true,
              nextAttemptAt: new Date(
                Date.now() +
                  Math.max(
                    error.retryAfterMs,
                    [
                      "authentication",
                      "api_disabled",
                      "access_denied",
                    ].includes(error.category)
                      ? 300000
                      : 30000,
                  ),
              ),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(gmailAccountSyncState.accountId, accountId),
                eq(gmailAccountSyncState.accountRevision, BigInt(revision)),
              ),
            );
          await tx
            .update(mailAccounts)
            .set({ imapStatus: "error", imapError: error.message })
            .where(eq(mailAccounts.id, accountId));
        });
        return;
      }
      throw error;
    }
  }
  private async update(
    db: Database,
    state: State,
    revision: string,
    values: Partial<typeof gmailAccountSyncState.$inferInsert>,
  ) {
    await db.transaction(async (tx) => {
      await assertGmailPublication(tx, state.accountId, revision);
      const result = await tx
        .update(gmailAccountSyncState)
        .set({ ...values, updatedAt: new Date() })
        .where(
          and(
            eq(gmailAccountSyncState.accountId, state.accountId),
            eq(gmailAccountSyncState.accountRevision, BigInt(revision)),
            sql`${gmailAccountSyncState.inventoryRunId} is not distinct from ${state.inventoryRunId}::uuid`,
            sql`${gmailAccountSyncState.historyRunId} is not distinct from ${state.historyRunId}::uuid`,
            sql`${gmailAccountSyncState.historyId} is not distinct from ${state.historyId}`,
          ),
        )
        .returning({ id: gmailAccountSyncState.accountId });
      if (!result.length) throw new StaleAccountWorkError();
    });
  }
  private async bootstrap(
    db: Database,
    client: GmailClient,
    state: State,
    revision: string,
  ) {
    const profile = await client.profile();
    // Baseline must survive a label/catalog failure before enumeration.
    const cutoff = new Date(Date.now() - this.recentDays * 86400000);
    cutoff.setUTCHours(0, 0, 0, 0);
    await this.update(db, state, revision, {
      ...resetInventory,
      baselineHistoryId: profile.historyId,
      status: state.historyId ? "reconciling" : "initializing",
      inventoryGeneration: state.inventoryGeneration + 1n,
      inventoryRunId: randomUUID(),
      inventoryPhase: "recent",
      recentCutoff: cutoff,
      historicalBefore: cutoff,
      inventoryComplete: false,
      recentReady: false,
      needsWork: true,
      nextAttemptAt: null,
      errorCategory: null,
      ...resetHistory,
    });
    await this.labels(db, client, state.accountId, revision);
  }
  private async labels(
    db: Database,
    client: GmailClient,
    accountId: string,
    revision: string,
  ) {
    const catalog = await client.labels();
    await projectGmailLabels(db, accountId, revision, catalog.labels);
    const stored = await db
      .select()
      .from(mailboxes)
      .where(eq(mailboxes.accountId, accountId));
    // Bound counter work. Unknown counters are filled first, then rotate by time.
    const selected = stored
      .filter((b) => b.providerMailboxId && b.lifecycleStatus === "active")
      .sort(
        (a, b) =>
          Number(a.reportedMessageCount !== null) -
            Number(b.reportedMessageCount !== null) ||
          a.updatedAt.getTime() - b.updatedAt.getTime(),
      )
      .slice(0, 4);
    for (const box of selected) {
      const counter = await client.label(box.providerMailboxId!);
      await db.transaction(async (tx) => {
        await assertGmailPublication(tx, accountId, revision);
        await tx
          .update(mailboxes)
          .set({
            reportedMessageCount:
              counter.messagesTotal === undefined
                ? null
                : BigInt(counter.messagesTotal),
            reportedUnseenCount:
              counter.messagesUnread === undefined
                ? null
                : BigInt(counter.messagesUnread),
            updatedAt: new Date(),
          })
          .where(eq(mailboxes.id, box.id));
      });
    }
    await new MailboxRoleService(db).autodetect(accountId);
  }
  private async drain(
    db: Database,
    client: GmailClient,
    state: State,
    revision: string,
    purpose: "inventory" | "history",
  ) {
    const runId = (
      purpose === "inventory" ? state.inventoryRunId : state.historyRunId
    )!;
    const scope = and(
      eq(gmailSyncWork.accountId, state.accountId),
      eq(gmailSyncWork.runId, runId),
      eq(gmailSyncWork.purpose, purpose),
      ne(gmailSyncWork.status, "complete"),
    );
    const work = await db.select().from(gmailSyncWork).where(scope).limit(12);
    // Four in-flight requests, three waves, bound interactive lock latency.
    for (let offset = 0; offset < work.length; offset += 4) {
      const responses = await Promise.allSettled(
        work.slice(offset, offset + 4).map(async (item) => {
          try {
            return { item, remote: await client.message(item.gmailMessageId) };
          } catch (error) {
            if (
              error instanceof GmailApiError &&
              error.category === "not_found"
            )
              return { item, remote: null };
            throw error;
          }
        }),
      );
      const successful = responses
        .filter((r) => r.status === "fulfilled")
        .map((r) => ({
          nativeId: r.value.item.gmailMessageId,
          remote: r.value.remote,
        }));
      await projectGmailBatch(db, state.accountId, revision, successful, {
        runId,
        purpose,
        generation:
          purpose === "inventory" ? state.inventoryGeneration : undefined,
        notify: purpose === "history" && state.status === "ready",
      });
      const failure = responses.find((r) => r.status === "rejected");
      if (failure) throw failure.reason;
    }
    return work.length > 0;
  }
  private async inventory(
    db: Database,
    client: GmailClient,
    state: State,
    revision: string,
  ) {
    const catalog = await db
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(eq(mailboxes.accountId, state.accountId))
      .limit(1);
    if (!catalog.length) {
      await this.labels(db, client, state.accountId, revision);
      return;
    }
    if (await this.drain(db, client, state, revision, "inventory")) return;
    if (!state.inventoryPagesComplete) {
      const query =
        state.inventoryPhase === "recent"
          ? `after:${Math.floor(state.recentCutoff!.getTime() / 1000)}`
          : state.inventoryPhase === "historical"
            ? `before:${Math.floor(state.historicalBefore!.getTime() / 1000) + 1}`
            : undefined;
      const page = await client.messages(
        query,
        state.inventoryNextPageToken ?? undefined,
      );
      if (
        page.nextPageToken &&
        page.nextPageToken === state.inventoryNextPageToken
      )
        throw new GmailApiError("invalid_response");
      await new GmailSyncRepository(db).stagePage({
        accountId: state.accountId,
        revision: BigInt(revision),
        runId: state.inventoryRunId!,
        purpose: "inventory",
        messageIds: page.messages.map((m) => m.id),
        expectedPageToken: state.inventoryNextPageToken,
        nextPageToken: page.nextPageToken ?? null,
      });
      // Catch up between bounded historical pages, never postpone until 41k completes.
      if (state.recentReady && state.historyId)
        await this.update(db, state, revision, {
          ...resetHistory,
          historyRunId: randomUUID(),
          historyStartId: state.historyId,
        });
      return;
    }
    if (state.inventoryPhase === "recent") {
      await db
        .update(mailboxes)
        .set({
          recentSyncStatus: "success",
          recentSyncError: null,
          lastSuccessfulRecentSyncAt: new Date(),
        })
        .where(eq(mailboxes.accountId, state.accountId));
      await this.update(db, state, revision, {
        ...resetInventory,
        ...resetHistory,
        recentReady: true,
        inventoryRunId: randomUUID(),
        inventoryPhase: "historical",
        historyRunId: randomUUID(),
        historyStartId: state.historyId ?? state.baselineHistoryId,
      });
      return;
    }
    // Page exhaustion alone proves no absence: exact GET every unseen identity.
    const unseen = await db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.accountId, state.accountId),
          isNull(messages.remoteMissingAt),
          or(
            isNull(messages.inventoryGeneration),
            ne(messages.inventoryGeneration, state.inventoryGeneration),
          ),
        ),
      )
      .limit(12);
    for (const local of unseen) {
      let remote;
      try {
        remote = await client.message(local.providerMessageId!);
      } catch (error) {
        if (!(error instanceof GmailApiError && error.category === "not_found"))
          throw error;
        remote = null;
      }
      await projectGmailMessage(
        db,
        state.accountId,
        revision,
        local.providerMessageId!,
        remote,
        {
          purpose: "inventory",
          runId: state.inventoryRunId!,
          generation: state.inventoryGeneration,
        },
      );
    }
    if (unseen.length) return;
    await this.update(db, state, revision, {
      ...resetInventory,
      ...resetHistory,
      historyRunId: randomUUID(),
      historyStartId: state.historyId ?? state.baselineHistoryId,
    });
  }
  private async history(
    db: Database,
    client: GmailClient,
    state: State,
    revision: string,
  ) {
    if (await this.drain(db, client, state, revision, "history")) return;
    if (!state.historyPagesComplete) {
      if (!state.historyNextPageToken && !state.historyPageOffset)
        await this.labels(db, client, state.accountId, revision);
      const page = await client.history(
        state.historyStartId!,
        state.historyNextPageToken ?? undefined,
      );
      if (page.nextPageToken === state.historyNextPageToken)
        throw new GmailApiError("invalid_response");
      const ids = [
        ...new Set(
          page.history.flatMap((h) =>
            [
              ...h.messages,
              ...h.messagesAdded.map((x) => x.message),
              ...h.messagesDeleted.map((x) => x.message),
              ...h.labelsAdded.map((x) => x.message),
              ...h.labelsRemoved.map((x) => x.message),
            ].map((m) => m.id),
          ),
        ),
      ];
      // A single history record can affect more IDs than a work page. Re-read
      // that API page while draining durable fragments. A changed fingerprint
      // restarts from the fixed sweep start instead of skipping a new event.
      const digest = createHash("sha256")
        .update(JSON.stringify([page.history, page.nextPageToken ?? null]))
        .digest("hex");
      if (state.historyPageDigest && state.historyPageDigest !== digest) {
        await this.update(db, state, revision, {
          ...resetHistory,
          historyRunId: randomUUID(),
          historyStartId: state.historyStartId,
        });
        return;
      }
      const offset = state.historyPageOffset;
      const more = offset + 500 < ids.length;
      await new GmailSyncRepository(db).stagePage({
        accountId: state.accountId,
        revision: BigInt(revision),
        runId: state.historyRunId!,
        purpose: "history",
        messageIds: ids.slice(offset, offset + 500),
        expectedPageToken: state.historyNextPageToken,
        nextPageToken: more
          ? state.historyNextPageToken
          : (page.nextPageToken ?? null),
        candidateHistoryId: page.historyId,
        fragment: {
          expectedOffset: offset,
          nextOffset: offset + 500,
          digest,
          more,
        },
      });
      return;
    }
    await db.transaction(async (tx) => {
      await assertGmailPublication(tx, state.accountId, revision);
      const pending = await tx
        .select()
        .from(gmailSyncWork)
        .where(
          and(
            eq(gmailSyncWork.accountId, state.accountId),
            eq(gmailSyncWork.runId, state.historyRunId!),
            ne(gmailSyncWork.status, "complete"),
          ),
        )
        .limit(1);
      if (pending.length)
        throw new Error("Gmail history still has pending work.");
      await this.update(tx as unknown as Database, state, revision, {
        historyId: state.historyCandidateId,
        ...resetHistory,
        status: "ready",
        inventoryComplete: !state.inventoryRunId,
        errorCategory: null,
        needsWork: !!state.inventoryRunId,
        nextAttemptAt: state.inventoryRunId
          ? null
          : new Date(Date.now() + 60000),
      });
      await tx
        .delete(gmailSyncWork)
        .where(
          and(
            eq(gmailSyncWork.accountId, state.accountId),
            eq(gmailSyncWork.runId, state.historyRunId!),
          ),
        );
      await tx
        .update(mailAccounts)
        .set({ imapStatus: "success", imapError: null })
        .where(eq(mailAccounts.id, state.accountId));
      await tx
        .update(mailboxes)
        .set({
          deltaSyncStatus: "success",
          deltaSyncError: null,
          lastSuccessfulDeltaSyncAt: new Date(),
          backfillStatus: state.inventoryRunId ? "pending" : "complete",
          backfillCompletedAt: state.inventoryRunId ? null : new Date(),
        })
        .where(eq(mailboxes.accountId, state.accountId));
    });
  }
}
