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
  it.each([false, true])(
    "keeps the optimistic count after immediately switching mailboxes (server projected=%s)",
    async (projected) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      Object.defineProperty(HTMLElement.prototype, "scrollTo", {
        configurable: true,
        value: vi.fn(),
      });
      let acknowledged = false;
      const inboxView = {
        ...inbox,
        ...(projected ? { countsIncludePendingActions: true } : {}),
      };
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);
          if (
            url.endsWith(`/messages/${messageId}/actions`) &&
            init?.method === "POST"
          ) {
            acknowledged = true;
            return Response.json(
              { id: "00000000-0000-4000-8000-000000000005" },
              { status: 202 },
            );
          }
          if (url.endsWith(`/messages/${messageId}`))
            return Response.json(detail);
          if (url.includes("/messages?pageSize=50"))
            return Response.json({
              items: url.includes(inboxId) ? [message] : [],
              nextCursor: null,
            });
          if (url.endsWith("/mailboxes"))
            return Response.json({
              mailboxes: [
                {
                  ...inboxView,
                  unseenCount: projected && acknowledged ? "4" : "5",
                },
                other,
              ],
              roles: [],
            });
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
            mailboxesByAccount={{ [accountId]: [inboxView, other] }}
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
    },
  );
  it.each([
    ["reconnect_required", false, false],
    ["temporary", false, false],
    ["reconnect_required", true, false],
    ["reconnect_required", false, true],
  ] as const)(
    "shows actionable %s and stops pending-content polling (recovery=%s, cached=%s)",
    async (state, recover, cached) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      Object.defineProperty(HTMLElement.prototype, "scrollTo", {
        configurable: true,
        value: vi.fn(),
      });
      const statusMessage =
        state === "temporary"
          ? "Authorization is temporarily unavailable."
          : "Reconnect this account to resume synchronization safely.";
      let detailRequests = 0;
      let recovered = false;
      const fetcher = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith(`/messages/${messageId}`)) {
          detailRequests++;
          if (recovered)
            return Response.json({
              ...detail,
              seen: true,
              credentialAvailability: null,
            });
          return Response.json({
            ...detail,
            seen: true,
            credentialAvailability: {
              state,
              message: statusMessage,
              settingsPath: "/accounts",
            },
            content: cached
              ? detail.content
              : { ...detail.content, status: "pending", plainText: null },
          });
        }
        if (url.includes("/messages?pageSize=50"))
          return Response.json({
            items: [{ ...message, seen: true }],
            nextCursor: null,
          });
        if (url.endsWith("/mailboxes"))
          return Response.json({
            mailboxes: [inbox],
            roles: [],
            credentialAvailability: recovered
              ? null
              : { state, message: statusMessage, settingsPath: "/accounts" },
          });
        throw new Error("Unexpected fixture request");
      });
      vi.stubGlobal("fetch", fetcher);
      const host = document.createElement("div");
      document.body.append(host);
      root = createRoot(host);
      await act(async () =>
        root!.render(
          <MailClient
            initialNotification={{ accountId, mailboxId: inboxId }}
            accounts={[account]}
            mailboxesByAccount={{ [accountId]: [inbox] }}
            rolesByAccount={{ [accountId]: [] }}
          />,
        ),
      );
      await act(async () =>
        (host.querySelector(".mail-list-row") as HTMLButtonElement).click(),
      );
      expect(host.textContent).toContain(statusMessage);
      if (cached) expect(host.textContent).toContain("Body");
      expect(host.textContent).not.toContain("Downloading message content");
      expect(
        host.querySelector(".mail-content-failure a")?.getAttribute("href"),
      ).toBe("/accounts");
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 700));
      });
      expect(detailRequests).toBe(1);
      expect(
        fetcher.mock.calls.some(([url]) => String(url).endsWith("/content")),
      ).toBe(false);
      if (recover) {
        recovered = true;
        await act(async () =>
          document.dispatchEvent(new Event("visibilitychange")),
        );
        expect(detailRequests).toBe(2);
        expect(host.textContent).toContain("Body");
        expect(host.textContent).not.toContain(statusMessage);
      }
    },
  );
});
