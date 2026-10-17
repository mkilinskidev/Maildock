// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MailClient } from "@/components/mail-client";
import { initialInboxPollDelay } from "@/shared/application/initial-inbox-polling";
import type { MailboxView } from "@/modules/mail/application/mailbox-service";
import type { MailAccountView } from "@/modules/accounts/application/accounts-service";

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
const account = {
  id: accountId,
  displayName: "Fixture",
  email: "fixture@example.invalid",
  enabled: true,
  mailboxDiscovery: { capabilities: [] },
} as unknown as MailAccountView;
function folder(id = inboxId, path = "INBOX"): MailboxView {
  return {
    id,
    name: path,
    remotePath: path,
    selectable: true,
    lifecycleStatus: "active",
    specialUse: [],
    firstDiscoveredAt: new Date().toISOString(),
    unseenCount: "0",
    synchronizedMessageCount: "0",
    recentSync: {
      status: "running",
      lastSuccessfulAt: null,
      completedAt: null,
    },
    deltaSync: { lastSuccessfulAt: null },
  } as unknown as MailboxView;
}

describe("first visible INBOX (mock HTTP only)", () => {
  let root: Root | undefined;
  let host: HTMLDivElement;
  let inbox: MailboxView;
  let requests: { url: string; signal?: AbortSignal | null }[];
  let available: boolean;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
    requests = [];
    available = false;
    inbox = folder();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, signal: init?.signal });
        if (url.endsWith("/mailboxes"))
          return Response.json({
            mailboxes: [inbox, folder(otherId, "Other")],
            roles: [],
          });
        if (url.includes("/messages?pageSize=50"))
          return Response.json({
            items:
              available && url.includes(inboxId)
                ? [
                    {
                      id: "00000000-0000-4000-8000-000000000004",
                      subject: "Visible first batch",
                      from: [],
                      date: new Date().toISOString(),
                      seen: false,
                      flagged: false,
                      size: "1",
                      hasAttachments: false,
                    },
                  ]
                : [],
            nextCursor: null,
          });
        throw new Error("Unexpected fixture request");
      }),
    );
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    document.body.innerHTML = "";
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const count = () =>
    requests.filter((item) => item.url.includes("/messages?pageSize=50"))
      .length;
  const advance = async (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  const render = async (boxes = [inbox, folder(otherId, "Other")]) =>
    act(async () => {
      root!.render(
        <MailClient
          initialNotification={{ accountId, mailboxId: inboxId }}
          accounts={[account]}
          mailboxesByAccount={{ [accountId]: boxes }}
          rolesByAccount={{ [accountId]: [] }}
        />,
      );
    });

  it("shows a committed first batch on the next fast poll while recent is still running", async () => {
    await render();
    expect(count()).toBe(1);
    available = true;
    await advance(2_000);
    expect(host.textContent).toContain("Visible first batch");
    expect(inbox.recentSync.status).toBe("running");
    expect(count()).toBe(2);
  });
  it("caps fast polling at one minute even if mailbox metadata stays running", async () => {
    await render();
    await advance(60_000);
    expect(count()).toBeLessThanOrEqual(32);
    const before = count();
    await advance(19_999);
    expect(count()).toBe(before);
    await advance(1);
    expect(count()).toBe(before + 1);
  });
  it("stops the fast cadence when the metadata reports a completed attempt", async () => {
    await render();
    inbox = {
      ...inbox,
      recentSync: {
        ...inbox.recentSync,
        status: "success",
        completedAt: new Date().toISOString(),
        lastSuccessfulAt: new Date().toISOString(),
      },
    };
    await advance(20_000);
    const before = count();
    await advance(2_000);
    expect(count()).toBe(before);
  });
  it("cancels the old request context and fast timer after switching folders", async () => {
    await render();
    const signal = requests.find((item) =>
      item.url.includes("/messages?pageSize=50"),
    )!.signal;
    await act(async () => {
      [...host.querySelectorAll("button")]
        .find((button) => button.textContent === "Other folders")!
        .click();
    });
    await act(async () => {
      (host.querySelector('[title="Other"]') as HTMLButtonElement).click();
    });
    expect(signal?.aborted).toBe(true);
    const before = count();
    await advance(2_000);
    expect(count()).toBe(before);
    await act(async () => {
      root!.unmount();
    });
    root = undefined;
    await advance(60_000);
    expect(count()).toBe(before);
  });
  it("keeps normal polling for an already initialized INBOX", async () => {
    inbox = {
      ...inbox,
      recentSync: {
        ...inbox.recentSync,
        status: "success",
        lastSuccessfulAt: new Date().toISOString(),
      },
    };
    await render();
    const before = count();
    await advance(2_000);
    expect(count()).toBe(before);
  });
  it("ignores a late response from the previous folder after cancellation", async () => {
    const originalFetch = globalThis.fetch;
    let release!: (response: Response) => void;
    vi.stubGlobal("fetch", (input: string, init?: RequestInit) => {
      if (String(input).includes(`${inboxId}/messages?pageSize=50`))
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      return originalFetch(input, init);
    });
    await render();
    await act(async () => {
      [...host.querySelectorAll("button")]
        .find((button) => button.textContent === "Other folders")!
        .click();
    });
    await act(async () => {
      (host.querySelector('[title="Other"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      release(
        Response.json({
          items: [{ id: "late", subject: "Late old batch" }],
          nextCursor: null,
        }),
      );
    });
    expect(host.textContent).not.toContain("Late old batch");
  });
  it.each(["All Inboxes", "Maildock drafts"])(
    "cancels fast polling when switching to %s",
    async (view) => {
      await render();
      const signal = requests.find((item) =>
        item.url.includes("/messages?pageSize=50"),
      )!.signal;
      await act(async () => {
        [...host.querySelectorAll("button")]
          .find((button) => button.textContent === view)!
          .click();
      });
      expect(signal?.aborted).toBe(true);
      const before = count();
      await advance(2_000);
      expect(count()).toBe(before);
    },
  );
  it("does not fast poll other folders, all-inboxes, hidden views, failures or expired onboarding", () => {
    expect(initialInboxPollDelay(inbox, false)).toBe(20_000);
    expect(initialInboxPollDelay(folder(otherId, "Other"), true)).toBe(20_000);
    expect(
      initialInboxPollDelay(
        {
          ...inbox,
          firstDiscoveredAt: new Date(Date.now() - 60_001).toISOString(),
        },
        true,
      ),
    ).toBe(20_000);
    expect(
      initialInboxPollDelay(
        { ...inbox, recentSync: { ...inbox.recentSync, status: "failed" } },
        true,
      ),
    ).toBe(20_000);
  });
});
