import { and, eq, exists, sql } from "drizzle-orm";
import type { Database } from "../../../shared/infrastructure/database/database";
import {
  instanceState,
  session,
  ownerRecovery,
  mfaReplacement,
  twoFactor,
  user,
} from "../../../shared/infrastructure/database/schema";

export async function isInstanceReady(
  database: Database,
  ownerUserId?: string,
  sessionId?: string,
) {
  // One statement observes one PostgreSQL snapshot. Do not filter/limit away
  // extra state or factor rows: corruption must fail closed, never be repaired.
  const rows = await database
    .select({
      id: instanceState.id,
      initializedAt: instanceState.initializedAt,
      ownerUserId: instanceState.ownerUserId,
      userId: user.id,
      twoFactorEnabled: user.twoFactorEnabled,
      factorId: twoFactor.id,
      factorUserId: twoFactor.userId,
      verified: twoFactor.verified,
      ceremonyAbsent: sql<boolean>`not exists (select from ${ownerRecovery}) and not exists (select from ${mfaReplacement})`,
      // Authorization also rechecks the exact session in this same snapshot.
      // An owner read that straddles atomic READY + revocation cannot authorize
      // a session already deleted by the enrollment completion transaction.
      sessionExists:
        sessionId === undefined
          ? sql<boolean>`true`
          : exists(
              database
                .select({ id: session.id })
                .from(session)
                .where(
                  and(eq(session.id, sessionId), eq(session.userId, user.id)),
                ),
            ),
    })
    .from(instanceState)
    .leftJoin(user, eq(instanceState.ownerUserId, user.id))
    .leftJoin(twoFactor, eq(user.id, twoFactor.userId));
  if (rows.length !== 1) return false;
  const state = rows[0];
  return (
    state.id === 1 &&
    state.initializedAt instanceof Date &&
    Number.isFinite(state.initializedAt.getTime()) &&
    typeof state.ownerUserId === "string" &&
    state.ownerUserId.length > 0 &&
    state.ownerUserId.trim() === state.ownerUserId &&
    state.userId === state.ownerUserId &&
    (ownerUserId === undefined || state.ownerUserId === ownerUserId) &&
    state.twoFactorEnabled === true &&
    state.factorId !== null &&
    state.factorUserId === state.ownerUserId &&
    state.verified === true &&
    state.ceremonyAbsent === true &&
    state.sessionExists === true
  );
}
