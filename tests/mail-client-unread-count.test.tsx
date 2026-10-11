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
  it("keeps the committed count while switching mailboxes before a new snapshot", async () => {
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
    ).toBe("5");
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
    ).toBe("5");
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
        return Response.json({
          items: [],
          nextCursor: null,
          publication: {
            revision: count,
            boxes: { [accountId]: boxes(), second: [secondInbox] },
            roles: {},
            enabledAccountIds: [accountId, "second"],
            allInboxesUnread: String(Number(count) + 3),
            coverage: {},
          },
        });
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
    "publishes committed %s once while remote command completion is pending",
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
            items: [{ ...message, seen: changed ? !seen : seen }],
            nextCursor: null,
            publication: {
              revision: String(changed),
              boxes: {
                [accountId]: [
                  { ...inbox, unseenCount: String(2 + (changed ? delta : 0)) },
                ],
              },
              roles: {},
              enabledAccountIds: [accountId],
              allInboxesUnread: String(2 + (changed ? delta : 0)),
              coverage: {},
              reader: input.includes("readerId")
                ? {
                    id: messageId,
                    seen: changed ? !seen : seen,
                    flagged: false,
                  }
                : undefined,
            },
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
  it("applies a pending publication's badge, rows and ready-reader flags together", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let seen = false;
    let release: ((response: Response) => void) | undefined;
    const snapshot = (input: string) => ({
      items: [{ ...message, seen }],
      nextCursor: null,
      publication: {
        revision: String(seen),
        boxes: {
          [accountId]: [
            {
              ...inbox,
              unseenCount: seen ? "0" : "1",
              remoteUnseenCount: "99",
            },
          ],
        },
        roles: {},
        allInboxesUnread: seen ? "0" : "1",
        enabledAccountIds: [accountId],
        coverage: {},
        reader: input.includes("readerId")
          ? { id: messageId, seen, flagged: false }
          : undefined,
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        if (input.endsWith(`/messages/${messageId}`))
          return Response.json(detail);
        if (seen)
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        return Response.json(snapshot(input));
      }),
    );
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () =>
      root!.render(
        <MailClient
          initialAutoRead={{ mode: "manually", seconds: 2 }}
          accounts={[account]}
          initialNotification={{ accountId, mailboxId: inboxId }}
          mailboxesByAccount={{ [accountId]: [inbox] }}
          rolesByAccount={{ [accountId]: [] }}
        />,
      ),
    );
    await act(async () =>
      (host.querySelector(".mail-list-row") as HTMLButtonElement).click(),
    );
    expect(host.querySelector('[aria-label="Mark read"]')).not.toBeNull();
    seen = true;
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(
      host.querySelector('[title="INBOX"] .folder-count')?.textContent,
    ).toBe("1");
    expect(host.querySelector(".mail-list-row.unread")).not.toBeNull();
    await act(async () => release!(Response.json(snapshot("readerId"))));
    expect(host.querySelector('[title="INBOX"] .folder-count')).toBeNull();
    expect(host.querySelector(".mail-list-row.unread")).toBeNull();
    expect(host.querySelector('[aria-label="Mark unread"]')).not.toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(vi.mocked(fetch).mock.calls.at(-1)?.[0]).toContain("revision=true");
  });
  it("invalidates pagination from a different publication instead of retaining stale tail rows", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let intersect!: IntersectionObserverCallback;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          intersect = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    let revision = "first";
    const snapshot = (items: (typeof message)[]) => ({
      items,
      nextCursor: revision === "first" ? "older" : null,
      publication: {
        revision,
        boxes: { [accountId]: [{ ...inbox, unseenCount: "1" }] },
        roles: {},
        allInboxesUnread: "1",
        enabledAccountIds: [accountId],
        coverage: {},
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        if (input.includes("cursor=")) {
          revision = "changed";
          return Response.json(
            snapshot([{ ...message, id: "stale-tail", subject: "Stale tail" }]),
          );
        }
        return Response.json(
          snapshot([
            {
              ...message,
              subject: revision === "first" ? "Initial" : "Current",
            },
          ]),
        );
      }),
    );
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () =>
      root!.render(
        <MailClient
          accounts={[account]}
          initialNotification={{ accountId, mailboxId: inboxId }}
          mailboxesByAccount={{ [accountId]: [inbox] }}
          rolesByAccount={{ [accountId]: [] }}
        />,
      ),
    );
    await act(async () =>
      intersect(
        [{ isIntersecting: true }] as IntersectionObserverEntry[],
        {} as IntersectionObserver,
      ),
    );
    expect(host.textContent).toContain("Current");
    expect(host.textContent).not.toContain("Stale tail");
    expect(host.querySelectorAll(".mail-list-row")).toHaveLength(1);
  });
  it("rejects a late snapshot after a mailbox switch", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let release!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        if (input.includes(inboxId))
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        return Response.json({
          items: [],
          nextCursor: null,
          publication: {
            revision: "other",
            boxes: { [accountId]: [inbox, other] },
            roles: {},
            allInboxesUnread: "5",
            enabledAccountIds: [accountId],
            coverage: {},
          },
        });
      }),
    );
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () =>
      root!.render(
        <MailClient
          accounts={[account]}
          initialNotification={{ accountId, mailboxId: inboxId }}
          mailboxesByAccount={{ [accountId]: [inbox, other] }}
          rolesByAccount={{ [accountId]: [] }}
        />,
      ),
    );
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((b) => b.textContent === "Other folders")!
        .click(),
    );
    await act(async () =>
      (host.querySelector('[title="Other"]') as HTMLButtonElement).click(),
    );
    await act(async () =>
      release(
        Response.json({
          items: [message],
          nextCursor: null,
          publication: {
            revision: "stale",
            boxes: { [accountId]: [{ ...inbox, unseenCount: "99" }, other] },
            roles: {},
            allInboxesUnread: "99",
            enabledAccountIds: [accountId],
            coverage: {},
          },
        }),
      ),
    );
    expect(host.querySelector("h1")?.textContent).toBe("Other");
    expect(host.querySelector(".mail-list-row")).toBeNull();
    expect(
      host.querySelector('[title="INBOX"] .folder-count')?.textContent,
    ).toBe("5");
  });
});
