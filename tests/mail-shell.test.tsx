// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { MailClient } from "@/components/mail-client";
import type { MailAccountView } from "@/modules/accounts/application/accounts-service";
import type { MailboxView } from "@/modules/mail/application/mailbox-service";
import {
  orderedSpecialMailboxes,
  otherMailboxTree,
} from "@/components/mailbox-tree";

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
vi.mock("@/components/mail-composer", () => ({
  sendingAccountAvailable: () => true,
  sendStatusText: () => "",
  MailComposer: ({ accountId }: { accountId: string }) => (
    <div data-composer-account={accountId} />
  ),
}));
vi.mock("@/components/message-reader", () => ({
  MessageReader: (props: {
    renderUrl: string;
    act: (action: string) => void;
    prepare: (mode: string) => void;
  }) => (
    <div data-reader-url={props.renderUrl}>
      {["mark_read", "mark_unread", "flag", "unflag", "archive", "trash"].map(
        (a) => (
          <button key={a} onClick={() => props.act(a)}>
            {a}
          </button>
        ),
      )}
      {["reply", "reply_all", "forward"].map((a) => (
        <button key={a} onClick={() => props.prepare(a)}>
          {a}
        </button>
      ))}
    </div>
  ),
}));
const accounts = ["a", "b"].map((id) => ({
  id,
  displayName: `Account ${id}`,
  email: `${id}@test`,
  enabled: true,
  mailboxDiscovery: { capabilities: ["MOVE"] },
})) as unknown as MailAccountView[];
const box = (id: string, path: string, name = path): MailboxView =>
  ({
    id,
    remotePath: path,
    name,
    delimiter: "/",
    selectable: true,
    lifecycleStatus: "active",
    unseenCount: "3",
    synchronizedMessageCount: "1",
    deltaSync: {},
  }) as MailboxView;
const boxes = {
  a: [
    box("a-inbox", "INBOX"),
    box("sent", "Envoyés"),
    box("nested", "Work/Clients/Alpha"),
    box("fake", "Sent"),
  ],
  b: [box("b-inbox", "INBOX")],
};
const roles = {
  a: [
    {
      role: "sent" as const,
      available: true,
      mailboxId: "sent",
      mailboxName: "Envoyés",
      source: "manual" as const,
    },
  ],
  b: ["archive", "trash"].map((role) => ({
    role: role as "archive" | "trash",
    available: true,
    mailboxId: `b-${role}`,
    mailboxName: role,
    source: "manual" as const,
  })),
};
const cross = {
  id: "cross",
  accountId: "b",
  mailboxId: "b-inbox",
  subject: "Cross-account mail",
  from: [{ address: "sender@test" }],
  date: "2026-10-04T10:00:00Z",
  seen: false,
  flagged: false,
  size: "1",
  hasAttachments: false,
  conversationId: "thread",
  messageCount: 1,
};
let root: Root;
let host: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function mount(
  conversation = false,
  multiple = false,
  notifications = false,
  initialNotification?: {
    accountId: string;
    mailboxId: string;
    messageId: string;
  },
  orderedAccounts = accounts,
) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
  const fetcher = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/notifications")
        return Response.json({
          preferences: { enabled: true, backgroundOnly: false },
          events:
            JSON.parse(init!.body as string).action === "start"
              ? []
              : [
                  {
                    id: "1",
                    accountId: "b",
                    mailboxId: "b-inbox",
                    messageId: "cross",
                    sender: "Sender",
                    subject: "Cross-account mail",
                    accountName: "Account b",
                  },
                ],
        });
      if (url.endsWith("/actions"))
        return Response.json({ id: "command" }, { status: 202 });
      if (url.includes("/prepare?"))
        return Response.json({ status: "ready", prefill: { accountId: "b" } });
      if (url.endsWith("/messages/cross"))
        return Response.json({ ...cross, content: { status: "ready" } });
      if (url.endsWith("/mailboxes"))
        return Response.json({
          mailboxes: url.includes("/accounts/b/") ? boxes.b : boxes.a,
          roles: url.includes("/accounts/b/") ? roles.b : roles.a,
        });
      if (url.includes("/conversations/"))
        return Response.json({ items: [cross] });
      if (url.includes("/all-inboxes?"))
        return Response.json({
          items: multiple
            ? [
                cross,
                { ...cross, id: "next", accountId: "a", mailboxId: "a-inbox" },
              ]
            : [cross],
          nextCursor: null,
        });
      if (init?.method === "POST") throw Error(`Unexpected mutation ${url}`);
      return Response.json({ items: [], nextCursor: null });
    },
  );
  vi.stubGlobal("fetch", fetcher);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <MailClient
        accounts={orderedAccounts}
        mailboxesByAccount={boxes}
        rolesByAccount={roles}
        initialConversationView={conversation}
        initialNotificationsEnabled={notifications}
        initialNotification={initialNotification}
      />,
    ),
  );
  return fetcher;
}
it.each([false, true])(
  "notification click opens the source account/mailbox/message from All Inboxes (conversation=%s)",
  async (conversation) => {
    vi.useFakeTimers();
    vi.stubGlobal("isSecureContext", true);
    const notifications: { onclick?: (event: Event) => void }[] = [];
    vi.stubGlobal(
      "Notification",
      class {
        static permission = "granted";
        onclick?: (event: Event) => void;
        close = vi.fn();
        constructor() {
          notifications.push(this);
        }
      },
    );
    const focus = vi.spyOn(window, "focus").mockImplementation(() => {});
    const fetcher = await mount(conversation, false, true);
    await click("All Inboxes");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    const notification = notifications[0];
    expect(notification).toBeDefined();
    await act(async () =>
      notification!.onclick!(new Event("click", { cancelable: true })),
    );
    expect(focus).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      "/api/accounts/b/mailboxes/b-inbox/messages/cross",
      expect.anything(),
    );
    expect(
      host.querySelector("[data-reader-url]")?.getAttribute("data-reader-url"),
    ).toContain("/accounts/b/mailboxes/b-inbox/messages/cross/render");
    expect(
      host
        .querySelector('[aria-label="Account b"] [title="INBOX"]')
        ?.getAttribute("aria-current"),
    ).toBe("page");
  },
);
it("opens a notification's explicit placement supplied by navigation from Settings", async () => {
  const fetcher = await mount(true, false, false, {
    accountId: "b",
    mailboxId: "b-inbox",
    messageId: "cross",
  });
  expect(fetcher).toHaveBeenCalledWith(
    "/api/accounts/b/mailboxes/b-inbox/messages/cross",
    expect.anything(),
  );
  expect(
    host.querySelector("[data-reader-url]")?.getAttribute("data-reader-url"),
  ).toContain("/accounts/b/mailboxes/b-inbox/messages/cross/render");
});
async function click(text: string) {
  const button = [...host.querySelectorAll("button")].find(
    (b) =>
      b.textContent === text ||
      (text === "All Inboxes" && b.textContent?.startsWith(text)),
  )!;
  expect(button).toBeDefined();
  await act(async () => button.click());
}
it("shows every account, collapses independently, preserves selection and header Compose", async () => {
  await mount(false, false, false, {
    accountId: "a",
    mailboxId: "a-inbox",
    messageId: "",
  });
  expect(host.querySelector('select[aria-label="Account"]')).toBeNull();
  expect(host.querySelector(".app-bar")?.textContent).toContain("New message");
  expect(host.querySelector(".mail-sidebar")?.textContent).not.toContain(
    "New message",
  );
  const a = host.querySelector('[aria-label="Account a"]')!;
  const b = host.querySelector('[aria-label="Account b"]')!;
  expect(a.querySelector('[title="INBOX"]')?.getAttribute("aria-current")).toBe(
    "page",
  );
  expect(b.querySelector('[title="INBOX"]')).not.toBeNull();
  await click("Account a");
  expect(a.querySelector('[title="INBOX"]')).toBeNull();
  expect(b.querySelector('[title="INBOX"]')).not.toBeNull();
  await click("Account a");
  expect(a.querySelector('[title="INBOX"]')?.getAttribute("aria-current")).toBe(
    "page",
  );
  const otherButton = [...a.querySelectorAll("button")].find(
    (el) => el.textContent === "Other folders",
  )!;
  expect(otherButton.getAttribute("aria-expanded")).toBe("false");
  await act(async () => otherButton.click());
  const other = a.querySelector(".tree-other")!;
  expect(other.textContent).toContain("Clients");
  expect(
    other.querySelector(
      '.tree-nested .tree-nested [title="Work/Clients/Alpha"]',
    ),
  ).not.toBeNull();
  const disclosure = [...a.querySelectorAll("button")].find(
    (el) => el.textContent === "Other folders",
  )!;
  await act(async () => disclosure.click());
  expect(a.querySelector(".tree-other")).toBeNull();
  await act(async () => disclosure.click());
  await act(async () =>
    (b.querySelector('[title="INBOX"]') as HTMLButtonElement).click(),
  );
  expect(b.querySelector('[title="INBOX"]')?.getAttribute("aria-current")).toBe(
    "page",
  );
  expect(
    a.querySelector('[title="INBOX"]')?.getAttribute("aria-current"),
  ).toBeNull();
});
it("orders semantic roles and keeps English-named ordinary folders in Other folders", () => {
  const special = orderedSpecialMailboxes(boxes.a, roles.a);
  expect(special.map((b) => b.id)).toEqual(["a-inbox", "sent"]);
  expect(
    otherMailboxTree(boxes.a, new Set(special.map((b) => b.id))).map(
      (n) => n.path,
    ),
  ).toEqual(["Sent", "Work"]);
});
it("orders every mapped system role, deduplicates mappings, and preserves nonselectable and missing parents", () => {
  const system = ["trash", "junk", "archive", "drafts", "sent"].map((role) =>
    box(role, `Localized/${role}`),
  );
  const mappings = system.map((b) => ({
    role: b.id as "trash" | "junk" | "archive" | "drafts" | "sent",
    mailboxId: b.id,
    mailboxName: b.name,
    available: true,
    source: "manual" as const,
  }));
  const folders = [box("inbox", "INBOX"), ...system];
  expect(orderedSpecialMailboxes(folders, mappings).map((b) => b.id)).toEqual([
    "inbox",
    "sent",
    "drafts",
    "archive",
    "junk",
    "trash",
  ]);
  expect(
    orderedSpecialMailboxes(folders, [...mappings, mappings[0]]).filter(
      (b) => b.id === "trash",
    ),
  ).toHaveLength(1);
  const parent = { ...box("parent", "Work"), selectable: false };
  const tree = otherMailboxTree(
    [box("child", "Work/Clients"), parent],
    new Set(),
  );
  expect(tree[0].mailbox?.selectable).toBe(false);
  expect(tree[0].children[0].mailbox?.id).toBe("child");
  const flat = { ...box("flat", "Literal/Slash"), delimiter: null };
  expect(otherMailboxTree([flat], new Set())[0].children).toEqual([]);
  const dotted = { ...box("dotted", "Work.Clients"), delimiter: "." };
  expect(otherMailboxTree([dotted], new Set())[0].children[0].name).toBe(
    "Clients",
  );
});
it.each(["mark_read", "mark_unread", "flag", "unflag", "archive", "trash"])(
  "All Inboxes %s targets the source placement",
  async (action) => {
    const fetcher = await mount();
    await click("All Inboxes");
    await act(async () =>
      (host.querySelector(".mail-list-row") as HTMLButtonElement).click(),
    );
    expect(
      host.querySelector("[data-reader-url]")?.getAttribute("data-reader-url"),
    ).toBe("/api/accounts/b/mailboxes/b-inbox/messages/cross/render");
    await click(action);
    expect(fetcher.mock.calls).toContainEqual([
      "/api/accounts/b/mailboxes/b-inbox/messages/cross/actions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ action }),
      }),
    ]);
  },
);
it.each(["reply", "reply_all", "forward"])(
  "All Inboxes %s prepares from the source account",
  async (mode) => {
    const fetcher = await mount();
    await click("All Inboxes");
    await act(async () =>
      (host.querySelector(".mail-list-row") as HTMLButtonElement).click(),
    );
    await click(mode);
    expect(fetcher.mock.calls).toContainEqual([
      `/api/accounts/b/mailboxes/b-inbox/messages/cross/prepare?mode=${mode}`,
      { method: "POST" },
    ]);
    expect(
      host
        .querySelector("[data-composer-account]")
        ?.getAttribute("data-composer-account"),
    ).toBe("b");
  },
);
it("All Inboxes conversation expansion uses source account and selects ordinary reader", async () => {
  const fetcher = await mount(true);
  await click("All Inboxes");
  await click("Cross-account mail1");
  expect(
    fetcher.mock.calls.some(
      ([url]) =>
        String(url) ===
        "/api/accounts/b/conversations/thread?metadataOnly=true&mailboxId=b-inbox",
    ),
  ).toBe(true);
  await act(async () =>
    (host.querySelector(".conversation-child") as HTMLButtonElement).click(),
  );
  expect(
    host.querySelector("[data-reader-url]")?.getAttribute("data-reader-url"),
  ).toBe("/api/accounts/b/mailboxes/b-inbox/messages/cross/render");
  await click("flag");
  expect(fetcher.mock.calls).toContainEqual([
    "/api/accounts/b/mailboxes/b-inbox/messages/cross/actions",
    expect.objectContaining({ method: "POST" }),
  ]);
});
it("moving an All Inboxes message selects the next message with its own account context", async () => {
  const fetcher = await mount(false, true);
  await click("All Inboxes");
  await act(async () =>
    (host.querySelector(".mail-list-row") as HTMLButtonElement).click(),
  );
  await click("archive");
  expect(
    host.querySelector("[data-reader-url]")?.getAttribute("data-reader-url"),
  ).toBe("/api/accounts/a/mailboxes/a-inbox/messages/next/render");
  await click("flag");
  expect(fetcher.mock.calls).toContainEqual([
    "/api/accounts/a/mailboxes/a-inbox/messages/next/actions",
    expect.objectContaining({ method: "POST" }),
  ]);
});

it("defaults to All Inboxes without selecting the first account Inbox", async () => {
  const fetcher = await mount();
  expect(
    host.querySelector('.mail-folders > button[aria-current="page"]')
      ?.textContent,
  ).toContain("All Inboxes");
  expect(
    host
      .querySelector('[aria-label="Account a"] [title="INBOX"]')
      ?.getAttribute("aria-current"),
  ).toBeNull();
  expect(
    fetcher.mock.calls.some(([url]) =>
      String(url).startsWith("/api/mail/all-inboxes?"),
    ),
  ).toBe(true);
  expect(
    fetcher.mock.calls.some(([url]) =>
      String(url).includes("/accounts/a/mailboxes/a-inbox/messages"),
    ),
  ).toBe(false);
});

it("renders the persisted account order while keeping All Inboxes selected", async () => {
  await mount(false, false, false, undefined, [...accounts].reverse());
  expect(
    [...host.querySelectorAll(".tree-account")].map((account) =>
      account.getAttribute("aria-label"),
    ),
  ).toEqual(["Account b", "Account a"]);
  expect(
    host.querySelector('.mail-folders > button[aria-current="page"]')
      ?.textContent,
  ).toContain("All Inboxes");
});
