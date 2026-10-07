export const sessionInactivitySeconds = 12 * 60 * 60;
export const sessionAbsoluteMs = 30 * 24 * 60 * 60 * 1_000;

type SessionLifetime = {
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  absoluteExpiresAt?: unknown;
};

// Database expiry can shorten the policy, but cannot lengthen it. The creation
// cap also protects installations with an incorrectly stored absolute deadline.
export function isSessionWithinLifetime(
  session: SessionLifetime,
  now = Date.now(),
) {
  const { createdAt, updatedAt, expiresAt, absoluteExpiresAt } = session;
  if (
    ![createdAt, updatedAt, expiresAt, absoluteExpiresAt].every(
      (value) => value instanceof Date && Number.isFinite(value.getTime()),
    ) ||
    !(absoluteExpiresAt instanceof Date)
  )
    return false;

  // Future timestamps must not buy extra lifetime, even with small clock skew.
  if (
    createdAt.getTime() > now ||
    updatedAt.getTime() > now ||
    updatedAt < createdAt
  )
    return false;

  return (
    now <
    Math.min(
      expiresAt.getTime(),
      updatedAt.getTime() + sessionInactivitySeconds * 1_000,
      absoluteExpiresAt.getTime(),
      createdAt.getTime() + sessionAbsoluteMs,
    )
  );
}
