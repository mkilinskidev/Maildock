// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MailClient } from "@/components/mail-client";
import type { MailAccountView } from "@/modules/accounts/application/accounts-service";
import type { MailboxView } from "@/modules/mail/application/mailbox-service";
import type { AutoReadPreference } from "@/modules/mail/domain/mail-interactions";

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
  MessageReader: () => <div data-reader />,
}));
vi.mock("@/components/global-search-results", () => ({
  GlobalSearchResults: ({
    onSelect,
  }: {
    onSelect: (message: ReturnType<typeof row>) => void;
  }) => (
    <button onClick={() => onSelect(row("second", "b", "b-inbox"))}>
      Search result
    </button>
  ),
}));
const submitted = vi.hoisted(() => vi.fn());
vi.mock("@/components/mail-composer", () => ({
  sendingAccountAvailable: () => true,
  sendStatusText: () => "",
  MailComposer: () => (
    <form
      className="mail-composer"
      onSubmit={(event) => {
        event.preventDefault();
        submitted();
      }}
    >
      <input aria-label="Recipient" />
      <div contentEditable data-lexical-editor="true" />
      <button>Send</button>
    </form>
  ),
}));
const accounts = ["a", "b"].map((id) => ({
  id,
  displayName: id,
  enabled: true,
  email: `${id}@test`,
  mailboxDiscovery: { capabilities: ["MOVE"] },
})) as unknown as MailAccountView[];
const box = (id: string) =>
  ({
    id,
    name: "Inbox",
    remotePath: "INBOX",
    selectable: true,
    lifecycleStatus: "active",
    unseenCount: "2",
    synchronizedMessageCount: "2",
    deltaSync: {},
  }) as MailboxView;
const boxes = { a: [box("a-inbox")], b: [box("b-inbox")] };
const roles = {
  a: ["archive", "trash"].map((role) => ({
    role: role as "archive" | "trash",
    available: true,
    mailboxId: `a-${role}`,
    mailboxName: role,
    source: "manual" as const,
  })),
  b: ["archive", "trash"].map((role) => ({
    role: role as "archive" | "trash",
    available: true,
    mailboxId: `b-${role}`,
    mailboxName: role,
    source: "manual" as const,
  })),
};
const row = (
  id: string,
  accountId = "a",
  mailboxId = `${accountId}-inbox`,
  seen = false,
) => ({
  id,
  accountId,
  mailboxId,
  seen,
  flagged: false,
  subject: id,
  from: [{ address: "sender@test" }],
  date: "2026-10-04T10:00:00Z",
  size: "1",
  hasAttachments: false,
});
let host: HTMLDivElement, root: Root, fetcher: ReturnType<typeof vi.fn>;
let queueFailures: Set<string>,
  remoteFailures: Set<string>,
  serverRows: ReturnType<typeof row>[];
let commands: Record<
  string,
  { id: string; target: ReturnType<typeof row>; action: string }
>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  queueFailures = new Set();
  remoteFailures = new Set();
  commands = {};
  submitted.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function mount(
  options: {
    auto?: AutoReadPreference;
    all?: boolean;
    conversation?: boolean;
    read?: boolean;
    noMoveB?: boolean;
    count?: number;
  } = {},
) {
  serverRows = options.count
    ? Array.from({ length: options.count }, (_, i) => row(`m${i}`))
    : [row("first", "a", "a-inbox", options.read), row("second", "b")];
  fetcher = vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/actions")) {
      const id = url.split("/").at(-2)!;
      if (queueFailures.has(id))
        return Response.json({ error: "Queue failed" }, { status: 503 });
      const action = JSON.parse(String(init?.body)).action as string;
      const target = { ...serverRows.find((item) => item.id === id)! };
      const commandId = `command-${id}-${Object.keys(commands).length}`;
      commands[commandId] = { id: commandId, target, action };
      if (action === "mark_read" || action === "mark_unread")
        serverRows = serverRows.map((item) =>
          item.id === id ? { ...item, seen: action === "mark_read" } : item,
        );
      else if (["archive", "trash"].includes(action))
        serverRows = serverRows.filter((item) => item.id !== id);
      return Response.json({ id: commandId }, { status: 202 });
    }
    if (url.includes("/message-commands?")) {
      const ids = new URL(url, "http://localhost").searchParams.getAll("id");
      return Response.json({
        commands: ids.map((id) => {
          const command = commands[id];
          const failed = remoteFailures.has(command.target.id);
          if (failed)
            serverRows = serverRows.some(
              (item) => item.id === command.target.id,
            )
              ? serverRows.map((item) =>
                  item.id === command.target.id ? command.target : item,
                )
              : [...serverRows, command.target];
          return {
            id,
            status: failed ? "failed" : "succeeded",
            error: failed ? "Remote failed" : null,
            completedAt: "2026-10-04T10:00:00Z",
          };
        }),
      });
    }
    if (url.includes("/prepare?"))
      return Response.json({
        status: "ready",
        prefill: { accountId: url.includes("/accounts/b/") ? "b" : "a" },
      });
    if (url.endsWith("/mailboxes")) {
      const b = url.includes("/accounts/b/");
      return Response.json({
        mailboxes: b ? boxes.b : boxes.a,
        roles: b ? (options.noMoveB ? [] : roles.b) : roles.a,
      });
    }
    if (url.includes("/conversations/"))
      return Response.json({ items: [row("member", "a", "a-sent")] });
    if (url.includes("/messages?") || url.includes("/all-inboxes?"))
      return Response.json({
        items: options.conversation
          ? [{ ...serverRows[0], conversationId: "thread", messageCount: 2 }]
          : url.includes("all-inboxes")
            ? serverRows
            : serverRows.filter((item) => item.accountId === "a"),
        nextCursor: null,
      });
    if (/\/messages\/[^/]+$/.test(url)) {
      const id = url.split("/").at(-1)!;
      const message =
        id === "member"
          ? row("member", "a", "a-sent")
          : serverRows.find((item) => item.id === id);
      return Response.json({
        ...message,
        to: [],
        cc: [],
        attachments: [],
        content: { status: "ready", plainText: "Body" },
      });
    }
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetcher);
  await act(async () =>
    root.render(
      <MailClient
        accounts={accounts}
        mailboxesByAccount={boxes}
        rolesByAccount={roles}
        initialConversationView={options.conversation}
        initialAutoRead={options.auto}
      />,
    ),
  );
  if (options.all) await click("All Inboxes");
}
async function click(text: string) {
  const button = [...host.querySelectorAll("button")].find(
    (item) =>
      item.textContent === text ||
      item.getAttribute("aria-label") === text ||
      (text === "All Inboxes" && item.textContent?.startsWith(text)),
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
async function open(index = 0) {
  await act(async () =>
    host.querySelectorAll<HTMLButtonElement>(".mail-list-row")[index].click(),
  );
}
async function selectAll() {
  await act(async () =>
    host
      .querySelector<HTMLInputElement>(
        '[aria-label="Select all loaded messages"]',
      )!
      .click(),
  );
}
async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
const mutations = () =>
  fetcher.mock.calls.filter(([url]) => String(url).endsWith("/actions"));
const manual: AutoReadPreference = { mode: "manually", seconds: 2 };

it("defaults to two seconds and never repeats auto-read after reconciliation", async () => {
  await mount();
  await open();
  await tick(1999);
  expect(mutations()).toHaveLength(0);
  await tick(1);
  expect(mutations()).toHaveLength(1);
  expect(mutations()[0][1].body).toBe('{"action":"mark_read"}');
  await tick(25000);
  expect(mutations()).toHaveLength(1);
  expect(host.textContent).not.toContain("Message marked as read");
});
it("cancels the old timer on selection change and preserves All Inboxes context", async () => {
  await mount({ all: true });
  await open();
  await tick(1000);
  await open(1);
  await tick(1000);
  expect(mutations()).toHaveLength(0);
  await tick(1000);
  expect(mutations()[0][0]).toBe(
    "/api/accounts/b/mailboxes/b-inbox/messages/second/actions",
  );
});
it.each([manual, { mode: "after", seconds: 2 } as const])(
  "does not auto-read an already read message (%s)",
  async (auto) => {
    await mount({ auto, read: true });
    await open();
    await tick(5000);
    expect(mutations()).toHaveLength(0);
  },
);
it("supports immediate, custom delay and manual preferences", async () => {
  await mount({ auto: { mode: "immediately", seconds: 2 } });
  await open();
  await tick(0);
  expect(mutations()).toHaveLength(1);
  await act(async () => root.unmount());
  root = createRoot(host);
  await mount({ auto: { mode: "after", seconds: 5 } });
  await open();
  await tick(4999);
  expect(mutations()).toHaveLength(0);
  await tick(1);
  expect(mutations()).toHaveLength(1);
});
it("manual preference leaves unread mail unchanged", async () => {
  await mount({ auto: manual });
  await open();
  await tick(10000);
  expect(mutations()).toHaveLength(0);
});
it("auto-reads the opened conversation member and its placement", async () => {
  await mount({ conversation: true });
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>(".conversation-group-header")!
      .click(),
  );
  serverRows.push(row("member", "a", "a-sent"));
  await open();
  await tick(2000);
  expect(mutations()[0][0]).toBe(
    "/api/accounts/a/mailboxes/a-sent/messages/member/actions",
  );
});
it("bulk read keeps each All Inboxes account and mailbox and reports confirmed count", async () => {
  await mount({ all: true, auto: manual });
  await selectAll();
  expect(host.textContent).toContain("2 selected");
  await click("Mark read");
  expect(mutations().map(([url]) => url)).toEqual([
    "/api/accounts/a/mailboxes/a-inbox/messages/first/actions",
    "/api/accounts/b/mailboxes/b-inbox/messages/second/actions",
  ]);
  expect(host.textContent).not.toContain("2 messages marked as read");
  await tick(3000);
  expect(host.textContent).toContain("2 messages marked as read");
});
it("rolls back only a failed enqueue and preserves the successful optimistic row", async () => {
  await mount({ all: true, auto: manual });
  queueFailures.add("second");
  await selectAll();
  await click("Mark read");
  const rows = host.querySelectorAll(".mail-list-row");
  expect(rows[0].classList.contains("unread")).toBe(false);
  expect(rows[1].classList.contains("unread")).toBe(true);
  await tick(3000);
  expect(host.textContent).toContain(
    "Message marked as read · 1 message action failed",
  );
  expect(host.textContent).not.toContain("2 messages marked as read");
});
it("reconciles partial remote failures across accounts without claiming all succeeded", async () => {
  await mount({ all: true, auto: manual });
  remoteFailures.add("second");
  await selectAll();
  await click("Mark read");
  await tick(3000);
  expect(host.textContent).toContain("Remote failed");
  expect(host.textContent).toContain(
    "Message marked as read · 1 message action failed",
  );
  const rows = host.querySelectorAll(".mail-list-row");
  expect(rows[0].classList.contains("unread")).toBe(false);
  expect(rows[1].classList.contains("unread")).toBe(true);
});
it("restores only the failed archived row", async () => {
  await mount({ all: true, auto: manual });
  queueFailures.add("second");
  await selectAll();
  await click("Archive");
  expect(host.querySelectorAll(".mail-list-row")).toHaveLength(1);
  expect(host.querySelector(".mail-list-row")?.textContent).toContain("second");
  await tick(3000);
  expect(host.textContent).toContain(
    "Message archived · 1 message action failed",
  );
});
it("disables bulk moves if any selected source lacks a role and guards Delete", async () => {
  await mount({ all: true, auto: manual, noMoveB: true });
  await selectAll();
  expect(
    [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.getAttribute("aria-label") === "Archive",
    )!.disabled,
  ).toBe(true);
  await key("Delete");
  expect(mutations()).toHaveLength(0);
});
it("selection is independent of opening and clears on mailbox, search and draft view changes", async () => {
  await mount({ all: true, auto: manual });
  await selectAll();
  await open();
  expect(host.textContent).toContain("2 selected");
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('[aria-label="a"] [title="INBOX"]')!
      .click(),
  );
  expect(host.textContent).not.toContain("2 selected");
  await selectAll();
  const input =
    host.querySelector<HTMLInputElement>('input[type="search"]') ??
    host.querySelector<HTMLInputElement>("input[placeholder]")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "query");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(host.textContent).not.toContain("1 selected");
  await click("All Inboxes");
  await selectAll();
  await click("Maildock drafts");
  expect(
    host.querySelector('[aria-label="Selected message actions"]'),
  ).toBeNull();
});
it("toolbar switches between open and selected messages and reuses preparation", async () => {
  await mount({ all: true, auto: manual });
  await open();
  const toolbar = host.querySelector('[role="toolbar"]')!;
  expect(toolbar.querySelector('[aria-label="Reply All"]')).not.toBeNull();
  await act(async () =>
    host
      .querySelector<HTMLInputElement>('[aria-label="Select second"]')!
      .click(),
  );
  expect(host.querySelector('[role="toolbar"]')?.textContent).toContain(
    "1 selected",
  );
  expect(
    host.querySelector('[role="toolbar"] [aria-label="Reply"]'),
  ).toBeNull();
  await act(async () =>
    host
      .querySelector<HTMLInputElement>('[aria-label="Select second"]')!
      .click(),
  );
  await click("Forward");
  expect(
    fetcher.mock.calls.some(
      ([url]) =>
        url ===
        "/api/accounts/a/mailboxes/a-inbox/messages/first/prepare?mode=forward",
    ),
  ).toBe(true);
});
async function key(
  key: string,
  target: Element | Document = document,
  modifiers = {},
) {
  await act(async () =>
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ...modifiers,
      }),
    ),
  );
}
it.each(["input", "textarea", "select", "editable", "lexical"])(
  "guards typing in %s, including descendant targets",
  async (kind) => {
    await mount({ auto: manual });
    await open();
    const element = document.createElement(
      ["editable", "lexical"].includes(kind) ? "div" : kind,
    );
    if (kind === "editable") element.setAttribute("contenteditable", "true");
    if (kind === "lexical") element.setAttribute("data-lexical-editor", "true");
    host.append(element);
    const child = document.createElement("span");
    if (kind === "editable" || kind === "lexical") element.append(child);
    for (const name of ["c", "r", "a", "f", "Delete"])
      await key(name, child.parentElement ? child : element);
    expect(mutations()).toHaveLength(0);
    expect(
      fetcher.mock.calls.some(([url]) => String(url).includes("/prepare?")),
    ).toBe(false);
    expect(host.querySelector(".mail-composer")).toBeNull();
  },
);
it.each([
  ["r", "reply"],
  ["a", "reply_all"],
  ["f", "forward"],
])("%s uses existing %s preparation", async (keyName, mode) => {
  await mount({ auto: manual });
  await open();
  await key(keyName);
  expect(
    fetcher.mock.calls.some(([url]) =>
      String(url).endsWith(`/prepare?mode=${mode}`),
    ),
  ).toBe(true);
});
it("preserves browser modifiers and guards Send editing targets, then submits the compose form", async () => {
  await mount({ auto: manual });
  await key("c", document, { ctrlKey: true });
  expect(host.querySelector(".mail-composer")).toBeNull();
  await key("c");
  expect(host.querySelector(".mail-composer")).not.toBeNull();
  await key("Enter", host.querySelector('[aria-label="Recipient"]')!, {
    ctrlKey: true,
  });
  expect(submitted).not.toHaveBeenCalled();
  await key("Enter", host.querySelector("form button")!, { metaKey: true });
  expect(submitted).toHaveBeenCalledOnce();
});
it("batches status requests within the existing 50-command API limit", async () => {
  await mount({ auto: manual, count: 51 });
  await selectAll();
  await click("Mark read");
  await tick(3000);
  const urls = fetcher.mock.calls.filter(([url]) =>
    String(url).includes("/message-commands?"),
  );
  expect(urls).toHaveLength(2);
  expect(
    urls.map(
      ([url]) =>
        new URL(String(url), "http://localhost").searchParams.getAll("id")
          .length,
    ),
  ).toEqual([50, 1]);
  expect(host.textContent).toContain("51 messages marked as read");
});

it("auto-read in search uses the result account and mailbox", async () => {
  await mount();
  const input = host.querySelector<HTMLInputElement>(
    '[aria-label="Search all mail"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "second");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Search result");
  await tick(2000);
  expect(mutations()[0][0]).toBe(
    "/api/accounts/b/mailboxes/b-inbox/messages/second/actions",
  );
});
it("cancels pending auto-read on mailbox and compose navigation", async () => {
  await mount();
  await open();
  await tick(1000);
  await click("Maildock drafts");
  await tick(3000);
  expect(mutations()).toHaveLength(0);
  await click("All Inboxes");
  await open();
  await tick(1000);
  await key("c");
  await tick(3000);
  expect(mutations()).toHaveLength(0);
});
it("bulk unread and Trash use the shared path", async () => {
  await mount({ auto: manual, all: true, read: true });
  await selectAll();
  await click("Mark unread");
  expect(mutations()).toHaveLength(1);
  expect(mutations()[0][1].body).toBe('{"action":"mark_unread"}');
  await tick(3000);
  await key("Delete");
  expect(
    mutations().filter(([, init]) => init.body === '{"action":"trash"}'),
  ).toHaveLength(2);
  await tick(3000);
  expect(host.textContent).toContain("2 messages moved to Trash");
});
it("conversation selection uses loaded members, never group representatives", async () => {
  await mount({ auto: manual, conversation: true });
  expect(
    host.querySelector<HTMLInputElement>(
      '[aria-label="Select all loaded messages"]',
    )!.disabled,
  ).toBe(true);
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>(".conversation-group-header")!
      .click(),
  );
  serverRows.push(row("member", "a", "a-sent"));
  await selectAll();
  await click("Mark read");
  expect(mutations()).toHaveLength(1);
  expect(mutations()[0][0]).toContain(
    "/mailboxes/a-sent/messages/member/actions",
  );
});

it("leaves modified, repeated and IME keyboard events untouched", async () => {
  await mount({ auto: manual });
  await open();
  for (const modifiers of [
    { altKey: true },
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
    { repeat: true },
    { isComposing: true },
  ]) {
    await key("r", document, modifiers);
    await key("c", document, modifiers);
    await key("Delete", document, modifiers);
  }
  expect(mutations()).toHaveLength(0);
  expect(host.querySelector(".mail-composer")).toBeNull();
  expect(
    fetcher.mock.calls.some(([url]) => String(url).includes("/prepare?")),
  ).toBe(false);
});
it("does not mark read when the opened detail already reports read despite a stale list", async () => {
  await mount();
  const fallback = fetcher.getMockImplementation() as (
    input: string,
    init?: RequestInit,
  ) => Promise<Response>;
  fetcher.mockImplementation(async (input: string, init?: RequestInit) =>
    String(input).endsWith("/messages/first")
      ? Response.json({
          ...row("first", "a", "a-inbox", true),
          content: { status: "ready" },
        })
      : fallback(input, init),
  );
  await open();
  await tick(3000);
  expect(mutations()).toHaveLength(0);
});

it("refreshes selected read state before bulk enqueue instead of marking already-read rows", async () => {
  await mount({ auto: manual });
  await selectAll();
  serverRows = serverRows.map((item) => ({ ...item, seen: true }));
  await tick(20000);
  await click("Mark read");
  expect(mutations()).toHaveLength(0);
  await click("Mark unread");
  expect(mutations()).toHaveLength(1);
});

it("keeps select-all compact in the header and reveals selection mode only while checked", async () => {
  await mount({ all: true, auto: manual });
  const list = host.querySelector(".flat-message-list")!;
  const selectAll = host.querySelector(
    '[aria-label="Select all loaded messages"]',
  )!;
  expect(selectAll.closest(".mail-pane-header")).not.toBeNull();
  expect(selectAll.closest(".mail-rows")).toBeNull();
  expect(selectAll.parentElement?.textContent?.trim()).toBe("");
  expect(list.classList.contains("selection-mode")).toBe(false);
  const firstCheckbox = host.querySelector<HTMLInputElement>(
    '[aria-label="Select first"]',
  )!;
  await act(async () => firstCheckbox.click());
  expect(list.classList.contains("selection-mode")).toBe(true);
  expect(
    host.querySelector('[aria-label="Selected message actions"]')?.textContent,
  ).toContain("1 selected");
  await act(async () => firstCheckbox.click());
  expect(list.classList.contains("selection-mode")).toBe(false);
  expect(
    host.querySelector('[aria-label="Selected message actions"]'),
  ).toBeNull();
});
it("uses the same selection-mode presentation for conversation members", async () => {
  await mount({ auto: manual, conversation: true });
  const list = host.querySelector(".conversation-message-list")!;
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>(".conversation-group-header")!
      .click(),
  );
  expect(list.classList.contains("selection-mode")).toBe(false);
  await selectAll();
  expect(list.classList.contains("selection-mode")).toBe(true);
  await selectAll();
  expect(list.classList.contains("selection-mode")).toBe(false);
});
