// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MailClient } from "@/components/mail-client";
import { ConversationViewSettings } from "@/components/conversation-view-settings";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import type { MailAccountView } from "@/modules/accounts/application/accounts-service";
import type { MailboxView } from "@/modules/mail/application/mailbox-service";
import type { MailboxRoleView } from "@/modules/mail/application/mailbox-role-service";

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
const ancestorId = "00000000-0000-4000-8000-000000000005";
const conversationId = "00000000-0000-4000-8000-000000000006";
const sentOnlyId = "00000000-0000-4000-8000-000000000007";
const account = {
  id: accountId,
  displayName: "Account",
  email: "a@example.test",
  enabled: true,
  smtp: { host: "smtp.example.com" },
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
const other = mailbox(otherId, "Sent", "2");
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

describe("reader reply and forward actions", () => {
  let root: Root | undefined;
  let host: HTMLDivElement;
  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  async function render(
    prepare: (mode: string) => Promise<Response>,
    grouped = false,
    extraMessage = false,
    autoSelect = true,
  ) {
    let enabled = grouped;
    const roles = grouped
      ? (["archive", "trash"].map((role) => ({
          role,
          mailboxId: inboxId,
          available: true,
        })) as MailboxRoleView[])
      : [];
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/settings/conversation-view")) {
        enabled = (JSON.parse(String(init?.body)) as { enabled: boolean })
          .enabled;
        return Response.json({ enabled });
      }
      if (url.includes(`/conversations/${conversationId}`))
        return Response.json({
          items: [
            {
              ...message,
              id: ancestorId,
              from: [{ address: "a@example.test" }],
              seen: true,
              mailboxId: otherId,
              date: "2025-12-31T00:00:00Z",
              to: [{ address: "owner@example.test" }],
              cc: [],
              contentStatus: "ready",
              plainText: "Earlier body",
            },
            {
              ...message,
              mailboxId: inboxId,
              to: [],
              cc: [],
              contentStatus: "ready",
              plainText: "Body",
            },
          ],
        });
      if (url.endsWith(`/messages/${ancestorId}`))
        return Response.json({
          ...detail,
          id: ancestorId,
          seen: true,
          plainText: undefined,
          content: { ...detail.content, plainText: "Earlier body" },
        });
      if (url.endsWith("/actions")) return Response.json({ id: "command" });
      if (url.includes("/prepare?mode=")) {
        expect(init?.method).toBe("POST");
        return prepare(url.split("mode=")[1]);
      }
      if (url.endsWith(`/messages/${messageId}`)) return Response.json(detail);
      if (url.includes("/messages?pageSize=50"))
        return Response.json({
          items: [
            enabled
              ? {
                  ...message,
                  subject: "Re: Re: Subject",
                  conversationId,
                  messageCount: 1,
                  conversationMessageCount: 2,
                }
              : message,
            ...(extraMessage ? [{ ...message, id: ancestorId }] : []),
            ...(enabled && url.includes(`/mailboxes/${otherId}/messages?`)
              ? [
                  {
                    ...message,
                    id: sentOnlyId,
                    conversationId: sentOnlyId,
                    subject: "Sent-only conversation",
                    messageCount: 1,
                    conversationMessageCount: 1,
                  },
                ]
              : []),
          ],
          nextCursor: null,
        });
      if (url.endsWith("/mailboxes"))
        return Response.json({ mailboxes: [inbox, other], roles });
      throw Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () =>
      root!.render(
        <MailClient
          initialAutoRead={{ mode: "manually", seconds: 2 }}
          initialConversationView={grouped}
          accounts={[account]}
          mailboxesByAccount={{ [accountId]: [inbox, other] }}
          rolesByAccount={{ [accountId]: roles }}
        />,
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    if (autoSelect) {
      if (grouped) {
        await act(async () =>
          (
            host.querySelector(
              ".conversation-group-header",
            ) as HTMLButtonElement
          ).click(),
        );
      }
      await act(async () => {
        const rows = host.querySelectorAll<HTMLButtonElement>(".mail-list-row");
        rows[grouped ? rows.length - 1 : 0].click();
      });
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return fetch;
  }
  it("classic view selects only the clicked message row", async () => {
    await render(async (mode) => ready(mode), false, true);
    expect(host.querySelectorAll(".mail-list-row")).toHaveLength(2);
    expect(host.querySelectorAll(".mail-list-row.selected")).toHaveLength(1);
    expect(host.querySelector(".flat-message-list")).not.toBeNull();
    expect(host.querySelector(".conversation-message-list")).toBeNull();
  });
  it("conversation headers only expand/collapse in the middle pane, with chronological children and one reader", async () => {
    const fetch = await render(async (mode) => ready(mode), true, false, false);
    const middle = host.querySelector(".mail-list-pane")!;
    const reader = host.querySelector(".mail-detail-pane")!;
    const header = middle.querySelector<HTMLButtonElement>(
      ".conversation-group-header",
    )!;
    expect(middle.querySelector(".flat-message-list")).toBeNull();
    expect(header.querySelector(".conversation-subject")!.textContent).toBe(
      "Subject",
    );
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(middle.querySelectorAll(".conversation-child")).toHaveLength(0);
    expect(reader.textContent).toContain("Select a message");
    await act(async () => header.click());
    expect(header.getAttribute("aria-expanded")).toBe("true");
    const children = middle.querySelectorAll<HTMLButtonElement>(
      ".conversation-child",
    );
    expect(children).toHaveLength(2);
    expect(
      [...children].map((child) =>
        child.querySelector("time")!.getAttribute("datetime"),
      ),
    ).toEqual(["2025-12-31T00:00:00Z", message.date]);
    expect(children[0].classList.contains("unread")).toBe(false);
    expect(children[1].classList.contains("unread")).toBe(true);
    expect(reader.querySelector(".mail-body")).toBeNull();
    expect(
      fetch.mock.calls
        .filter(([url]) => String(url).includes("/conversations/"))
        .every(([url]) => String(url).includes("metadataOnly=true")),
    ).toBe(true);
    await act(async () => children[0].click());
    expect(children[0].classList.contains("selected")).toBe(true);
    expect(children[0].getAttribute("aria-current")).toBe("true");
    expect(reader.querySelectorAll(".mail-body")).toHaveLength(1);
    expect(reader.textContent).toContain("Earlier body");
    expect(reader.querySelector(".conversation-message-list")).toBeNull();
    expect(reader.querySelector(".conversation-history")).toBeNull();
    expect(reader.textContent).not.toContain("Open message and actions");
    expect(reader.textContent).not.toContain("Selected");
    await act(async () => header.click());
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(middle.querySelectorAll(".conversation-child")).toHaveLength(0);
    expect(reader.textContent).toContain("Earlier body");
  });
  it("Inbox expands to include Sent messages while Sent-only groups appear only in Sent", async () => {
    const fetch = await render(async (mode) => ready(mode), true);
    expect(host.querySelectorAll(".conversation-group-header")).toHaveLength(1);
    expect(host.querySelector(".mail-list-pane")!.textContent).not.toContain(
      "Sent-only conversation",
    );
    const sentChild = host.querySelector<HTMLButtonElement>(
      ".conversation-child",
    )!;
    expect(sentChild.textContent).toContain("a@example.test");
    await act(async () => sentChild.click());
    expect(
      fetch.mock.calls.some(([url]) =>
        String(url).endsWith(`/mailboxes/${otherId}/messages/${ancestorId}`),
      ),
    ).toBe(true);
    await act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>(".mail-folders button")]
        .find((button) => button.textContent === "Other folders")!
        .click(),
    );
    await act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>(".mail-folders button")]
        .find(
          (button) =>
            button.querySelector(".folder-name")?.textContent === "Sent",
        )!
        .click(),
    );
    expect(host.querySelectorAll(".conversation-group-header")).toHaveLength(2);
    expect(host.querySelector(".mail-list-pane")!.textContent).toContain(
      "Sent-only conversation",
    );
  });
  it("switching the presentation swaps list components without requesting a rethread or losing the single reader", async () => {
    const fetch = await render(async (mode) => ready(mode), true);
    await act(async () =>
      globalThis.fetch("/api/settings/conversation-view", {
        method: "PUT",
        body: JSON.stringify({ enabled: false }),
      }),
    );
    await act(async () =>
      root!.render(
        <MailClient
          initialAutoRead={{ mode: "manually", seconds: 2 }}
          initialConversationView={false}
          accounts={[account]}
          mailboxesByAccount={{ [accountId]: [inbox, other] }}
          rolesByAccount={{ [accountId]: [] }}
        />,
      ),
    );
    expect(host.querySelector(".flat-message-list")).not.toBeNull();
    expect(host.querySelector(".conversation-message-list")).toBeNull();
    expect(host.querySelectorAll(".mail-detail-pane")).toHaveLength(1);
    expect(
      fetch.mock.calls.filter(
        ([url, init]) =>
          init?.method === "POST" && !String(url).includes("/prepare"),
      ),
    ).toHaveLength(0);
  });
  it.each([
    ["Mark unread", "mark_unread"],
    ["Flag", "flag"],
    ["Archive", "archive"],
    ["Move to Trash", "trash"],
  ])(
    "conversation %s acts only on the selected Sent child",
    async (label, action) => {
      const fetch = await render(async (mode) => ready(mode), true);
      await act(async () =>
        (
          host.querySelector(".conversation-child") as HTMLButtonElement
        ).click(),
      );
      const button = host.querySelector<HTMLButtonElement>(
        `[aria-label="${label}"]`,
      )!;
      expect(button.disabled).toBe(false);
      await act(async () => button.click());
      const calls = fetch.mock.calls.filter(([url]) =>
        String(url).endsWith("/actions"),
      );
      expect(calls).toHaveLength(1);
      expect(String(calls[0][0])).toContain(
        `/mailboxes/${otherId}/messages/${ancestorId}/actions`,
      );
      expect(JSON.parse(String(calls[0][1]?.body))).toEqual({ action });
    },
  );
  function ready(mode: string) {
    return Response.json({
      status: "ready",
      prefill: {
        accountId,
        to: mode === "forward" ? "" : "sender@example.test",
        cc: "",
        subject: mode === "forward" ? "Fwd: Subject" : "Re: Subject",
        plainText: "\n\n> Body",
        attachmentsOmitted: false,
        source: { accountId, mailboxId: inboxId, messageId, mode },
      },
    });
  }
  it.each(["Reply", "Reply All", "Forward"])(
    "conversation %s targets the selected historical message in its own mailbox",
    async (label) => {
      const fetch = await render(async (mode) => ready(mode), true);
      expect(host.querySelector(".conversation-count")!.textContent).toBe("2");
      expect(host.querySelectorAll(".conversation-child")).toHaveLength(2);
      await act(async () =>
        (
          host.querySelector(".conversation-child") as HTMLButtonElement
        ).click(),
      );
      await act(async () =>
        (
          host.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement
        ).click(),
      );
      const mode = label === "Reply All" ? "reply_all" : label.toLowerCase();
      expect(
        fetch.mock.calls.some(([url]) =>
          String(url).includes(
            `/mailboxes/${otherId}/messages/${ancestorId}/prepare?mode=${mode}`,
          ),
        ),
      ).toBe(true);
      expect(
        fetch.mock.calls.some(([url]) => String(url).includes("/actions")),
      ).toBe(false);
    },
  );
  it("conversation read action targets only the selected historical message", async () => {
    const fetch = await render(async (mode) => ready(mode), true);
    await act(async () =>
      (host.querySelector(".conversation-child") as HTMLButtonElement).click(),
    );
    await act(async () =>
      (
        host.querySelector('[aria-label="Mark unread"]') as HTMLButtonElement
      ).click(),
    );
    const actions = fetch.mock.calls.filter(([url]) =>
      String(url).endsWith("/actions"),
    );
    expect(actions).toHaveLength(1);
    expect(String(actions[0][0])).toContain(
      `/mailboxes/${otherId}/messages/${ancestorId}/actions`,
    );
    expect(JSON.parse(String(actions[0][1]?.body))).toEqual({
      action: "mark_unread",
    });
  });
  it("keeps the classic list free of settings and saves the checkbox from account preferences", async () => {
    const fetch = await render(async (mode) => ready(mode));
    expect(host.querySelector('[aria-label="Conversation view"]')).toBeNull();
    expect(host.querySelector(".conversation-history")).toBeNull();
    await act(async () =>
      root!.render(<ConversationViewSettings initialEnabled={false} />),
    );
    const setting = host.querySelector<HTMLInputElement>(
      '[aria-label="Conversation view"]',
    )!;
    expect(setting.type).toBe("checkbox");
    expect(setting.checked).toBe(false);
    await act(async () => setting.click());
    expect(
      fetch.mock.calls.some(
        ([url, init]) =>
          String(url).endsWith("/settings/conversation-view") &&
          init?.method === "PUT" &&
          String(init.body) === '{"enabled":true}',
      ),
    ).toBe(true);
    expect(setting.checked).toBe(true);
    expect(host.textContent).toContain("Saved");
  });
  it.each(["Reply", "Reply All", "Forward"])(
    "opens the existing composer using %s and never marks read",
    async (label) => {
      const fetch = await render(async (mode) => ready(mode));
      for (const action of ["Reply", "Reply All", "Forward"])
        expect(host.querySelector(`[aria-label="${action}"]`)).not.toBeNull();
      await act(async () => {
        (
          host.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement
        ).click();
      });
      expect(host.querySelector(".mail-composer")).not.toBeNull();
      expect(host.querySelector(".mail-body")).toBeNull();
      const compose = [...host.querySelectorAll("button")].find(
        (button) => button.textContent === "New message",
      )!;
      expect(compose.disabled).toBe(true);

      expect(
        host.querySelector<HTMLInputElement>('[aria-label="To"]')!.value,
      ).toBe(label === "Forward" ? "" : "sender@example.test");
      expect(
        fetch.mock.calls.some(([url]) => String(url).includes("/actions")),
      ).toBe(false);
    },
  );
  it("shows loading while preparation is pending and then opens the composer", async () => {
    let resolve!: (response: Response) => void;
    await render(
      () =>
        new Promise<Response>((r) => {
          resolve = r;
        }),
    );
    await act(async () => {
      (host.querySelector('[aria-label="Reply"]') as HTMLButtonElement).click();
    });
    expect(host.textContent).toContain("Preparing message");
    expect(host.querySelector(".mail-composer")).toBeNull();
    expect(
      (host.querySelector('[aria-label="Reply"]') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await act(async () => resolve(ready("reply")));
    expect(host.querySelector(".mail-composer")).not.toBeNull();
  });

  it("polls pending content without opening an empty composer", async () => {
    let calls = 0;
    await render(async (mode) =>
      ++calls === 1
        ? Response.json({ status: "pending" }, { status: 202 })
        : ready(mode),
    );
    vi.useFakeTimers();
    await act(async () => {
      (host.querySelector('[aria-label="Reply"]') as HTMLButtonElement).click();
    });
    expect(host.textContent).toContain("Preparing message");
    expect(host.querySelector(".mail-composer")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(host.querySelector(".mail-composer")).not.toBeNull();
    expect(calls).toBe(2);
  });
  it("shows a clear error and allows retry", async () => {
    let fail = true;
    await render(async (mode) =>
      fail
        ? Response.json(
            {
              error: "Content fetch failed. Retry loading the message content.",
            },
            { status: 409 },
          )
        : ready(mode),
    );
    await act(async () => {
      (
        host.querySelector('[aria-label="Forward"]') as HTMLButtonElement
      ).click();
    });
    expect(host.textContent).toContain("Content fetch failed");
    expect(host.querySelector(".mail-composer")).toBeNull();
    fail = false;
    await act(async () => {
      (
        host.querySelector('[aria-label="Forward"]') as HTMLButtonElement
      ).click();
    });
    expect(host.querySelector(".mail-composer")).not.toBeNull();
  });
});
