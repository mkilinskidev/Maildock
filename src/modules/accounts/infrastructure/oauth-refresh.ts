export type { CredentialBudget } from "../domain/oauth-mail-provider";
import { receivingDiagnostic } from "../../../shared/infrastructure/logging/receiving-diagnostics";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../../../shared/infrastructure/database/database";
import { mailAccounts } from "../../../shared/infrastructure/database/schema";
import {
  OAuthAuthorizationError,
  type CredentialBudget,
} from "../domain/oauth-mail-provider";

export class OAuthRefreshNotIssuedError extends OAuthAuthorizationError {
  constructor(message: string) {
    super(message, "retry");
  }
}
export class OAuthRefreshFailure extends OAuthAuthorizationError {
  constructor(
    readonly category:
      | "rejected_grant"
      | "invalid_response"
      | "exchange_unknown"
      | "cancelled_after_issue"
      | "timeout_after_issue"
      | "cancelled_before_issue"
      | "configuration_mismatch",
    readonly issued: boolean,
  ) {
    super(
      category === "invalid_response"
        ? "Google did not return a usable access token. Reconnect the account."
        : category === "exchange_unknown"
          ? "Google token service is temporarily unavailable; renewal outcome is unknown. Reconnect the account."
          : "Account authorization is unavailable. Reconnect the account to resume synchronization safely.",
      issued ? "reconnect" : "retry",
    );
  }
}

type AccountRow = typeof mailAccounts.$inferSelect;
type ResolvedToken = {
  token: string;
  binding: string;
  expiresAt?: number;
  reused?: boolean;
};
function binding(row: AccountRow, configuration: string) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        row.id,
        row.configurationVersion.toString(),
        row.receivingLifecycleVersion.toString(),
        row.oauthCache
          ? Object.entries(row.oauthCache).sort(([a], [b]) =>
              a.localeCompare(b),
            )
          : null,
        row.imapUsername,
        row.oauthProviderId,
        configuration,
      ]),
    )
    .digest("hex");
}

export class OAuthResponseInvalidError extends OAuthAuthorizationError {}

export async function readOAuthJson(response: Response): Promise<unknown> {
  if (!response.body)
    throw new OAuthResponseInvalidError("Empty token response.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024)
        throw new OAuthResponseInvalidError("Token response exceeds limit.");
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new OAuthResponseInvalidError("Invalid token response.");
    }
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
  private readonly active = new Map<string, Promise<ResolvedToken>>();
  private readonly reusable = new Map<string, ResolvedToken>();
  constructor(
    private readonly database: Database,
    private readonly provider: string,
  ) {}

  /** Configuration failed before any claim or token request. Never revoke a grant
   * or overwrite a reconnect/retired identity for this local failure. */
  async configurationUnavailable(id: string, budget?: CredentialBudget) {
    this.reusable.delete(id);
    const lifetime = credentialLifetime(budget);
    await this.short(
      (db) =>
        db
          .update(mailAccounts)
          .set({ oauthFailureCategory: "temporary", updatedAt: new Date() })
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
          ),
      lifetime,
    );
    receivingDiagnostic({
      event: "receiving.credentials",
      operation: "oauth",
      stage: "configuration",
      category: "configuration_unavailable",
      issued: false,
      disposition: "retry",
    });
  }

  async resolve(
    id: string,
    budget: CredentialBudget | undefined,
    refresh: (
      row: typeof mailAccounts.$inferSelect,
      lifetime: ReturnType<typeof credentialLifetime>,
    ) => Promise<{
      token: string;
      cache: (typeof mailAccounts.$inferSelect)["oauthCache"];
      expiresAt?: number;
    }>,
    configuration = "",
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
        pending = this.run(id, budget, lifetime, refresh, configuration);
        this.active.set(id, pending);
        void pending
          .finally(() => this.active.delete(id))
          .catch(() => undefined);
      }
      const result = await pending;
      lifetime.check();
      if (budget?.forceRefresh && result.reused) {
        this.reusable.delete(id);
        return await this.resolve(id, budget, refresh, configuration);
      }
      // Every hit and every single-flight join checks current durable identity.
      const [current] = await this.short(
        (db) => db.select().from(mailAccounts).where(eq(mailAccounts.id, id)),
        lifetime,
      );
      if (
        !current?.enabled ||
        current.removalRequestedAt ||
        current.authMethod !== "oauth2" ||
        current.oauthProviderId !== this.provider ||
        current.oauthStatus !== "connected" ||
        current.oauthRefreshAttempt ||
        binding(current, configuration) !== result.binding ||
        (budget?.configurationVersion !== undefined &&
          current.configurationVersion !== budget.configurationVersion) ||
        (budget?.receivingLifecycleVersion !== undefined &&
          current.receivingLifecycleVersion !==
            budget.receivingLifecycleVersion) ||
        (result.expiresAt !== undefined &&
          performance.now() >= result.expiresAt)
      ) {
        this.reusable.delete(id);
        throw new OAuthAuthorizationError(
          "Account credentials changed or unavailable. Retry later or reconnect.",
        );
      }
      lifetime.check();
      return result.token;
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
    configuration: string,
  ): Promise<ResolvedToken> {
    const [snapshot] = await this.short(
      (db) => db.select().from(mailAccounts).where(eq(mailAccounts.id, id)),
      lifetime,
    );
    const cached = this.reusable.get(id);
    if (
      !budget?.forceRefresh &&
      snapshot?.enabled &&
      !snapshot.removalRequestedAt &&
      snapshot.authMethod === "oauth2" &&
      snapshot.oauthProviderId === this.provider &&
      snapshot.oauthStatus === "connected" &&
      !snapshot.oauthRefreshAttempt &&
      cached &&
      cached.binding === binding(snapshot, configuration) &&
      cached.expiresAt !== undefined &&
      performance.now() < cached.expiresAt
    )
      return { ...cached, reused: true };
    this.reusable.delete(id);
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
        snapshot?.oauthStatus === "reconnect_required" ||
          snapshot?.oauthRefreshAttempt
          ? "reconnect"
          : "retry",
      );
    const matches = and(
      eq(mailAccounts.id, id),
      eq(mailAccounts.oauthRefreshAttempt, attempt),
      eq(mailAccounts.configurationVersion, row.configurationVersion),
      eq(mailAccounts.receivingLifecycleVersion, row.receivingLifecycleVersion),
      sql`${mailAccounts.oauthCache} = ${JSON.stringify(row.oauthCache)}::jsonb`,
    );
    const started = performance.now();
    receivingDiagnostic({
      event: "oauth.refresh",
      correlation: attempt,
      stage: "start",
      category: "acquiring",
    });
    let providerEntered = false;
    try {
      lifetime.check();
      providerEntered = true;
      const result = await refresh(row, lifetime);
      lifetime.check();
      const [updated] = await this.short(
        (db) =>
          db
            .update(mailAccounts)
            .set({
              oauthCache: result.cache,
              oauthRefreshAttempt: null,
              oauthFailureCategory: null,
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
      const resolved = {
        token: result.token,
        binding: binding({ ...row, oauthCache: result.cache }, configuration),
        expiresAt: result.expiresAt,
      };
      if (
        resolved.expiresAt !== undefined &&
        performance.now() < resolved.expiresAt
      ) {
        if (this.reusable.size >= 128)
          this.reusable.delete(this.reusable.keys().next().value!);
        this.reusable.set(id, resolved);
      }
      receivingDiagnostic({
        event: "oauth.refresh",
        correlation: attempt,
        stage: "finish",
        category: "success",
        issued: this.provider === "google" ? true : undefined,
        disposition: "continue",
        elapsedMs: performance.now() - started,
      });
      return resolved;
    } catch (error) {
      // The provider may have rotated its refresh credential before a lost reply.
      // Never clear an uncertain claim or revoke a newer reconnect/grant.
      const category =
        error instanceof OAuthRefreshFailure
          ? error.category
          : error instanceof OAuthRefreshNotIssuedError
            ? "provider_rejected_without_token"
            : lifetime.signal.aborted
              ? `${lifetime.signal.reason?.name === "TimeoutError" ? "timeout" : "cancelled"}_${providerEntered ? "exchange_unknown" : "before_issue"}`
              : providerEntered
                ? "exchange_unknown"
                : "not_issued";
      const changed = await this.short((db) =>
        db
          .update(mailAccounts)
          .set(
            !providerEntered ||
              error instanceof OAuthRefreshNotIssuedError ||
              (error instanceof OAuthRefreshFailure && !error.issued)
              ? {
                  oauthRefreshAttempt: null,
                  oauthFailureCategory: "temporary",
                  updatedAt: new Date(),
                }
              : {
                  oauthStatus: "reconnect_required",
                  oauthFailureCategory: category,
                  updatedAt: new Date(),
                },
          )
          .where(matches)
          .returning({ id: mailAccounts.id }),
      );
      const retryable =
        !providerEntered ||
        error instanceof OAuthRefreshNotIssuedError ||
        (error instanceof OAuthRefreshFailure && !error.issued);
      receivingDiagnostic({
        event: "oauth.refresh",
        correlation: attempt,
        stage: "failure",
        category,
        issued:
          error instanceof OAuthRefreshFailure
            ? error.issued
            : error instanceof OAuthRefreshNotIssuedError
              ? true
              : !providerEntered
                ? false
                : undefined,
        disposition: retryable ? "retry" : "reconnect",
        elapsedMs: performance.now() - started,
      });
      if (changed.length)
        receivingDiagnostic({
          event: "receiving.account",
          correlation: attempt,
          stage: "paused",
          category: retryable ? "temporary" : "reconnect_required",
          disposition: retryable ? "retry" : "reconnect",
        });
      if (error instanceof OAuthAuthorizationError) throw error;
      throw new OAuthAuthorizationError(
        "Token renewal failed. Reconnect the account.",
      );
    }
  }
}
