export type { CredentialBudget } from "../domain/oauth-mail-provider";
import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../../../shared/infrastructure/database/database";
import { mailAccounts } from "../../../shared/infrastructure/database/schema";
import {
  OAuthAuthorizationError,
  type CredentialBudget,
} from "../domain/oauth-mail-provider";

export class OAuthRefreshNotIssuedError extends OAuthAuthorizationError {}

export async function readOAuthJson(response: Response): Promise<unknown> {
  if (!response.body)
    throw new OAuthAuthorizationError("Empty token response.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024)
        throw new OAuthAuthorizationError("Token response exceeds limit.");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export function credentialLifetime(input?: CredentialBudget) {
  const deadline = Math.min(
    input?.deadline ?? Infinity,
    performance.now() + 10_000,
  );
  const signal = AbortSignal.any([
    AbortSignal.timeout(Math.max(0, Math.ceil(deadline - performance.now()))),
    ...(input?.signal ? [input.signal] : []),
  ]);
  const check = () => {
    if (signal.aborted || performance.now() >= deadline)
      throw new OAuthAuthorizationError(
        "Credential resolution cancelled or expired.",
      );
  };
  check();
  return { deadline, signal, check };
}

/** Network work owns an in-memory allocation until actual settlement, even if a
 * library ignores cancellation. SQL claims prevent cross-process grant replay;
 * a crashed/uncertain refresh requires reconnect rather than rotating twice. */
export class OAuthRefreshes {
  private callers = 0;
  private readonly active = new Map<string, Promise<string>>();
  constructor(
    private readonly database: Database,
    private readonly provider: string,
  ) {}

  async resolve(
    id: string,
    budget: CredentialBudget | undefined,
    refresh: (
      row: typeof mailAccounts.$inferSelect,
      lifetime: ReturnType<typeof credentialLifetime>,
    ) => Promise<{
      token: string;
      cache: (typeof mailAccounts.$inferSelect)["oauthCache"];
    }>,
  ): Promise<string> {
    if (this.callers >= 128)
      throw new OAuthAuthorizationError("Credential resolver busy. Try again.");
    this.callers++;
    try {
      const lifetime = credentialLifetime(budget);
      let pending = this.active.get(id);
      if (!pending) {
        if (this.active.size >= 128)
          throw new OAuthAuthorizationError(
            "Credential resolver busy. Try again.",
          );
        pending = this.run(id, budget, lifetime, refresh);
        this.active.set(id, pending);
        void pending
          .finally(() => this.active.delete(id))
          .catch(() => undefined);
      }
      const token = await pending;
      lifetime.check();
      // Joining a different captured configuration never inherits its credentials.
      if (budget?.configurationVersion !== undefined) {
        const [current] = await this.short(
          (db) => db.select().from(mailAccounts).where(eq(mailAccounts.id, id)),
          lifetime,
        );
        if (
          !current?.enabled ||
          current.configurationVersion !== budget.configurationVersion ||
          (budget.receivingLifecycleVersion !== undefined &&
            current.receivingLifecycleVersion !==
              budget.receivingLifecycleVersion)
        )
          throw new OAuthAuthorizationError(
            "Account credentials changed. Try again.",
          );
      }
      return token;
    } finally {
      this.callers--;
    }
  }

  /** Ordinary application-pool SQL only; no external work enters this callback.
   * A late pool acquisition checks revocation before issuing credential writes. */
  private short<T>(
    work: (db: Pick<Database, "select" | "update">) => PromiseLike<T>,
    lifetime?: ReturnType<typeof credentialLifetime>,
  ): Promise<T> {
    return this.database.transaction(async (tx) => {
      const deadline = Math.min(
        lifetime?.deadline ?? Infinity,
        performance.now() + 2000,
      );
      const check = () => {
        lifetime?.check();
        if (performance.now() >= deadline)
          throw new OAuthAuthorizationError(
            "Credential database deadline expired.",
          );
      };
      check();
      await tx.execute(sql`select set_config('statement_timeout',${String(Math.max(1, Math.floor(deadline - performance.now())))},true),
        set_config('lock_timeout','1000',true),set_config('idle_in_transaction_session_timeout','2000',true)`);
      check();
      const result = await work(tx);
      check();
      return result;
    });
  }

  private async run(
    id: string,
    budget: CredentialBudget | undefined,
    lifetime: ReturnType<typeof credentialLifetime>,
    refresh: Parameters<OAuthRefreshes["resolve"]>[2],
  ) {
    const attempt = randomUUID();
    const [row] = await this.short(
      (db) =>
        db
          .update(mailAccounts)
          .set({ oauthRefreshAttempt: attempt })
          .where(
            and(
              eq(mailAccounts.id, id),
              eq(mailAccounts.enabled, true),
              isNull(mailAccounts.removalRequestedAt),
              eq(mailAccounts.authMethod, "oauth2"),
              eq(mailAccounts.oauthProviderId, this.provider),
              eq(mailAccounts.oauthStatus, "connected"),
              isNull(mailAccounts.oauthRefreshAttempt),
              ...(budget?.configurationVersion !== undefined
                ? [
                    eq(
                      mailAccounts.configurationVersion,
                      budget.configurationVersion,
                    ),
                  ]
                : []),
              ...(budget?.receivingLifecycleVersion !== undefined
                ? [
                    eq(
                      mailAccounts.receivingLifecycleVersion,
                      budget.receivingLifecycleVersion,
                    ),
                  ]
                : []),
            ),
          )
          .returning(),
      lifetime,
    );
    if (!row?.oauthCache)
      throw new OAuthAuthorizationError(
        "Credentials unavailable or refresh uncertain. Retry later or reconnect the account.",
      );
    const matches = and(
      eq(mailAccounts.id, id),
      eq(mailAccounts.oauthRefreshAttempt, attempt),
      eq(mailAccounts.configurationVersion, row.configurationVersion),
      eq(mailAccounts.receivingLifecycleVersion, row.receivingLifecycleVersion),
      sql`${mailAccounts.oauthCache} = ${JSON.stringify(row.oauthCache)}::jsonb`,
    );
    try {
      lifetime.check();
      const result = await refresh(row, lifetime);
      lifetime.check();
      const [updated] = await this.short(
        (db) =>
          db
            .update(mailAccounts)
            .set({
              oauthCache: result.cache,
              oauthRefreshAttempt: null,
              updatedAt: new Date(),
            })
            .where(
              and(
                matches,
                eq(mailAccounts.enabled, true),
                isNull(mailAccounts.removalRequestedAt),
              ),
            )
            .returning({ id: mailAccounts.id }),
        lifetime,
      );
      lifetime.check();
      if (!updated)
        throw new OAuthAuthorizationError(
          "Account credentials changed. Try again.",
        );
      return result.token;
    } catch (error) {
      // The provider may have rotated its refresh credential before a lost reply.
      // Never clear an uncertain claim or revoke a newer reconnect/grant.
      await this.short((db) =>
        db
          .update(mailAccounts)
          .set(
            error instanceof OAuthRefreshNotIssuedError
              ? { oauthRefreshAttempt: null }
              : { oauthStatus: "reconnect_required", updatedAt: new Date() },
          )
          .where(matches),
      );
      if (error instanceof OAuthAuthorizationError) throw error;
      throw new OAuthAuthorizationError(
        "Token renewal failed. Reconnect the account.",
      );
    }
  }
}
