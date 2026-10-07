// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ApplicationLogs } from "@/components/application-logs";
let root: Root;
let host: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
async function mount(events: unknown[] = []) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const fetcher = vi.fn<(url: string) => Promise<Response>>(async () =>
    Response.json({ events, nextCursor: null }),
  );
  vi.stubGlobal("fetch", fetcher);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <ApplicationLogs
        accounts={[{ id: "account-a", displayName: "Hotmail" }]}
        initialAccountId="account-a"
      />,
    ),
  );
  return fetcher;
}
it("shows an empty state with the related account selected and bounded loading", async () => {
  const fetcher = await mount();
  expect(host.textContent).toContain("No diagnostic events yet.");
  expect(fetcher.mock.calls[0][0]).toContain("accountId=account-a");
  expect(fetcher.mock.calls[0][0]).toContain("limit=50");
});
it("renders human events with expandable safe technical details and filters", async () => {
  const fetcher = await mount([
    {
      id: "event-a",
      createdAt: "2026-10-05T09:42:00Z",
      level: "error",
      area: "sync",
      event: "mail.sync_failed",
      message: "Mailbox synchronization failed",
      accountName: "Hotmail",
      accountId: "account-a",
      mailboxId: "box-a",
      mailboxPath: "INBOX",
      details: { category: "authentication_rejected" },
    },
  ]);
  expect(host.textContent).toContain("Mailbox synchronization failed");
  expect(host.textContent).toContain("stored credentials");
  expect(host.querySelector("details")?.open).toBe(false);
  await act(async () => host.querySelector("summary")!.click());
  expect(host.querySelector("details")?.open).toBe(true);
  expect(host.querySelector("summary")?.textContent).toBe("Technical details");
  const level = host.querySelector("select")!;
  await act(async () => {
    level.value = "error";
    level.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(fetcher.mock.calls.at(-1)![0]).toContain("level=error");
});
