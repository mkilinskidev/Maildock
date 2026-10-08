import { securityEvent } from "../../../shared/infrastructure/logging/security-events";
import { ownerPasswordSchema } from "../domain/password-policy";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import {
  normalizeOwnerUsername,
  ownerUsernameSchema,
} from "@/modules/auth/domain/owner-username";

import {
  argon2idParameters,
  hashPassword,
} from "@/modules/auth/infrastructure/password";
import type { Database } from "@/shared/infrastructure/database/database";
import {
  account,
  instanceState,
  user,
} from "@/shared/infrastructure/database/schema";

const ownerCredentialsSchema = z.object({
  username: z.string().trim().pipe(ownerUsernameSchema),
  password: ownerPasswordSchema,
});

export class BootstrapAuthorizationError extends Error {}
export class SetupThrottledError extends Error {}

// Reuse Better Auth's storage with separate global keys. Reserve attempts atomically
// before work starts; a fixed window survives web-process restarts.
export async function reserveSetupAttempt(
  database: Database,
  authorized: boolean,
  purpose: "setup" | "initial-mfa" = "setup",
) {
  const key = authorized
    ? `maildock:${purpose}:authorized`
    : `maildock:${purpose}:invalid`;
  const max = authorized ? 5 : 30;
  const now = sql`floor(extract(epoch from clock_timestamp()) * 1000)::bigint`;
  const rows = await database.execute<{ count: number }>(sql`
    insert into rate_limit (id, key, count, last_request)
    values (${key}, ${key}, 1, ${now})
    on conflict (key) do update set
      count = case when rate_limit.last_request <= excluded.last_request - 60000 then 1
        else least(rate_limit.count + 1, ${max + 1}) end,
      last_request = case when rate_limit.last_request <= excluded.last_request - 60000
        then excluded.last_request else rate_limit.last_request end
    returning count
  `);
  if (rows[0].count > max) {
    securityEvent("admission_rejected");
    throw new SetupThrottledError();
  }
}

export async function authorizeBootstrap(
  database: Database,
  supplied: unknown,
  purpose: "setup" | "initial-mfa" = "setup",
) {
  const [state] = await database
    .select({
      digest: instanceState.bootstrapSecretDigest,
      active: sql<boolean>`${instanceState.bootstrapExpiresAt} > clock_timestamp()`,
      initializedAt: instanceState.initializedAt,
      ownerUserId: instanceState.ownerUserId,
    })
    .from(instanceState)
    .where(eq(instanceState.id, 1))
    .limit(1);
  const digest = createHash("sha256")
    .update(
      typeof supplied === "string" && supplied.length <= 44 ? supplied : "",
    )
    .digest();
  if (
    !state ||
    (purpose === "setup"
      ? state.initializedAt !== null ||
        state.ownerUserId !== null ||
        !state.active
      : state.initializedAt === null || state.ownerUserId === null) ||
    !state.digest ||
    !/^[0-9a-f]{64}$/.test(state.digest) ||
    !timingSafeEqual(digest, Buffer.from(state.digest, "hex"))
  ) {
    await reserveSetupAttempt(database, false);
    securityEvent("proof_rejected");
    throw new BootstrapAuthorizationError();
  }
}

export class InstanceAlreadyInitializedError extends Error {
  constructor() {
    super("This Maildock instance is already initialized.");
    this.name = "InstanceAlreadyInitializedError";
  }
}

export async function isInstanceInitialized(
  database: Pick<Database, "select">,
): Promise<boolean> {
  const [state] = await database
    .select({
      initializedAt: instanceState.initializedAt,
      ownerUserId: instanceState.ownerUserId,
    })
    .from(instanceState)
    .where(eq(instanceState.id, 1))
    .limit(1);
  // Corrupt or partially provisioned instances must never become claimable.
  if (!state || state.initializedAt !== null || state.ownerUserId !== null)
    return true;
  const users = await database.select({ id: user.id }).from(user).limit(1);
  return users.length > 0;
}

export async function initializeOwner(
  database: Database,
  input: unknown,
): Promise<void> {
  if (await isInstanceInitialized(database))
    throw new InstanceAlreadyInitializedError();
  const supplied =
    input && typeof input === "object" && "bootstrapSecret" in input
      ? input.bootstrapSecret
      : undefined;
  await authorizeBootstrap(database, supplied);
  // Zod strips the bootstrap field. Only credentials cross into owner creation.
  const parsed = ownerCredentialsSchema.parse(input);
  return createOwner(database, parsed, supplied);
}

// Private: every caller must pass through initializeOwner's provisioning boundary.
async function createOwner(
  database: Database,
  parsed: z.infer<typeof ownerCredentialsSchema>,
  supplied: unknown,
): Promise<void> {
  const normalizedUsername = normalizeOwnerUsername(parsed.username);
  await reserveSetupAttempt(database, true);

  await database.transaction(async (transaction) => {
    // Nonblocking, PostgreSQL-wide admission: at most one setup Argon2 job,
    // including across processes. Transaction exit/crash releases the lock.
    const locks = await transaction.execute<{ acquired: boolean }>(
      sql`select pg_try_advisory_xact_lock(1296125003) as acquired`,
    );
    if (!locks[0].acquired) throw new SetupThrottledError();
    if (await isInstanceInitialized(transaction))
      throw new InstanceAlreadyInitializedError();
    const passwordHash = await hashPassword(parsed.password);

    const [state] = await transaction
      .select({
        initializedAt: instanceState.initializedAt,
        ownerUserId: instanceState.ownerUserId,
      })
      .from(instanceState)
      .where(eq(instanceState.id, 1))
      .for("update")
      .limit(1);

    if (!state || state.initializedAt !== null || state.ownerUserId !== null) {
      throw new InstanceAlreadyInitializedError();
    }

    const existingUsers = await transaction
      .select({ id: user.id })
      .from(user)
      .limit(1);
    if (existingUsers.length > 0) {
      throw new InstanceAlreadyInitializedError();
    }
    // Startup rotation uses the same row lock. A proof checked before hashing
    // cannot provision an owner after another process has replaced it.
    await authorizeBootstrap(transaction as unknown as Database, supplied);

    const now = new Date();
    const userId = randomUUID();
    await transaction.insert(user).values({
      id: userId,
      name: parsed.username,
      email: "owner@localhost.invalid",
      emailVerified: true,
      username: normalizedUsername,
      displayUsername: parsed.username,
      createdAt: now,
      updatedAt: now,
    });
    await transaction.insert(account).values({
      id: randomUUID(),
      accountId: userId,
      providerId: "credential",
      userId,
      password: passwordHash,
      createdAt: now,
      updatedAt: now,
    });
    const initialized = await transaction
      .update(instanceState)
      .set({
        initializedAt: now,
        ownerUserId: userId,
        bootstrapExpiresAt: null,
        updatedAt: now,
        passwordAlgorithm: "argon2id",
        passwordParameters: {
          memoryCost: argon2idParameters.memoryCost,
          timeCost: argon2idParameters.timeCost,
          parallelism: argon2idParameters.parallelism,
          outputLen: argon2idParameters.outputLen,
        },
      })
      .where(
        and(
          eq(instanceState.id, 1),
          isNull(instanceState.initializedAt),
          isNull(instanceState.ownerUserId),
        ),
      )
      .returning({ id: instanceState.id });
    if (initialized.length !== 1) throw new InstanceAlreadyInitializedError();
  });
  securityEvent("setup_completed");
}
