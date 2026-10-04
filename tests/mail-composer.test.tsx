import { DraftList } from "@/components/draft-list";
import type { DraftView } from "@/modules/mail/domain/draft";
import type { ComposePrefill } from "@/modules/mail/domain/compose-source";
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MailComposer, sendStatusText } from "@/components/mail-composer";
import type { MailAccountView } from "@/modules/accounts/application/accounts-service";
import { MailClient } from "@/components/mail-client";
import {
  $getRoot,
  $createParagraphNode,
  $createTextNode,
  getEditorPropertyFromDOMNode,
  type LexicalEditor,
} from "lexical";

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

const accounts = [
  {
    id: "first",
    displayName: "First account",
    email: "first@example.com",
    enabled: true,
    smtp: { host: "smtp.example.com" },
  },
  {
    id: "second",
    displayName: "Second account",
    email: "second@example.com",
    enabled: true,
    smtp: { host: "smtp.example.com" },
  },
  {
    id: "disabled",
    displayName: "Disabled account",
    enabled: false,
    smtp: { host: "smtp.example.com" },
  },
] as MailAccountView[];
function savedDraftResponse(url: unknown, init?: RequestInit) {
  if (String(url).startsWith("/api/drafts") && !String(url).endsWith("/send")) {
    const body = JSON.parse(init?.body as string);
    return Response.json({
      ...body,
      id: body.id ?? String(url).split("/").pop(),
      revision: (body.expectedRevision ?? 0) + 1,
      attachments: body.attachments ?? [],
    });
  }
  return null;
}
describe("compose UI", () => {
  let root: Root | undefined;
  let host: HTMLDivElement;
  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    document.body.innerHTML = "";
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  async function render(
    onQueued = vi.fn(),
    prefill?: ComposePrefill,
    draft?: DraftView,
  ) {
    // jsdom has selection ranges but no layout engine. Lexical's caret scroll
    // code needs these geometry methods when inserting a link at the caret.
    if (!Range.prototype.getBoundingClientRect)
      Object.defineProperty(Range.prototype, "getBoundingClientRect", {
        configurable: true,
        value: () => new DOMRect(),
      });
    if (!Range.prototype.getClientRects)
      Object.defineProperty(Range.prototype, "getClientRects", {
        configurable: true,
        value: () => [],
      });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () =>
      root!.render(
        <MailComposer
          accounts={accounts}
          prefill={prefill}
          draft={draft}
          accountId="second"
          onQueued={onQueued}
          onClose={vi.fn()}
        />,
      ),
    );
    return onQueued;
  }
  async function input(label: string, value: string) {
    const element = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      `[aria-label="${label}"]`,
    )!;
    if (label === "Message body") {
      const editor = getEditorPropertyFromDOMNode(element) as LexicalEditor;
      await act(async () =>
        editor!.update(
          () => {
            $getRoot()
              .clear()
              .append($createParagraphNode().append($createTextNode(value)));
          },
          { discrete: true },
        ),
      );
      return;
    }
    const prototype =
      element.tagName === "TEXTAREA"
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
        element,
        value,
      );
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  function bodyText() {
    const editor = getEditorPropertyFromDOMNode(
      host.querySelector('[aria-label="Message body"]'),
    ) as LexicalEditor;
    return editor.getEditorState().read(() => $getRoot().getTextContent());
  }
  async function submit() {
    await act(async () => {
      host
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
  }
  async function selectFile() {
    const picker = host.querySelector<HTMLInputElement>(
      '[aria-label="Select attachments"]',
    )!;
    Object.defineProperty(picker, "files", {
      configurable: true,
      value: [new File(["bytes"], "invoice.pdf", { type: "application/pdf" })],
    });
    await act(async () =>
      picker.dispatchEvent(new Event("change", { bubbles: true })),
    );
  }
  it("inserts a visible safe link at an empty caret and persists its authoritative rich document", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async (url, init) =>
        savedDraftResponse(url, init) ?? Response.json({ id: "outgoing" }),
    );
    vi.stubGlobal("fetch", fetch);
    await render();
    const prompt = window.prompt;
    window.prompt = () => "https://example.com/";
    try {
      await act(async () =>
        host
          .querySelector<HTMLButtonElement>('button[aria-label="Link"]')!
          .click(),
      );
      expect(
        host
          .querySelector('[aria-label="Message body"] a')
          ?.getAttribute("href"),
      ).toBe("https://example.com/");
      expect(bodyText()).toBe("https://example.com/");
      await input("To", "to@example.com");
      await submit();
      const body = JSON.parse(
        fetch.mock.calls.find(([url]) => String(url) === "/api/drafts")![1]!
          .body as string,
      );
      expect(
        body.richDocument.editor.root.children[0].children[0],
      ).toMatchObject({
        type: "link",
        url: "https://example.com/",
        rel: null,
        target: null,
      });
      expect(host.textContent).not.toContain("unsupported formatting");
    } finally {
      window.prompt = prompt;
    }
  });
  it("durably uploads before Send and retains all editor fields after removal", async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
      String(url) === "/api/attachments/staged"
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : Response.json({ removed: true }),
    );
    vi.stubGlobal("fetch", fetch);
    await render();
    await input("To", "recipient@example.com");
    await input("Cc", "cc@example.com");
    await input("Bcc", "private@example.com");
    await input("Subject", "Keep subject");
    await input("Message body", "Keep body");
    await selectFile();
    expect(host.textContent).toContain("Uploading");
    expect(
      host.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled,
    ).toBe(true);
    await submit();
    expect(fetch).toHaveBeenCalledOnce();
    await act(async () =>
      finish(
        Response.json({
          id: "staged",
          filename: "invoice.pdf",
          type: "application/pdf",
          size: "5",
          status: "ready",
          error: null,
        }),
      ),
    );
    expect(
      host.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled,
    ).toBe(false);
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>('[aria-label="Remove invoice.pdf"]')!
        .click(),
    );
    expect(fetch.mock.calls[1]).toEqual([
      "/api/attachments/staged/staged",
      { method: "DELETE" },
    ]);
    expect(
      host.querySelector<HTMLElement>('[aria-label="Message body"]')!
        .textContent,
    ).toBe("Keep body");
    for (const [label, value] of [
      ["Subject", "Keep subject"],
      ["To", "recipient@example.com"],
      ["Cc", "cc@example.com"],
      ["Bcc", "private@example.com"],
    ])
      expect(
        host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!.value,
      ).toBe(value);
  });
  it("keeps upload errors at attachment level and blocks Send until failed selection is removed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: "File exceeds the size limit." },
          { status: 413 },
        ),
      ),
    );
    await render();
    await input("Message body", "Keep body");
    await selectFile();
    expect(host.textContent).toContain("File exceeds the size limit");
    expect(
      host.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled,
    ).toBe(true);
    expect(
      host.querySelector<HTMLElement>('[aria-label="Message body"]')!
        .textContent,
    ).toBe("Keep body");
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>('[aria-label="Remove invoice.pdf"]')!
        .click(),
    );
    expect(
      host.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled,
    ).toBe(false);
  });
  function forwardPrefill(status = "pending"): ComposePrefill {
    return {
      accountId: "second",
      to: "to@example.com",
      cc: "",
      subject: "Forward",
      plainText: "Quoted",
      source: {
        accountId: "second",
        mailboxId: "mailbox",
        messageId: "message",
        mode: "forward",
      },
      attachmentsOmitted: false,
      attachments: [
        {
          id: "incoming",
          filename: "invoice.pdf",
          type: "application/pdf",
          size: "100",
          status,
          error: null,
          visible: true,
          inline: false,
        },
      ],
    };
  }
  it("blocks Forward Send while preparing, polls readiness, then sends selected incoming IDs", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>(
      async (url, init) =>
        savedDraftResponse(url, init) ??
        (String(url).endsWith("/send")
          ? Response.json({ id: "queued" })
          : Response.json({ status: "ready", size: "100", error: null })),
    );
    vi.stubGlobal("fetch", fetch);
    await render(vi.fn(), forwardPrefill());
    expect(
      host.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled,
    ).toBe(true);
    expect(host.textContent).toContain("Preparing attachment");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(
      host.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled,
    ).toBe(false);
    await submit();
    const send = fetch.mock.calls.find(
      ([url]) => String(url) === "/api/drafts",
    )!;
    expect(JSON.parse(send[1]!.body as string).attachments).toEqual([
      { kind: "incoming", id: "incoming", inline: false },
    ]);
  });
  it("shows failed Forward preparation and excludes removed incoming attachments without deleting cached data", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>(
      async (url, init) =>
        savedDraftResponse(url, init) ??
        Response.json({
          status: "failed",
          error: "Remote attachment is unavailable.",
        }),
    );
    vi.stubGlobal("fetch", fetch);
    await render(vi.fn(), forwardPrefill());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(host.textContent).toContain("Remote attachment is unavailable");
    expect(
      host.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled,
    ).toBe(true);
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>('[aria-label="Remove invoice.pdf"]')!
        .click(),
    );
    expect(
      host.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled,
    ).toBe(false);
    expect(
      fetch.mock.calls.filter(([url]) =>
        String(url).startsWith("/api/attachments/"),
      ),
    ).toHaveLength(1);
    expect(
      host.querySelector<HTMLElement>('[aria-label="Message body"]')!
        .textContent,
    ).toBe("Quoted");
  });
  it("defaults to the relevant account, allows only configured account selection and queues all compose fields", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async (url, init) =>
        savedDraftResponse(url, init) ??
        Response.json({ id: "durable-id", status: "queued" }, { status: 202 }),
    );
    vi.stubGlobal("fetch", fetch);
    const onQueued = await render();
    const select = host.querySelector<HTMLSelectElement>("select")!;
    expect(select.value).toBe("second");
    expect(select.options).toHaveLength(2);
    await act(async () => {
      select.value = "first";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await input("To", "Mateusz <to@example.com>");
    await input("Cc", "cc@example.com");
    await input("Bcc", "hidden@example.com");
    await input("Subject", "Cześć");
    await input("Message body", "Zażółć gęślą jaźń");
    await submit();
    const body = JSON.parse(fetch.mock.calls[0][1]!.body as string);
    expect(body).toEqual({
      accountId: "first",
      to: "Mateusz <to@example.com>",
      cc: "cc@example.com",
      bcc: "hidden@example.com",
      subject: "Cześć",
      plainText: "Zażółć gęślą jaźń",
      richDocument: expect.objectContaining({ version: 1 }),
      id: expect.any(String),
      attachments: [],
    });
    expect(body).not.toHaveProperty("from");
    expect(onQueued).toHaveBeenCalledExactlyOnceWith("durable-id");
  });

  it.each(["reply", "reply_all", "forward"] as const)(
    "edits prepared %s defaults and sends only source context through the usual endpoint",
    async (mode) => {
      const fetch = vi.fn<typeof globalThis.fetch>(
        async (url, init) =>
          savedDraftResponse(url, init) ??
          Response.json({ id: "queued" }, { status: 202 }),
      );
      vi.stubGlobal("fetch", fetch);
      const source = {
        accountId: "second",
        mailboxId: "mailbox",
        messageId: "message",
        mode,
      };
      await render(vi.fn(), {
        accountId: "second",
        to: mode === "forward" ? "" : "alice@example.com",
        cc: "",
        subject: "Prepared",
        plainText: "\n\nQuoted",
        source,
        attachmentsOmitted: true,
      });
      expect(host.querySelector<HTMLSelectElement>("select")!.value).toBe(
        "second",
      );
      expect(
        host.querySelector<HTMLInputElement>('[aria-label="To"]')!.value,
      ).toBe(mode === "forward" ? "" : "alice@example.com");
      expect(window.getSelection()?.anchorOffset).toBe(0);
      expect(host.textContent).not.toContain(
        "Original attachments are not included",
      );
      await input("To", "edited@example.com");
      await input("Cc", "cc@example.com");
      await input("Bcc", "private@example.com");
      await input("Subject", "Edited");
      await input("Message body", "Edited body");
      await act(async () => {
        const select = host.querySelector<HTMLSelectElement>("select")!;
        select.value = "first";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await submit();
      expect(fetch.mock.calls[0][0]).toBe("/api/drafts");
      expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({
        accountId: "first",
        to: "edited@example.com",
        cc: "cc@example.com",
        bcc: "private@example.com",
        subject: "Edited",
        plainText: "Edited body",
        richDocument: expect.objectContaining({ version: 1 }),
        id: expect.any(String),
        attachments: [],
        source,
      });
    },
  );
  it("retains compose state on API failure and requires at least one recipient", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ error: "Invalid recipient address." }, { status: 400 }),
    );
    vi.stubGlobal("fetch", fetch);
    const onQueued = await render();
    await submit();
    expect(fetch).not.toHaveBeenCalled();
    await input("Bcc", "hidden@example.com");
    await input("Message body", "Keep this content");
    await submit();
    expect(
      host.querySelector<HTMLElement>('[aria-label="Message body"]')!
        .textContent,
    ).toBe("Keep this content");
    expect(
      host.querySelector<HTMLInputElement>('[aria-label="Bcc"]')!.value,
    ).toBe("hidden@example.com");
    expect(host.textContent).toContain("Invalid recipient address.");
    expect(onQueued).not.toHaveBeenCalled();
  });

  it("debounces meaningful changes, creates once during slow create, and patches the same draft without identical saves", async () => {
    vi.useFakeTimers();
    let finish!: (response: Response) => void;
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) =>
      String(url) === "/api/drafts"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : savedDraftResponse(url, init)!,
    );
    vi.stubGlobal("fetch", fetch);
    await render();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(fetch).not.toHaveBeenCalled();
    await input("Subject", "Temporary");
    await input("Subject", "");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(
      Object.keys(localStorage).some((k) => k.startsWith("maildock-draft:")),
    ).toBe(false);
    await input("To", "jan@");
    await input("Subject", "First");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("Saving");
    await input("Message body", "Newer");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(fetch).toHaveBeenCalledOnce();
    const create = JSON.parse(fetch.mock.calls[0][1]!.body as string);
    await act(async () => finish(Response.json({ ...create, revision: 1 })));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][0]).toBe(`/api/drafts/${create.id}`);
    expect(JSON.parse(fetch.mock.calls[1][1]!.body as string)).toMatchObject({
      to: "jan@",
      plainText: "Newer",
      expectedRevision: 1,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("Saved");
  });
  it.each(["reply", "reply_all", "forward"] as const)(
    "restores all %s fields and saved quote exactly once without prepare requests",
    async (mode) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) =>
        savedDraftResponse(url, init)!,
      );
      vi.stubGlobal("fetch", fetch);
      vi.useFakeTimers();
      const draft: DraftView = {
        id: "draft-id",
        accountId: "first",
        to: "to@",
        cc: "cc@",
        bcc: "bcc@",
        subject: "Saved subject",
        plainText: "My edit\nQuoted once",
        composeMode: mode,
        source: {
          accountId: "second",
          mailboxId: "box",
          messageId: "message",
          mode,
        },
        revision: 5,
        status: "active",
        outgoingMessageId: null,
        attachments:
          mode === "forward"
            ? [{ ...forwardPrefill("ready").attachments![0], kind: "draft" }]
            : [],
      };
      await render(vi.fn(), undefined, draft);
      expect(host.querySelector<HTMLSelectElement>("select")!.value).toBe(
        "first",
      );
      for (const [label, value] of [
        ["To", draft.to],
        ["Cc", draft.cc],
        ["Bcc", draft.bcc],
        ["Subject", draft.subject],
        ["Message body", draft.plainText],
      ])
        expect(
          label === "Message body"
            ? bodyText()
            : host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!
                .value,
        ).toBe(value);
      if (mode === "forward") expect(host.textContent).toContain("invoice.pdf");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("shows two-tab conflict and blocks sending stale content", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) =>
      String(url) === "/api/drafts"
        ? savedDraftResponse(url, init)!
        : Response.json(
            { error: "This draft changed in another tab." },
            { status: 409 },
          ),
    );
    vi.stubGlobal("fetch", fetch);
    await render();
    await input("To", "to@example.com");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await input("Subject", "Stale");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(host.textContent).toContain("Save failed");
    expect(host.textContent).toContain("another tab");
    await submit();
    expect(
      fetch.mock.calls.some(([url]) => String(url).endsWith("/send")),
    ).toBe(false);
  });

  it("retries a lost Send response with the same draft and revision without recreating", async () => {
    let sends = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      const draftResponse = savedDraftResponse(url, init);
      if (draftResponse) return draftResponse;
      if (++sends === 1) throw Error("Network interrupted");
      return Response.json({ id: "same-outgoing", status: "queued" });
    });
    vi.stubGlobal("fetch", fetch);
    const queued = await render();
    await input("To", "to@example.com");
    await submit();
    expect(queued).not.toHaveBeenCalled();
    await submit();
    const calls = fetch.mock.calls.filter(([url]) =>
      String(url).endsWith("/send"),
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(calls[1]);
    expect(
      fetch.mock.calls.filter(([url]) => String(url) === "/api/drafts"),
    ).toHaveLength(1);
    expect(queued).toHaveBeenCalledExactlyOnceWith("same-outgoing");
  });
  it("keeps newer edits after retrying a lost initial create response", async () => {
    vi.useFakeTimers();
    let first: Record<string, unknown> | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      if (String(url) === "/api/drafts") {
        if (!first) {
          first = JSON.parse(init?.body as string);
          throw Error("Lost response");
        }
        return Response.json({ ...first, revision: 1 });
      }
      return savedDraftResponse(url, init)!;
    });
    vi.stubGlobal("fetch", fetch);
    await render();
    await input("To", "jan@");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await input("Message body", "Newer edit");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetch.mock.calls).toHaveLength(3);
    const bodies = fetch.mock.calls.map(([, init]) =>
      JSON.parse(init!.body as string),
    );
    expect(bodies[0].id).toBe(bodies[1].id);
    expect(bodies[2]).toMatchObject({
      plainText: "Newer edit",
      expectedRevision: 1,
    });
    expect(host.textContent).toContain("Saved");
    expect(host.textContent).not.toContain("Lost response");
  });
  it("close saves without deleting, while Discard explicitly deletes the durable association", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) =>
      init?.method === "DELETE"
        ? new Response(null, { status: 204 })
        : savedDraftResponse(url, init)!,
    );
    vi.stubGlobal("fetch", fetch);
    await render();
    await input("To", "jan@");
    await act(async () => {
      host
        .querySelector<HTMLButtonElement>('[aria-label="Close composer"]')!
        .click();
    });
    expect(
      fetch.mock.calls.filter(([, init]) => init?.method === "DELETE"),
    ).toHaveLength(0);
    await act(async () => {
      [...host.querySelectorAll("button")]
        .find((b) => b.textContent === "Discard")!
        .click();
    });
    expect(
      fetch.mock.calls.filter(([, init]) => init?.method === "DELETE"),
    ).toHaveLength(1);
  });
  it("stores changes before debounce for reload recovery and resumes those unsaved fields", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) =>
      savedDraftResponse(url, init)!,
    );
    vi.stubGlobal("fetch", fetch);
    await render();
    await input("To", "jan@");
    await input("Message body", "Last second edit");
    expect(fetch).not.toHaveBeenCalled();
    const key = Object.keys(localStorage).find((k) =>
      k.startsWith("maildock-draft:"),
    )!;
    const recovery = JSON.parse(localStorage.getItem(key)!) as DraftView;
    expect(recovery).toMatchObject({
      to: "jan@",
      plainText: "Last second edit",
      revision: 0,
      recovery: true,
    });
    await act(async () => {
      root!.unmount();
    });
    root = undefined;
    await render(vi.fn(), undefined, recovery);
    expect(
      host.querySelector<HTMLElement>('[aria-label="Message body"]')!
        .textContent,
    ).toBe("Last second edit");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(
      fetch.mock.calls
        .filter(([url]) => String(url) === "/api/drafts")
        .every(
          ([, init]) => JSON.parse(init!.body as string).id === recovery.id,
        ),
    ).toBe(true);
  });

  async function renderDraftList(onResume = vi.fn()) {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(<DraftList onResume={onResume} />));
    return onResume;
  }
  const restoredDraft = (): DraftView => ({
    id: "saved-draft",
    accountId: "first",
    to: "to@",
    cc: "cc@",
    bcc: "private@",
    subject: "Local only",
    plainText: "Saved body",
    revision: 4,
    composeMode: "new",
    source: null,
    status: "active",
    outgoingMessageId: null,
    attachments: [],
  });
  it("lists local drafts, fetches the saved body on resume and discards with revision without touching blobs", async () => {
    const row = restoredDraft();
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) =>
      init?.method === "DELETE"
        ? new Response(null, { status: 204 })
        : Response.json(String(url) === "/api/drafts" ? [row] : row),
    );
    vi.stubGlobal("fetch", fetch);
    const resumed = await renderDraftList();
    expect(host.textContent).toContain("Local only");
    await act(async () =>
      host.querySelector<HTMLButtonElement>(".mail-list-row")!.click(),
    );
    expect(resumed).toHaveBeenCalledExactlyOnceWith(row);
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>('[aria-label="Discard Local only"]')!
        .click(),
    );
    expect(
      fetch.mock.calls.find(([, init]) => init?.method === "DELETE"),
    ).toEqual([
      "/api/drafts/saved-draft",
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: 4 }),
      },
    ]);
    expect(
      fetch.mock.calls.some(([url]) => String(url).includes("attachments")),
    ).toBe(false);
    expect(host.textContent).toContain("No local drafts");
  });
  it("detects stale browser recovery and can explicitly reopen the server version", async () => {
    const row = restoredDraft();
    localStorage.setItem(
      `maildock-draft:${row.id}`,
      JSON.stringify({
        ...row,
        revision: 3,
        plainText: "Unsaved recovery",
        recovery: true,
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>(async (url) =>
        Response.json(String(url) === "/api/drafts" ? [row] : row),
      ),
    );
    const resumed = await renderDraftList();
    await act(async () =>
      host.querySelector<HTMLButtonElement>(".mail-list-row")!.click(),
    );
    expect(resumed).not.toHaveBeenCalled();
    expect(host.textContent).toContain("another tab");
    expect(localStorage.getItem(`maildock-draft:${row.id}`)).toContain(
      "Unsaved recovery",
    );
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((b) => b.textContent === "Reopen saved draft")!
        .click(),
    );
    expect(resumed).toHaveBeenCalledExactlyOnceWith(row);
    expect(localStorage.getItem(`maildock-draft:${row.id}`)).toBeNull();
  });
  it.each([
    ["queued", "Sending…"],
    ["sending", "Sending…"],
    ["sent", "Message sent"],
    ["failed", "Message could not be sent"],
    ["uncertain", "Maildock could not confirm whether this message was sent."],
  ])("distinguishes %s feedback", (status, text) => {
    expect(sendStatusText(status)).toBe(text);
  });
  it.each([
    ["queued", "not_required"],
    ["sending", "not_required"],
    ["sent", "not_required"],
    ["failed", "not_required"],
    ["uncertain", "not_required"],
    ["sent", "pending"],
    ["sent", "saving"],
    ["sent", "saved"],
    ["sent", "failed"],
    ["sent", "uncertain"],
  ])(
    "closes after queueing, renders %s / Sent copy %s and never renders Bcc in feedback",
    async (status, sentCopyStatus) => {
      vi.useFakeTimers();
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
        const draftResponse = savedDraftResponse(url, init);
        if (draftResponse) return draftResponse;
        if (String(url).endsWith("/send") && init?.method === "POST")
          return Response.json(
            { id: "durable-id", status: "queued" },
            { status: 202 },
          );
        if (String(url) === "/api/outgoing/durable-id")
          return Response.json({
            status,
            error: null,
            sentCopyStatus,
            sentCopyError: null,
          });
        return Response.json({
          mailboxes: [],
          roles: [],
          items: [],
          nextCursor: null,
        });
      });
      vi.stubGlobal("fetch", fetch);
      host = document.createElement("div");
      document.body.append(host);
      root = createRoot(host);
      await act(async () =>
        root!.render(
          <MailClient
            accounts={accounts.slice(0, 1)}
            mailboxesByAccount={{}}
            rolesByAccount={{}}
          />,
        ),
      );
      await act(async () => {
        const button = [...host.querySelectorAll("button")].find(
          (item) => item.textContent === "Compose",
        )!;
        button.click();
      });
      await input("Bcc", "hidden@example.com");
      await submit();
      expect(host.querySelector("form")).toBeNull();
      expect(host.querySelector('[role="status"]')?.textContent).toContain(
        sendStatusText(status, sentCopyStatus),
      );
      expect(host.innerHTML).not.toContain("hidden@example.com");
      expect(host.textContent).not.toContain("Retry uncertain");
      if (status === "sent") {
        expect(host.textContent).not.toContain("Message could not be sent");
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5100);
        });
        expect(Boolean(host.querySelector(".send-feedback"))).toBe(
          !["not_required", "saved"].includes(sentCopyStatus),
        );
      }
    },
  );
});
