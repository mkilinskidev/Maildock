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
vi.mock("@/components/message-reader", () => ({
  MessageReader: (props: {
    renderUrl: string;
    detail?: { subject: string };
    prepare: (mode: string) => void;
  }) => (
    <div data-reader-url={props.renderUrl}>
      {props.detail?.subject}
      <button onClick={() => props.prepare("reply")}>Reader reply</button>
    </div>
  ),
}));
const accounts = ["a", "b"].map((id) => ({
  id,
  displayName: id === "a" ? "Hotmail" : "DPoczta",
  email: `${id}@example.test`,
  enabled: true,
  mailboxDiscovery: { capabilities: ["MOVE"] },
})) as unknown as MailAccountView[];
const boxes = {
  a: [
    {
      id: "inbox",
      name: "Inbox",
      remotePath: "INBOX",
      selectable: true,
      lifecycleStatus: "active",
      synchronizedMessageCount: "1",
      unseenCount: "0",
      deltaSync: {},
    },
  ],
  b: [
    {
      id: "sent",
      name: "Sent",
      remotePath: "Sent",
      selectable: true,
      lifecycleStatus: "active",
      synchronizedMessageCount: "1",
      unseenCount: "0",
      deltaSync: {},
    },
  ],
} as unknown as Record<string, MailboxView[]>;
const normal = {
  id: "normal",
  subject: "Normal mailbox subject",
  from: [{ address: "normal@test" }],
  date: "2026-05-01T00:00:00Z",
  seen: true,
  flagged: false,
  size: "1",
  hasAttachments: false,
};
const result = {
  ...normal,
  id: "cross",
  subject: "Cross account subject",
  accountId: "b",
  accountName: "DPoczta",
  mailboxId: "sent",
  mailboxName: "Sent",
  snippet: '<img src=x onerror="alert(1)"> plain snippet',
};
describe("global header search overlay", () => {
  let root: Root;
  let host: HTMLDivElement;
  afterEach(async () => {
    await act(async () => root?.unmount());
    document.body.innerHTML = "";
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  async function mount(
    mode: "results" | "empty" | "error" = "results",
    conversation = false,
  ) {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("/api/search"))
        return mode === "error"
          ? Response.json({}, { status: 500 })
          : Response.json({
              items: mode === "empty" ? [] : [result],
              hasMore: false,
            });
      if (url.endsWith("/messages/cross"))
        return Response.json({ ...result, content: { status: "ready" } });
      if (url.endsWith("/messages/normal"))
        return Response.json({ ...normal, content: { status: "ready" } });
      if (url.includes("/prepare?"))
        return Response.json({ status: "ready", prefill: { accountId: "b" } });
      if (url.includes("/messages?pageSize"))
        return Response.json({ items: [normal], nextCursor: null });
      if (url.endsWith("/mailboxes"))
        return Response.json({
          mailboxes: url.includes("/accounts/b/") ? boxes.b : boxes.a,
          roles: [],
        });
      if (url.includes("/conversations/"))
        return Response.json({ items: [normal] });
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetcher);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () =>
      root.render(
        <MailClient
          accounts={accounts}
          mailboxesByAccount={boxes}
          rolesByAccount={{}}
          initialConversationView={conversation}
        />,
      ),
    );
    return fetcher;
  }
  async function type(value: string) {
    const input = host.querySelector<HTMLInputElement>(
      'input[aria-label="Search all mail"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function click(label: string) {
    const button = [...host.querySelectorAll("button")].find(
      (el) =>
        el.getAttribute("aria-label") === label ||
        el.textContent?.includes(label),
    )!;
    expect(button).toBeDefined();
    await act(async () => button.click());
  }
  it("debounces global requests, shows loading/context/safe snippets, opens correct reader, restores mailbox and normal message", async () => {
    const fetcher = await mount();
    await click("Normal mailbox subject");
    await type("micro");
    await act(async () => vi.advanceTimersByTime(200));
    await type("microsoft");
    await act(async () => vi.advanceTimersByTime(299));
    expect(
      fetcher.mock.calls.filter(([url]) =>
        String(url).startsWith("/api/search"),
      ),
    ).toHaveLength(0);
    expect(host.textContent).toContain("Searching all mail");
    await act(async () => vi.advanceTimersByTime(1));
    expect(
      fetcher.mock.calls
        .filter(([url]) => String(url).startsWith("/api/search"))
        .map(([url]) => String(url)),
    ).toEqual(["/api/search?q=microsoft"]);
    expect(host.textContent).toContain("DPoczta · Sent");
    expect(host.textContent).toContain(result.snippet);
    expect(host.querySelector(".global-search-results img")).toBeNull();
    await click("Cross account subject");
    expect(
      host.querySelector("[data-reader-url]")?.getAttribute("data-reader-url"),
    ).toBe("/api/accounts/b/mailboxes/sent/messages/cross/render");
    expect(host.querySelector('select[aria-label="Account"]')).toBeNull();
    expect(host.querySelector('[aria-label="Hotmail"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="DPoczta"]')).not.toBeNull();
    expect(
      fetcher.mock.calls.some(
        ([url]) =>
          String(url) === "/api/accounts/b/mailboxes/sent/messages/cross",
      ),
    ).toBe(true);
    expect(
      fetcher.mock.calls.some(([url]) => String(url).endsWith("/content")),
    ).toBe(false);
    await click("Cross account subject");
    expect(host.querySelector("[data-reader-url]")?.textContent).toContain(
      "Cross account subject",
    );
    await click("Clear search");
    expect(host.textContent).toContain("Normal mailbox subject");
    expect(
      host.querySelector("[data-reader-url]")?.getAttribute("data-reader-url"),
    ).toBe("/api/accounts/a/mailboxes/inbox/messages/normal/render");
    expect(host.querySelector(".mail-pane-header h1")?.textContent).toBe(
      "Inbox",
    );
  });
  it.each(["empty", "error"] as const)(
    "shows %s state and clearing preserves normal list",
    async (mode) => {
      await mount(mode);
      await type("needle");
      await act(async () => vi.advanceTimersByTime(300));
      expect(host.textContent).toContain(
        mode === "empty"
          ? "No matching messages"
          : "Search could not be completed",
      );
      await type("");
      expect(host.textContent).toContain("Normal mailbox subject");
    },
  );
  it("uses individual message search while conversation view is enabled", async () => {
    await mount("results", true);
    await type("needle");
    await act(async () => vi.advanceTimersByTime(300));
    await click("Cross account subject");
    expect(
      host.querySelector("[data-reader-url]")?.getAttribute("data-reader-url"),
    ).toBe("/api/accounts/b/mailboxes/sent/messages/cross/render");
  });
});
