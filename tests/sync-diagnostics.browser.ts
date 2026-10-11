import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";
import { SyncDiagnosticsView } from "../src/components/sync-diagnostics-card";
import type { SyncDiagnostics } from "../src/modules/mail/domain/sync-observability";

const css = await readFile("src/app/styles.css", "utf8");
const now = Date.parse("2026-10-11T08:00:00Z");
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
  lastMaterializedAt: new Date(now - 90_000).toISOString(),
  pending: { p0: 105, p1: 4, p2: 1200, unit: "items" },
  quota: [{ scope: "user_minute", used: 2792, ceiling: 2800 }],
  refusal: {
    at: new Date(now).toISOString(),
    category: "quota",
    source: "gmail_http",
    status: 403,
    reasons: ["rateLimitExceeded"],
    retryAfter: null,
    retryAfterMs: 0,
    deadline: new Date(now + 30_000).toISOString(),
    budget: null,
  },
  events: [
    {
      at: new Date(now).toISOString(),
      kind: "backoff_entered",
      phase: "inbox",
      priority: 0,
    },
    {
      at: new Date(now - 60_000).toISOString(),
      kind: "completed",
      phase: "history_discovery",
      priority: 0,
    },
    {
      at: new Date(now - 90_000).toISOString(),
      kind: "materialized",
      phase: "inbox",
      priority: 0,
      newMessages: 7,
      readChanges: 3,
    },
  ],
};
const browser = await chromium.launch({ headless: true });
try {
  await mkdir(".security-results/sync-diagnostics", { recursive: true });
  for (const theme of ["light", "dark"])
    for (const width of [1200, 390]) {
      const page = await browser.newPage({
        viewport: { width, height: 1100 },
        colorScheme: theme as "light" | "dark",
      });
      await page.route("**/*", (route) => route.abort());
      const html = renderToStaticMarkup(
        createElement(SyncDiagnosticsView, {
          name: "Personal Gmail",
          email: "owner@example.test",
          diagnostics: d,
          now,
        }),
      );
      await page.setContent(
        `<html data-theme="${theme}"><head><style>${css}</style></head><body><main style="max-width:800px;margin:24px auto;padding:12px">${html}</main></body></html>`,
      );
      assert.equal(await page.locator(".sync-health").textContent(), "Waiting");
      assert.equal(
        await page
          .locator(".sync-diagnostics-grid")
          .evaluate(
            (e) => getComputedStyle(e).gridTemplateColumns.split(" ").length,
          ),
        width === 390 ? 1 : 2,
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        true,
      );
      assert.equal(await page.locator("details[open]").count(), 0);
      assert.equal(
        await page.getByText("Gmail rate limit reached.").isVisible(),
        true,
      );
      assert.equal(
        await page
          .locator(".sync-diagnostics-card")
          .evaluate((e) => getComputedStyle(e).backgroundColor),
        theme === "light" ? "rgb(255, 255, 255)" : "rgb(27, 31, 39)",
      );
      await page.screenshot({
        path: `.security-results/sync-diagnostics/${theme}-${width}.png`,
        fullPage: true,
      });
      await page.locator(".sync-technical summary").click();
      assert.equal(
        await page.getByText("Last recorded refusal (historical)").isVisible(),
        true,
      );
      await page.close();
    }
  console.log(
    "PASS: diagnostics card in light/dark themes at 1200px and 390px; responsive grid, overflow, collapsed technical metadata and quota state verified.",
  );
} finally {
  await browser.close();
}
