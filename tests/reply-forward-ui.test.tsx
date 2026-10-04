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

describe("reader reply and forward actions", () => {
  let root: Root | undefined;
  let host: HTMLDivElement;
  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  async function render(prepare: (mode: string) => Promise<Response>) {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes("/prepare?mode=")) {
        expect(init?.method).toBe("POST");
        return prepare(url.split("mode=")[1]);
      }
      if (url.endsWith(`/messages/${messageId}`)) return Response.json(detail);
      if (url.includes("/messages?pageSize=50"))
        return Response.json({ items: [message], nextCursor: null });
      if (url.endsWith("/mailboxes"))
        return Response.json({ mailboxes: [inbox, other], roles: [] });
      throw Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () =>
      root!.render(
        <MailClient
          accounts={[account]}
          mailboxesByAccount={{ [accountId]: [inbox, other] }}
          rolesByAccount={{ [accountId]: [] }}
        />,
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      (host.querySelector(".mail-list-row") as HTMLButtonElement).click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return fetch;
  }
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
        (button) => button.textContent === "Compose",
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
