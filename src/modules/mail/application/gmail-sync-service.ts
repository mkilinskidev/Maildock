import { randomUUID, createHash } from "node:crypto";
import type { Logger } from "pino";
import { bestEffortDiagnostic } from "../../../shared/infrastructure/logging/diagnostics";
import { and, eq, ne, or, isNull, sql, asc, inArray } from "drizzle-orm";
import type { Database } from "../../../shared/infrastructure/database/database";
import {
  gmailAccountSyncState,
  gmailSyncWork,
  mailAccounts,
  mailboxes,
  mailboxMessages,
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
import {
  GmailSyncRepository,
  GMAIL_HISTORY_PENDING_HIGH_WATER,
} from "../infrastructure/gmail-sync-repository";
import {
  projectGmailMessage,
  projectGmailBatch,
  projectGmailLabels,
} from "../infrastructure/gmail-projector";
import { MailboxRoleService } from "./mailbox-role-service";
import { classifyGmailHistory } from "../domain/gmail-history-priority";

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
  historyDrainDue: false,
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
    private readonly logger?: Pick<Logger, "debug">,
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
        bestEffortDiagnostic(() =>
          this.logger?.debug(
            {
              event: "mail.gmail_sync_state",
              accountId,
              transport: "gmail",
              phase:
                !state.baselineHistoryId ||
                state.status === "reconcile_required"
                  ? "bootstrap"
                  : state.historyRunId
                    ? "history"
                    : state.inventoryRunId
                      ? "inventory"
                      : "history_start",
              blockedReason:
                state.nextAttemptAt && state.nextAttemptAt > new Date()
                  ? state.errorCategory === "quota"
                    ? "quota"
                    : state.errorCategory
                      ? "retry"
                      : "idle_deadline"
                  : null,
              nextAttemptAt: state.nextAttemptAt?.toISOString() ?? null,
              // No existing field records a successful current-INBOX projection.
              lastSuccessfulRelevantSyncAt: null,
            },
            "Gmail synchronization state observed",
          ),
        );
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
          bestEffortDiagnostic(() =>
            this.logger?.debug(
              {
                event: "mail.gmail_sync_blocked",
                accountId,
                transport: "gmail",
                blockedReason: "pending_command",
              },
              "Gmail synchronization deferred",
            ),
          );
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
          // Existing rows predate the discovery clock. Establish a durable
          // deadline once, without promoting every legacy inventory delivery.
          if (!state.historyDiscoveredAt) {
            await this.update(db, state, revision, {
              historyDiscoveredAt: new Date(),
            });
            return;
          }
          // Use the existing history polling cadence even while one inventory
          // page takes many deliveries to drain. No extra poller is introduced.
          if (Date.now() - state.historyDiscoveredAt.getTime() >= 60000) {
            await this.update(db, state, revision, {
              ...resetHistory,
              historyRunId: randomUUID(),
              historyStartId: state.historyId ?? state.baselineHistoryId,
              needsWork: true,
            });
            return;
          }
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
        bestEffortDiagnostic(() =>
          this.logger?.debug(
            {
              event: "mail.gmail_sync_blocked",
              accountId,
              transport: "gmail",
              blockedReason: error.category === "quota" ? "quota" : "retry",
              retryAfterMs: error.retryAfterMs,
            },
            "Gmail synchronization deferred",
          ),
        );
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
      historyDiscoveredAt: new Date(),
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
    // Reserve one of the four existing requests for INBOX. Rotate the rest.
    const selected = stored
      .filter((b) => b.providerMailboxId && b.lifecycleStatus === "active")
      .sort(
        (a, b) =>
          Number(b.providerMailboxId === "INBOX") -
            Number(a.providerMailboxId === "INBOX") ||
          Number(a.reportedMessageCount !== null) -
            Number(b.reportedMessageCount !== null) ||
          a.updatedAt.getTime() - b.updatedAt.getTime(),
      )
      .slice(0, 4);
    for (const box of selected) {
      await this.counter(db, client, accountId, revision, box);
    }
    await new MailboxRoleService(db).autodetect(accountId);
  }
  private async counter(
    db: Database,
    client: GmailClient,
    accountId: string,
    revision: string,
    box: typeof mailboxes.$inferSelect,
  ) {
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
      eq(gmailSyncWork.accountRevision, BigInt(revision)),
      purpose === "history" && state.inventoryRunId
        ? or(
            and(
              eq(gmailSyncWork.runId, runId),
              eq(gmailSyncWork.purpose, "history"),
            ),
            and(
              eq(gmailSyncWork.runId, state.inventoryRunId),
              eq(gmailSyncWork.purpose, "inventory"),
            ),
          )
        : and(
            eq(gmailSyncWork.runId, runId),
            eq(gmailSyncWork.purpose, purpose),
          ),
      ne(gmailSyncWork.status, "complete"),
    );
    if (purpose === "history") {
      const [historyPending] = await db
        .select({ id: gmailSyncWork.gmailMessageId })
        .from(gmailSyncWork)
        .where(and(scope, eq(gmailSyncWork.purpose, "history")))
        .limit(1);
      if (!historyPending) return false;
    }
    const pending = await db
      .select({
        priority: gmailSyncWork.priorityClass,
        count: sql<number>`count(*)::int`,
        oldest: sql<Date>`min(${gmailSyncWork.createdAt})`,
      })
      .from(gmailSyncWork)
      .where(scope)
      .groupBy(gmailSyncWork.priorityClass);
    if (!pending.length) return false;
    const lower = pending.filter((p) => p.priority > 0);
    const due =
      state.priorityBurst >= 8 ||
      (state.priorityBurst > 0 &&
        lower.some((p) => Date.now() - new Date(p.oldest).getTime() >= 60000));
    const selected =
      due && lower.length
        ? (
            lower.find((p) => p.priority !== state.lastLowerPriority) ??
            lower[0]
          ).priority
        : Math.min(...pending.map((p) => p.priority));
    const work = await db
      .select()
      .from(gmailSyncWork)
      .where(and(scope, eq(gmailSyncWork.priorityClass, selected)))
      .orderBy(asc(gmailSyncWork.createdAt), asc(gmailSyncWork.gmailMessageId))
      .limit(12);
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
      // Each class has one purpose: history P0/P1 or inventory P2.
      const workPurpose = selected === 2 ? "inventory" : "history";
      await projectGmailBatch(db, state.accountId, revision, successful, {
        runId:
          workPurpose === "history"
            ? state.historyRunId!
            : state.inventoryRunId!,
        purpose: workPurpose,
        generation:
          workPurpose === "inventory" ? state.inventoryGeneration : undefined,
        notify: workPurpose === "history" && state.status === "ready",
      });
      const failure = responses.find((r) => r.status === "rejected");
      if (failure) throw failure.reason;
    }
    if (work.length) {
      await this.update(db, state, revision, {
        historyDrainDue: false,
        priorityBurst:
          selected === 2 || (due && selected > 0)
            ? 0
            : Math.min(8, state.priorityBurst + 1),
        ...(selected > 0 ? { lastLowerPriority: selected } : {}),
      });
      bestEffortDiagnostic(() =>
        this.logger?.debug(
          {
            event: "mail.gmail_priority_slice",
            accountId: state.accountId,
            priorityClass: `P${selected}`,
            processedItems: work.length,
            pendingByPriority: pending.map((p) => ({
              priorityClass: `P${p.priority}`,
              count: p.count,
            })),
            priorityYield: due && lower.length > 0,
            p0DiscoveryToPersistenceMs:
              selected === 0
                ? Math.max(
                    ...work.map((w) => Date.now() - w.createdAt.getTime()),
                  )
                : null,
          },
          "Gmail durable priority slice completed",
        ),
      );
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
      .select({
        id: mailboxes.id,
        providerMailboxId: mailboxes.providerMailboxId,
        unseenCount: mailboxes.reportedUnseenCount,
        lifecycleStatus: mailboxes.lifecycleStatus,
      })
      .from(mailboxes)
      .where(eq(mailboxes.accountId, state.accountId));
    if (!catalog.length) {
      await this.labels(db, client, state.accountId, revision);
      return;
    }
    // Fill unknown remote counters during backfill, before metadata can fail.
    // Keep the existing four-label bound and rotation independent of its finish.
    if (
      catalog.some(
        (box) =>
          box.providerMailboxId &&
          box.lifecycleStatus === "active" &&
          box.unseenCount === null,
      )
    )
      await this.labels(db, client, state.accountId, revision);
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
    const [highWater] =
      !state.historyPagesComplete && !state.historyDrainDue
        ? await db
            .select({ id: gmailSyncWork.gmailMessageId })
            .from(gmailSyncWork)
            .where(
              and(
                eq(gmailSyncWork.accountId, state.accountId),
                eq(gmailSyncWork.runId, state.historyRunId!),
                eq(gmailSyncWork.purpose, "history"),
                ne(gmailSyncWork.status, "complete"),
              ),
            )
            .offset(GMAIL_HISTORY_PENDING_HIGH_WATER - 1)
            .limit(1)
        : [];
    if (state.historyDrainDue || state.historyPagesComplete || highWater) {
      // Once every response page is durably staged, a new unfiltered sweep may
      // start from that discovery cursor while the applied checkpoint stays put.
      if (
        state.historyPagesComplete &&
        state.historyDiscoveredAt &&
        Date.now() - state.historyDiscoveredAt.getTime() >= 60000
      ) {
        await this.update(db, state, revision, {
          ...resetHistory,
          historyRunId: state.historyRunId,
          historyStartId: state.historyCandidateId,
        });
        return;
      }
      if (await this.drain(db, client, state, revision, "history")) return;
    }
    if (!state.historyPagesComplete) {
      const page = await client.history(
        state.historyStartId!,
        state.historyNextPageToken ?? undefined,
      );
      if (page.nextPageToken === state.historyNextPageToken)
        throw new GmailApiError("invalid_response");
      if (!state.historyNextPageToken && !state.historyPageOffset)
        await this.labels(db, client, state.accountId, revision);
      const identities = classifyGmailHistory(page.history, new Set()).map(
        (item) => item.id,
      );
      const localInbox = new Set<string>();
      // Bound SQL identity lists independently of a large history record.
      if (identities.length > state.historyPageOffset) {
        const local = await db
          .select({ id: messages.providerMessageId })
          .from(messages)
          .innerJoin(
            mailboxMessages,
            eq(mailboxMessages.messageId, messages.id),
          )
          .innerJoin(mailboxes, eq(mailboxes.id, mailboxMessages.mailboxId))
          .where(
            and(
              eq(messages.accountId, state.accountId),
              eq(mailboxes.providerMailboxId, "INBOX"),
              inArray(
                messages.providerMessageId,
                identities.slice(
                  state.historyPageOffset,
                  state.historyPageOffset + 500,
                ),
              ),
            ),
          );
        for (const item of local) if (item.id) localInbox.add(item.id);
      }
      const classified = classifyGmailHistory(page.history, localInbox);
      const ids = classified.map((item) => item.id);
      const eventHistoryIds = new Map<string, string>();
      for (const record of page.history) {
        for (const { id } of classifyGmailHistory([record], new Set())) {
          if (BigInt(record.id) > BigInt(eventHistoryIds.get(id) ?? "0"))
            eventHistoryIds.set(id, record.id);
        }
      }
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
          historyStartId: state.historyId ?? state.baselineHistoryId,
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
        priorities: new Map(
          classified.map((item) => [item.id, item.priorityClass]),
        ),
        eventHistoryIds,
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
      bestEffortDiagnostic(() =>
        this.logger?.debug(
          {
            event: "mail.gmail_history_staged",
            accountId: state.accountId,
            stagedItems: Math.min(500, ids.length - offset),
            pagesComplete: !more && !page.nextPageToken,
            fragmentOffset: offset,
            checkpointCommitted: false,
          },
          "Gmail history discovery durably staged",
        ),
      );
      return;
    }
    // Changes can arrive while durable history work is draining, including
    // commands executed between slices. Publish a fresh INBOX before checkpoint.
    if (state.historyCandidateId !== state.historyStartId) {
      const [inbox] = await db
        .select()
        .from(mailboxes)
        .where(
          and(
            eq(mailboxes.accountId, state.accountId),
            eq(mailboxes.providerMailboxId, "INBOX"),
            eq(mailboxes.lifecycleStatus, "active"),
          ),
        );
      if (inbox)
        await this.counter(db, client, state.accountId, revision, inbox);
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
    bestEffortDiagnostic(() =>
      this.logger?.debug(
        {
          event: "mail.gmail_history_checkpoint",
          accountId: state.accountId,
          historyPages: state.historyPageCount,
          checkpointCommitted: true,
          inventoryPending: !!state.inventoryRunId,
        },
        "Gmail applied history checkpoint committed",
      ),
    );
  }
}
