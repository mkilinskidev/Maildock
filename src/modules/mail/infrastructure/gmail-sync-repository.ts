import { and, eq, inArray, ne } from "drizzle-orm";
import { createHash } from "node:crypto";
import { GmailApiError } from "../../accounts/infrastructure/gmail-client";
import type { Database } from "../../../shared/infrastructure/database/database";
import {
  gmailAccountSyncState,
  gmailSyncWork,
  mailAccounts,
} from "../../../shared/infrastructure/database/schema";
import {
  assertAccountWork,
  StaleAccountWorkError,
} from "../../accounts/domain/receive-transport";

export const GMAIL_WORK_PAGE_LIMIT = 500;

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
      ids.some((id) => !id.length || id.length > 256) ||
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
      if (pending.length)
        throw new Error(
          "Drain the current Gmail page before staging the next page.",
        );
      // Completed receipts are redundant after the cursor/projection commit.
      await tx.delete(gmailSyncWork).where(scope);
      if (ids.length)
        await tx.insert(gmailSyncWork).values(
          ids.map((gmailMessageId) => ({
            accountId: input.accountId,
            accountRevision: input.revision,
            runId: input.runId,
            purpose: input.purpose,
            gmailMessageId,
          })),
        );
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
