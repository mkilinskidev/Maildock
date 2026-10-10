// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MailClient } from "@/components/mail-client";
import type { MailAccountView } from "@/modules/accounts/application/accounts-service";
import type { MailboxView } from "@/modules/mail/application/mailbox-service";

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));
vi.mock("@/components/theme-control", () => ({ ThemeControl: () => null }));
vi.mock("@/components/logout-button", () => ({ LogoutButton: () => null }));

const accountId = "00000000-0000-4000-8000-000000000001";
const inboxId = "00000000-0000-4000-8000-000000000002";
const otherId = "00000000-0000-4000-8000-000000000003";
const messageId = "00000000-0000-4000-8000-000000000004";
const account = {
  id: accountId,
  displayName: "Account",
  email: "a@example.test",
  enabled: true,
  mailboxDiscovery: { capabilities: ["MOVE"] },
} as unknown as MailAccountView;
function mailbox(id: string, name: string, count: string): MailboxView {
  return {
    id,
    name,
    remotePath: name === "Inbox" ? "INBOX" : name,
    selectable: true,
    lifecycleStatus: "active",
    specialUse: [],
    unseenCount: count,
    synchronizedMessageCount: "1",
    deltaSync: { lastSuccessfulAt: null },
  } as unknown as MailboxView;
}
const inbox = mailbox(inboxId, "Inbox", "5");
const other = mailbox(otherId, "Other", "2");
const message = {
  id: messageId,
  subject: "Subject",
  from: [{ address: "sender@example.test" }],
  date: "2026-01-01T00:00:00.000Z",
  seen: false,
  flagged: false,
  size: "1",
  hasAttachments: false,
};
const detail = {
  ...message,
  sentAt: null,
  to: [],
  cc: [],
  replyTo: [],
  attachments: [],
  content: {
    status: "ready",
    plainText: "Body",
    sanitizedHtml: null,
    remoteContentBlocked: false,
    error: null,
  },
};

describe("sidebar unread count", () => {
  let root: Root | undefined;
  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  it("keeps the optimistic count after immediately switching mailboxes", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (
          url.endsWith(`/messages/${messageId}/actions`) &&
          init?.method === "POST"
        )
          return Response.json(
            { id: "00000000-0000-4000-8000-000000000005" },
            { status: 202 },
          );
        if (url.endsWith(`/messages/${messageId}`))
          return Response.json(detail);
        if (url.includes("/messages?pageSize=50"))
          return Response.json({
            items: url.includes(inboxId) ? [message] : [],
            nextCursor: null,
          });
        if (url.endsWith("/mailboxes"))
          return Response.json({ mailboxes: [inbox, other], roles: [] });
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <MailClient
          initialNotification={{ accountId, mailboxId: inboxId }}
          accounts={[account]}
          mailboxesByAccount={{ [accountId]: [inbox, other] }}
          rolesByAccount={{ [accountId]: [] }}
        />,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      (host.querySelector(".mail-list-row") as HTMLButtonElement).click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      (
        host.querySelector('[aria-label="Mark read"]') as HTMLButtonElement
      ).click();
    });
    expect(
      host.querySelector(`[title="INBOX"] .folder-count`)?.textContent,
    ).toBe("4");
    await act(async () => {
      const disclosure = [...host.querySelectorAll("button")].find(
        (b) => b.textContent === "Other folders",
      )!;
      disclosure.click();
    });
    await act(async () => {
      (host.querySelector('[title="Other"]') as HTMLButtonElement).click();
    });
    expect(
      host.querySelector(`[title="INBOX"] .folder-count`)?.textContent,
    ).toBe("4");
  });
  it("refreshes external Gmail INBOX changes and All Inboxes without counting labels or disabled accounts", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const google = { ...account, receiveTransport: "gmail" as const };
    const disabled = { ...account, id: "disabled", enabled: false };
    const second = { ...account, id: "second" };
    const secondInbox = mailbox("second-inbox", "Inbox", "3");
    let count = "2";
    const boxes = () => [
      {
        ...inbox,
        unseenCount: count,
        unseenCountObservedAt: new Date().toISOString(),
      },
      { ...other, unseenCount: "40" },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        if (input.includes("/second/"))
          return Response.json({ mailboxes: [secondInbox], roles: [] });
        if (input.includes("/disabled/"))
          return Response.json({
            mailboxes: [mailbox("disabled-inbox", "Inbox", "100")],
            roles: [],
          });
        if (input.endsWith("/mailboxes"))
          return Response.json({ mailboxes: boxes(), roles: [] });
        return Response.json({ items: [], nextCursor: null });
      }),
    );
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () =>
      root!.render(
        <MailClient
          accounts={[google, second, disabled]}
          initialNotification={{ accountId, mailboxId: inboxId }}
          mailboxesByAccount={{
            [accountId]: boxes(),
            second: [secondInbox],
            disabled: [mailbox("disabled-inbox", "Inbox", "100")],
          }}
          rolesByAccount={{ [accountId]: [], second: [], disabled: [] }}
        />,
      ),
    );
    const allCount = () =>
      [...host.querySelectorAll("button")]
        .find((button) => button.textContent?.startsWith("All Inboxes"))
        ?.querySelector(".folder-count")?.textContent;
    expect(allCount()).toBe("5");
    count = "0";
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(
      host.querySelector('[title="INBOX"]')?.querySelector(".folder-count"),
    ).toBeNull();
    expect(allCount()).toBe("3");
  });
  it.each(["mark_read", "mark_unread"] as const)(
    "keeps %s optimistic while command status and remote counters arrive in different orders",
    async (action) => {
      vi.useFakeTimers();
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const google = { ...account, receiveTransport: "gmail" as const };
      const seen = action === "mark_unread";
      const commandId = "00000000-0000-4000-8000-000000000005";
      const before = new Date(Date.now() - 1000).toISOString();
      let changed = false;
      let settled = false;
      const delta = seen ? 1 : -1;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string, init?: RequestInit) => {
          if (input.endsWith("/actions") && init?.method === "POST") {
            changed = true;
            return Response.json({ id: commandId }, { status: 202 });
          }
          if (input.includes("/message-commands?"))
            return Response.json({
              commands: [
                {
                  id: commandId,
                  status: settled ? "succeeded" : "pending",
                  error: null,
                  completedAt: settled ? before : null,
                },
              ],
            });
          if (input.endsWith(`/messages/${messageId}`))
            return Response.json({ ...detail, seen });
          if (input.endsWith("/mailboxes"))
            return Response.json({
              mailboxes: [
                {
                  ...inbox,
                  unseenCount: String(2 + (changed ? delta : 0)),
                  unseenCountObservedAt: changed
                    ? new Date().toISOString()
                    : before,
                },
              ],
              roles: [],
            });
          return Response.json({
            items: [{ ...message, seen }],
            nextCursor: null,
          });
        }),
      );
      const host = document.createElement("div");
      document.body.append(host);
      root = createRoot(host);
      await act(async () =>
        root!.render(
          <MailClient
            accounts={[google]}
            initialNotification={{ accountId, mailboxId: inboxId }}
            mailboxesByAccount={{
              [accountId]: [
                { ...inbox, unseenCount: "2", unseenCountObservedAt: before },
              ],
            }}
            rolesByAccount={{ [accountId]: [] }}
          />,
        ),
      );
      await act(async () =>
        (host.querySelector(".mail-list-row") as HTMLButtonElement).click(),
      );
      await act(async () =>
        (
          host.querySelector(
            `[aria-label="${seen ? "Mark unread" : "Mark read"}"]`,
          ) as HTMLButtonElement
        ).click(),
      );
      const count = () =>
        host.querySelector('[title="INBOX"] .folder-count')?.textContent;
      expect(count()).toBe(String(2 + delta));
      await act(async () => vi.advanceTimersByTimeAsync(10_000));
      expect(count()).toBe(String(2 + delta));
      settled = true;
      await act(async () => vi.advanceTimersByTimeAsync(3000));
      expect(count()).toBe(String(2 + delta));
    },
  );
});
