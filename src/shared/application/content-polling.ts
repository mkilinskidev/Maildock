export const DEFAULT_CONTENT_POLL_INTERVAL_MS = 400;

// Poll quickly while a normal fetch completes, then ease off for slow jobs.
export function contentPollDelay(
  intervalMs: number,
  elapsedMs: number,
): number {
  const step = Math.min(5, Math.floor(Math.max(0, elapsedMs) / 5000));
  return Math.min(2500, intervalMs * 2 ** step);
}
