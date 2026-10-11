import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { GmailApiError } from "../../accounts/infrastructure/gmail-client";
import type { Database } from "../../../shared/infrastructure/database/database";
import {
  gmailAccountSyncState,
  gmailSyncWork,
  mailAccounts,
  messages,
} from "../../../shared/infrastructure/database/schema";
import {
  assertAccountWork,
  StaleAccountWorkError,
} from "../../accounts/domain/receive-transport";

export const GMAIL_WORK_PAGE_LIMIT = 500;
// Leave room for one complete fragment below the 5,000 pending-item ceiling.
export const GMAIL_HISTORY_PENDING_HIGH_WATER = 4500;

/** Durable bounded page intake, shared by future inventory/history orchestrators.
 * No remote requests or queue ACKs participate in the authority transaction. */
export class GmailSyncRepository {
  constructor(private readonly db: Database) {}

  async blockUnsupported(accountId: string, revision: bigint) {
    await this.db.transaction(async (tx) => {
      const [account] = await tx
        .select()
        .from(mailAccounts)
        .where(eq(mailAccounts.id, accountId))
        .for("share");
      if (
        !account ||
        assertAccountWork(account, revision.toString()) !== "gmail"
      )
        throw new StaleAccountWorkError();
      await tx
        .insert(gmailAccountSyncState)
        .values({
          accountId,
          accountRevision: revision,
          status: "blocked",
          errorCategory: "unsupported",
          needsWork: false,
        })
        .onConflictDoUpdate({
          target: gmailAccountSyncState.accountId,
          set: {
            accountRevision: revision,
            status: "blocked",
            errorCategory: "unsupported",
            needsWork: false,
            updatedAt: new Date(),
          },
        });
    });
  }

  async stagePage(input: {
    accountId: string;
    revision: bigint;
    runId: string;
    purpose: "inventory" | "history";
    messageIds: readonly string[];
    priorities?: ReadonlyMap<string, number>;
    eventHistoryIds?: ReadonlyMap<string, string>;
    expectedPageToken: string | null;
    nextPageToken: string | null;
    candidateHistoryId?: string;
    fragment?: {
      expectedOffset: number;
      nextOffset: number;
      digest: string;
      more: boolean;
    };
  }) {
    const ids = [...new Set(input.messageIds)];
    if (
      input.messageIds.length > GMAIL_WORK_PAGE_LIMIT ||
      ids.some(
        (id) =>
          !id.length ||
          id.length > 256 ||
          (input.priorities?.has(id) &&
            ![0, 1].includes(input.priorities.get(id)!)),
      ) ||
      ids.some(
        (id) =>
          input.eventHistoryIds?.has(id) &&
          !/^[0-9]+$/.test(input.eventHistoryIds.get(id)!),
      ) ||
      (input.candidateHistoryId !== undefined &&
        !/^[0-9]+$/.test(input.candidateHistoryId))
    )
      throw new Error("Invalid or oversized Gmail work page.");
    await this.db.transaction(async (tx) => {
      const [account] = await tx
        .select()
        .from(mailAccounts)
        .where(eq(mailAccounts.id, input.accountId))
        .for("share");
      if (
        !account ||
        assertAccountWork(account, input.revision.toString()) !== "gmail"
      )
        throw new StaleAccountWorkError();
      const [state] = await tx
        .select()
        .from(gmailAccountSyncState)
        .where(eq(gmailAccountSyncState.accountId, input.accountId))
        .for("update");
      const inventory = input.purpose === "inventory";
      if (
        !state ||
        state.accountRevision !== input.revision ||
        (inventory ? state.inventoryRunId : state.historyRunId) !==
          input.runId ||
        (inventory
          ? state.inventoryNextPageToken
          : state.historyNextPageToken) !== input.expectedPageToken ||
        (inventory
          ? state.inventoryPagesComplete
          : state.historyPagesComplete) ||
        (!inventory &&
          (state.historyPageOffset !== (input.fragment?.expectedOffset ?? 0) ||
            (state.historyPageDigest &&
              state.historyPageDigest !== input.fragment?.digest)))
      )
        throw new StaleAccountWorkError();
      const scope = and(
        eq(gmailSyncWork.accountId, input.accountId),
        eq(gmailSyncWork.runId, input.runId),
        eq(gmailSyncWork.purpose, input.purpose),
      );
      const trail = inventory
        ? state.inventoryTokenTrail
        : state.historyTokenTrail;
      const count = inventory
        ? state.inventoryPageCount
        : state.historyPageCount;
      const hash = input.nextPageToken
        ? createHash("sha256").update(input.nextPageToken).digest("hex")
        : null;
      if (
        !input.fragment?.more &&
        (count >= 100000 || (hash && trail.includes(hash)))
      )
        throw new GmailApiError("invalid_response");
      const pending = await tx
        .select({ id: gmailSyncWork.gmailMessageId })
        .from(gmailSyncWork)
        .where(and(scope, ne(gmailSyncWork.status, "complete")))
        .limit(1);
      if (inventory && pending.length)
        throw new Error(
          "Drain the current Gmail page before staging the next page.",
        );
      // Completed receipts are redundant after the cursor/projection commit.
      if (inventory) await tx.delete(gmailSyncWork).where(scope);
      else
        await tx.execute(sql`delete from public.gmail_sync_work where ctid in (
        select ctid from public.gmail_sync_work where account_id=${input.accountId}::uuid
          and run_id=${input.runId}::uuid and purpose='history' and status='complete' limit 500
      )`);
      const observed =
        !inventory && ids.length && input.eventHistoryIds
          ? await tx
              .select({
                id: messages.providerMessageId,
                historyId: messages.providerHistoryId,
                missing: messages.remoteMissingAt,
              })
              .from(messages)
              .where(
                and(
                  eq(messages.accountId, input.accountId),
                  inArray(messages.providerMessageId, ids),
                ),
              )
          : [];
      const covered = new Set(
        observed
          .filter(
            (m) =>
              m.id &&
              m.historyId &&
              !m.missing &&
              input.eventHistoryIds?.has(m.id) &&
              BigInt(m.historyId) >= BigInt(input.eventHistoryIds.get(m.id)!),
          )
          .map((m) => m.id),
      );
      if (ids.length)
        await tx
          .insert(gmailSyncWork)
          .values(
            ids.map((gmailMessageId) => ({
              accountId: input.accountId,
              accountRevision: input.revision,
              runId: input.runId,
              purpose: input.purpose,
              gmailMessageId,
              status: covered.has(gmailMessageId) ? "complete" : "pending",
              priorityClass: inventory
                ? 2
                : (input.priorities?.get(gmailMessageId) ?? 0),
            })),
          )
          .onConflictDoUpdate({
            target: [
              gmailSyncWork.accountId,
              gmailSyncWork.runId,
              gmailSyncWork.purpose,
              gmailSyncWork.gmailMessageId,
            ],
            set: {
              // A later event may invalidate a completed observation. Keep the
              // strongest relevance and earliest discovery time until checkpoint.
              status: sql`excluded.status`,
              priorityClass: sql`least(${gmailSyncWork.priorityClass}, excluded.priority_class)`,
              updatedAt: new Date(),
            },
          });
      const complete = !input.fragment?.more && input.nextPageToken === null;
      if (!inventory && complete && input.candidateHistoryId === undefined)
        throw new Error(
          "Final Gmail history page requires its response history ID.",
        );
      await tx
        .update(gmailAccountSyncState)
        .set(
          inventory
            ? {
                inventoryNextPageToken: input.nextPageToken,
                inventoryPagesComplete: complete,
                inventoryPageCount: count + 1,
                inventoryTokenTrail: hash ? [...trail, hash].slice(-32) : trail,
                needsWork: true,
                updatedAt: new Date(),
              }
            : {
                historyNextPageToken: input.nextPageToken,
                historyPagesComplete: complete,
                historyPageCount: count + (input.fragment?.more ? 0 : 1),
                historyTokenTrail:
                  !input.fragment?.more && hash
                    ? [...trail, hash].slice(-32)
                    : trail,
                historyPageOffset: input.fragment?.more
                  ? input.fragment.nextOffset
                  : 0,
                historyPageDigest: input.fragment?.more
                  ? input.fragment.digest
                  : null,
                historyCandidateId: complete ? input.candidateHistoryId! : null,
                historyDrainDue: true,
                historyDiscoveredAt: new Date(),
                needsWork: true,
                updatedAt: new Date(),
              },
        )
        .where(eq(gmailAccountSyncState.accountId, input.accountId));
    });
  }

  /** Completion must be called inside the same projection transaction in P2/P3. */
  async completeItems(
    tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
    input: {
      accountId: string;
      revision: bigint;
      runId: string;
      purpose: "inventory" | "history";
      messageIds: readonly string[];
    },
  ) {
    if (input.messageIds.length > GMAIL_WORK_PAGE_LIMIT)
      throw new Error("Oversized Gmail completion batch.");
    if (!input.messageIds.length) return;
    const [account] = await tx
      .select()
      .from(mailAccounts)
      .where(eq(mailAccounts.id, input.accountId))
      .for("share");
    if (
      !account ||
      assertAccountWork(account, input.revision.toString()) !== "gmail"
    )
      throw new StaleAccountWorkError();
    const [state] = await tx
      .select()
      .from(gmailAccountSyncState)
      .where(eq(gmailAccountSyncState.accountId, input.accountId))
      .for("update");
    if (
      !state ||
      state.accountRevision !== input.revision ||
      (input.purpose === "inventory"
        ? state.inventoryRunId
        : state.historyRunId) !== input.runId
    )
      throw new StaleAccountWorkError();
    await tx
      .update(gmailSyncWork)
      .set({ status: "complete", updatedAt: new Date() })
      .where(
        and(
          eq(gmailSyncWork.accountId, input.accountId),
          eq(gmailSyncWork.accountRevision, input.revision),
          eq(gmailSyncWork.runId, input.runId),
          eq(gmailSyncWork.purpose, input.purpose),
          inArray(gmailSyncWork.gmailMessageId, [...input.messageIds]),
        ),
      );
  }
}
