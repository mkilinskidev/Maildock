import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  currentSyncStatus,
  gmailNeedsAttention,
  type SyncDiagnostics,
} from "@/modules/mail/domain/sync-observability";
import { SyncObservationStore } from "@/modules/mail/infrastructure/sync-observation-store";
import { SyncDiagnosticsView } from "@/components/sync-diagnostics-card";

const now = Date.parse("2026-10-11T08:00:00Z");
const input = {
  now,
  enabled: true,
  executing: false,
  queued: false,
  lastCheckAt: new Date(now - 25_000).toISOString(),
  dueAt: new Date(now + 35_000).toISOString(),
  deadline: null,
  errorCategory: null,
  lockHeld: false,
  persistentError: false,
  intervalMs: 60_000,
};
describe("current INBOX diagnostic accuracy", () => {
  it("does not turn a historical quota error into an active block or attention", () => {
    expect(
      currentSyncStatus({
        ...input,
        errorCategory: "quota",
        deadline: new Date(now - 1).toISOString(),
      }),
    ).toMatchObject({
      health: "Up to date",
      freshness: "current",
      worker: "waiting_eligibility",
    });
    expect(
      gmailNeedsAttention(
        "ready",
        "quota",
        new Date(now + 30_000).toISOString(),
        now,
      ),
    ).toBe(false);
    expect(
      gmailNeedsAttention(
        "ready",
        "network",
        new Date(now - 1).toISOString(),
        now,
      ),
    ).toBe(false);
    expect(gmailNeedsAttention("blocked", "authentication", null, now)).toBe(
      true,
    );
  });
  it("shows backoff even when the last check was recent", () => {
    expect(
      currentSyncStatus({
        ...input,
        errorCategory: "quota",
        deadline: new Date(now + 30_000).toISOString(),
      }),
    ).toMatchObject({ health: "Waiting", worker: "rate_limited" });
  });
  it("separates executing, admission, lock evidence and unknown waiting", () => {
    const due = { ...input, dueAt: new Date(now - 1).toISOString() };
    expect(currentSyncStatus({ ...due, executing: true })).toMatchObject({
      health: "Synchronizing",
      worker: "executing",
    });
    expect(currentSyncStatus({ ...due, queued: true })).toMatchObject({
      reason: "Waiting for worker admission.",
    });
    expect(currentSyncStatus({ ...due, lockHeld: true })).toMatchObject({
      reason: "Another account operation holds the lock.",
    });
    expect(currentSyncStatus(due).reason).toContain("has not been observed");
    expect(
      currentSyncStatus({ ...due, commandPending: true }).reason,
    ).toContain("pending mail action");
  });
  it("does not present old success as current freshness", () => {
    expect(
      currentSyncStatus({
        ...input,
        lastCheckAt: new Date(now - 90_000).toISOString(),
        dueAt: null,
      }),
    ).toMatchObject({ health: "Waiting", freshness: "overdue" });
    expect(currentSyncStatus({ ...input, lastCheckAt: null })).toMatchObject({
      freshness: "unknown",
    });
  });
  it("uses queue retry evidence instead of inventing a normal poll delay", () => {
    expect(
      currentSyncStatus({
        ...input,
        queued: true,
        deadline: new Date(now + 30_000).toISOString(),
        retryQueued: true,
      }).reason,
    ).toContain("retry eligibility");
    expect(currentSyncStatus({ ...input, queued: true }).worker).toBe("queued");
  });
  it("does not let diagnostic persistence or invalid metadata fail mail work", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("unavailable"));
    const store = new SyncObservationStore(execute, "account", "1");
    await expect(store.start("inbox", 0)).resolves.toBeUndefined();
    await expect(
      store.record("materialized", { count: -1 }),
    ).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("allowlists events and hides a quota countdown and raw technical payload", () => {
    const d: SyncDiagnostics = {
      sampledAt: new Date(now).toISOString(),
      health: "Waiting",
      freshness: "overdue",
      phase: "retry",
      priority: null,
      worker: "rate_limited",
      reason: "Waiting for quota.",
      lastCheckAt: new Date(now - 90_000).toISOString(),
      nextCheckAt: new Date(now + 30_000).toISOString(),
      nextEligibleAt: new Date(now + 30_000).toISOString(),
      quotaBackoffUntil: new Date(now + 30_000).toISOString(),
      lastMaterializedAt: null,
      pending: { p0: 5, p1: 2, p2: 100, unit: "items" },
      refusal: null,
      quota: [],
      events: [],
    };
    const html = renderToStaticMarkup(
      createElement(SyncDiagnosticsView, {
        name: "Google",
        email: "owner@test.invalid",
        diagnostics: d,
        now,
      }),
    );
    expect(html).toContain("Waiting for quota");
    expect(html).toContain("INBOX check is overdue");
    expect(html).toContain("Technical details</summary>");
    expect(html).not.toContain("<details open");
    expect(html).not.toContain("Up to date");
  });
});
