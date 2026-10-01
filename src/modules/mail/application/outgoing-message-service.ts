import { randomUUID } from "node:crypto";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import type { Database } from "../../../shared/infrastructure/database/database";
import {
  mailAccounts,
  outgoingMessages,
} from "../../../shared/infrastructure/database/schema";
import type { AccountsService } from "../../accounts/application/accounts-service";
import type {
  MailProvider,
  SmtpDeliveryResult,
} from "../../accounts/domain/mail-provider";
import {
  composeInput,
  parseOutgoingAddresses,
  UNCERTAIN_SEND,
} from "../domain/outgoing-message";
import { buildOutgoingMime } from "../infrastructure/outgoing-mime";
import type { OutgoingLock } from "../infrastructure/outgoing-lock";

export class OutgoingValidationError extends Error {}
export class OutgoingMessageService {
  constructor(
    private readonly db: Database,
    private readonly enqueue: (id: string) => Promise<void>,
    private readonly accounts?: AccountsService,
    private readonly provider?: MailProvider,
    private readonly lock?: OutgoingLock,
    private readonly enqueueSentCopy?: (id: string) => Promise<void>,
  ) {}

  async create(input: unknown) {
    let values;
    try {
      const parsed = composeInput.parse(input);
      values = {
        ...parsed,
        to: parseOutgoingAddresses(parsed.to),
        cc: parseOutgoingAddresses(parsed.cc),
        bcc: parseOutgoingAddresses(parsed.bcc),
      };
      const count = values.to.length + values.cc.length + values.bcc.length;
      if (count < 1 || count > 100) throw Error();
    } catch {
      throw new OutgoingValidationError(
        "Check the recipients, subject and message size. At least one valid recipient is required.",
      );
    }
    const id = randomUUID();
    const createdAt = new Date();
    const messageId = `<${randomUUID()}@maildock.invalid>`;
    await this.db.transaction(async (tx) => {
      const [account] = await tx
        .select()
        .from(mailAccounts)
        .where(eq(mailAccounts.id, values.accountId))
        .for("share");
      if (
        !account?.enabled ||
        !account.smtpHost ||
        (account.authMethod === "oauth2" && account.oauthStatus !== "connected")
      )
        throw new OutgoingValidationError(
          "Select an enabled, configured sending account.",
        );
      let from;
      let mime: Buffer;
      try {
        const addresses = parseOutgoingAddresses(account.email);
        if (
          addresses.length !== 1 ||
          /[\x00-\x1f\x7f]/.test(account.displayName) ||
          account.displayName.length > 200
        )
          throw Error();
        from = { address: addresses[0].address, name: account.displayName };
        mime = await buildOutgoingMime({
          ...values,
          from,
          messageId,
          createdAt,
        });
      } catch {
        throw new OutgoingValidationError(
          "The sending identity is invalid or the message is too large.",
        );
      }
      await tx.insert(outgoingMessages).values({
        ...values,
        id,
        from,
        messageId,
        createdAt,
        mimeBase64: mime.toString("base64"),
        status: "queued",
        sentCopyPolicy: account.sentCopyPolicy,
      });
    });
    // The row is the source of truth; a queue outage leaves a repairable message.
    await this.enqueue(id).catch(() => undefined);
    return { id, status: "queued" };
  }

  async status(id: string) {
    const [row] = await this.db
      .select({
        id: outgoingMessages.id,
        accountId: outgoingMessages.accountId,
        status: outgoingMessages.status,
        error: outgoingMessages.error,
        smtpAcceptedAt: outgoingMessages.smtpAcceptedAt,
        rejectedCount: outgoingMessages.rejectedCount,
        sentCopyStatus: outgoingMessages.sentCopyStatus,
        sentCopyError: outgoingMessages.sentCopyError,
      })
      .from(outgoingMessages)
      .where(eq(outgoingMessages.id, id));
    return row ?? null;
  }

  async repair() {
    if (!this.lock) throw Error("Outgoing lock is required.");
    const rows = await this.db
      .select({ id: outgoingMessages.id, status: outgoingMessages.status })
      .from(outgoingMessages)
      .where(
        and(
          inArray(outgoingMessages.status, ["queued", "sending"]),
          lte(outgoingMessages.nextAttemptAt, sql`now()`),
        ),
      )
      .limit(100);
    for (const row of rows) {
      if (row.status === "sending")
        await this.lock(row.id, (db) => this.recoverSending(row.id, db));
      else await this.enqueue(row.id).catch(() => undefined);
    }
  }

  private async recoverSending(id: string, db: Database) {
    await db
      .update(outgoingMessages)
      .set({
        status: "uncertain",
        error: UNCERTAIN_SEND,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(outgoingMessages.id, id),
          eq(outgoingMessages.status, "sending"),
        ),
      );
  }

  async run(id: string) {
    if (!this.lock || !this.accounts || !this.provider?.deliverMessage)
      throw Error("Outgoing worker dependencies are required.");
    // Credential resolution (including OAuth refresh) uses the account service's
    // pool. Do it before reserving the outgoing lock connection to avoid pool
    // starvation, even with a one-connection pool. No SMTP happens here.
    const [candidate] = await this.db
      .select()
      .from(outgoingMessages)
      .where(eq(outgoingMessages.id, id));
    if (!candidate || !["queued", "sending"].includes(candidate.status)) return;
    let account:
      | Awaited<ReturnType<AccountsService["getProviderSmtpAccountForWork"]>>
      | undefined;
    let accountFailed = false;
    if (candidate.status === "queued") {
      try {
        account = await this.accounts.getProviderSmtpAccountForWork(
          candidate.accountId,
        );
      } catch {
        accountFailed = true;
      }
    }
    await this.lock(id, async (db) => {
      const [row] = await db
        .select()
        .from(outgoingMessages)
        .where(eq(outgoingMessages.id, id));
      if (!row) return;
      if (row.status === "sending") {
        await this.recoverSending(id, db);
        return;
      }
      if (row.status !== "queued") return;
      // Account authority is rechecked immediately before the durable claim.
      const [currentAccount] = await db
        .select()
        .from(mailAccounts)
        .where(eq(mailAccounts.id, row.accountId));
      if (
        accountFailed ||
        !currentAccount?.enabled ||
        !currentAccount.smtpHost ||
        (currentAccount.authMethod === "oauth2" &&
          currentAccount.oauthStatus !== "connected")
      ) {
        await db
          .update(outgoingMessages)
          .set({
            status: "failed",
            error:
              "The sending account is disabled or its credentials are unavailable.",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(outgoingMessages.id, id),
              eq(outgoingMessages.status, "queued"),
            ),
          );
        return;
      }
      if (!account) return; // Another attempt just returned to queued; poll again.
      const [claimed] = await db
        .update(outgoingMessages)
        .set({
          status: "sending",
          attempts: sql`${outgoingMessages.attempts} + 1`,
          startedAt: new Date(),
          updatedAt: new Date(),
          error: null,
        })
        .where(
          and(
            eq(outgoingMessages.id, id),
            eq(outgoingMessages.status, "queued"),
            lte(outgoingMessages.nextAttemptAt, sql`now()`),
          ),
        )
        .returning();
      if (!claimed) return;
      // Autocommit above finishes before any network delivery. Any subsequent
      // exception/crash leaves sending, which recovery never resubmits.
      let result: SmtpDeliveryResult;
      try {
        result = await this.provider!.deliverMessage!(
          account,
          {
            from: row.from.address,
            to: [
              ...new Set(
                [...row.to, ...row.cc, ...row.bcc].map(
                  (address) => address.address,
                ),
              ),
            ],
          },
          Buffer.from(row.mimeBase64, "base64"),
        );
      } catch {
        result = { outcome: "uncertain" };
      }
      const now = new Date();
      const update =
        result.outcome === "accepted"
          ? {
              status: "sent",
              sentCopyStatus:
                row.sentCopyPolicy === "maildock" ? "pending" : "not_required",
              smtpAcceptedAt: now,
              acceptedCount: result.acceptedCount,
              rejectedCount: result.rejectedCount,
              error: result.rejectedCount
                ? "Message sent, but some recipients were rejected by SMTP."
                : null,
            }
          : result.outcome === "uncertain"
            ? { status: "uncertain", error: UNCERTAIN_SEND }
            : {
                status:
                  result.retryable && claimed.attempts < 3
                    ? "queued"
                    : "failed",
                error: result.message,
                nextAttemptAt: sql`now() + ${claimed.attempts * 30} * interval '1 second'`,
              };
      await db
        .update(outgoingMessages)
        .set({ ...update, updatedAt: now })
        .where(
          and(
            eq(outgoingMessages.id, id),
            eq(outgoingMessages.status, "sending"),
          ),
        );
      if (result.outcome === "accepted" && row.sentCopyPolicy === "maildock")
        await this.enqueueSentCopy?.(id).catch(() => undefined);
    });
  }
}
