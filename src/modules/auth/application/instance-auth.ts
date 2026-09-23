import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

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

export const setupInputSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3)
    .max(64)
    .regex(
      /^[a-zA-Z0-9_.-]+$/,
      "Use letters, numbers, dots, underscores, or hyphens.",
    ),
  password: z.string().min(12).max(128),
});

export class InstanceAlreadyInitializedError extends Error {
  constructor() {
    super("This Maildock instance is already initialized.");
    this.name = "InstanceAlreadyInitializedError";
  }
}

export async function isInstanceInitialized(
  database: Database,
): Promise<boolean> {
  const [state] = await database
    .select({ initializedAt: instanceState.initializedAt })
    .from(instanceState)
    .where(eq(instanceState.id, 1))
    .limit(1);
  return state?.initializedAt !== null && state?.initializedAt !== undefined;
}

export async function initializeOwner(
  database: Database,
  input: z.infer<typeof setupInputSchema>,
): Promise<void> {
  const parsed = setupInputSchema.parse(input);
  const normalizedUsername = parsed.username.toLowerCase();
  const passwordHash = await hashPassword(parsed.password);

  await database.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(1296125003)`);

    const [state] = await transaction
      .select({ initializedAt: instanceState.initializedAt })
      .from(instanceState)
      .where(eq(instanceState.id, 1))
      .for("update")
      .limit(1);

    if (!state || state.initializedAt) {
      throw new InstanceAlreadyInitializedError();
    }

    const existingOwners = await transaction
      .select({ id: user.id })
      .from(user)
      .where(
        and(
          eq(user.email, "owner@localhost.invalid"),
          eq(user.username, normalizedUsername),
        ),
      )
      .limit(1);
    if (existingOwners.length > 0) {
      throw new InstanceAlreadyInitializedError();
    }

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
    await transaction
      .update(instanceState)
      .set({
        initializedAt: now,
        updatedAt: now,
        passwordAlgorithm: "argon2id",
        passwordParameters: {
          memoryCost: argon2idParameters.memoryCost,
          timeCost: argon2idParameters.timeCost,
          parallelism: argon2idParameters.parallelism,
          outputLen: argon2idParameters.outputLen,
        },
      })
      .where(eq(instanceState.id, 1));
  });
}
