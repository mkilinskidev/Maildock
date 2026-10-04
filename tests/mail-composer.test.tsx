import type { ComposePrefill } from "@/modules/mail/domain/compose-source";
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MailComposer, sendStatusText } from "@/components/mail-composer";
import type { MailAccountView } from "@/modules/accounts/application/accounts-service";
import { MailClient } from "@/components/mail-client";

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
describe("compose UI", () => {
  let root: Root | undefined;
  let host: HTMLDivElement;
  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  async function render(onQueued = vi.fn(), prefill?: ComposePrefill) {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () =>
      root!.render(
        <MailComposer
          accounts={accounts}
          prefill={prefill}
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
    expect(host.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe(
      "Keep body",
    );
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
    expect(host.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe(
      "Keep body",
    );
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
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
      String(url) === "/api/outgoing"
        ? Response.json({ id: "queued" })
        : Response.json({ status: "ready", size: "100", error: null }),
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
      ([url]) => String(url) === "/api/outgoing",
    )!;
    expect(JSON.parse(send[1]!.body as string).attachments).toEqual([
      { kind: "incoming", id: "incoming" },
    ]);
  });
  it("shows failed Forward preparation and excludes removed incoming attachments without deleting cached data", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () =>
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
    expect(fetch.mock.calls).toHaveLength(1);
    expect(host.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe(
      "Quoted",
    );
  });
  it("defaults to the relevant account, allows only configured account selection and queues all compose fields", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
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
    });
    expect(body).not.toHaveProperty("from");
    expect(onQueued).toHaveBeenCalledExactlyOnceWith("durable-id");
  });

  it.each(["reply", "reply_all", "forward"] as const)(
    "edits prepared %s defaults and sends only source context through the usual endpoint",
    async (mode) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () =>
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
      expect(
        host.querySelector<HTMLTextAreaElement>("textarea")!.selectionStart,
      ).toBe(0);
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
      expect(fetch.mock.calls[0][0]).toBe("/api/outgoing");
      expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({
        accountId: "first",
        to: "edited@example.com",
        cc: "cc@example.com",
        bcc: "private@example.com",
        subject: "Edited",
        plainText: "Edited body",
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
    expect(host.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe(
      "Keep this content",
    );
    expect(
      host.querySelector<HTMLInputElement>('[aria-label="Bcc"]')!.value,
    ).toBe("hidden@example.com");
    expect(host.textContent).toContain("Invalid recipient address.");
    expect(onQueued).not.toHaveBeenCalled();
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
        if (String(url) === "/api/outgoing" && init?.method === "POST")
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
