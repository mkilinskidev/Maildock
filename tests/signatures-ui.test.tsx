// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import {
  $getRoot,
  $createTextNode,
  $createParagraphNode,
  $isElementNode,
  getEditorPropertyFromDOMNode,
  type LexicalEditor,
} from "lexical";
import { MailComposer } from "@/components/mail-composer";
import { RichComposer } from "@/components/rich-composer";
import type { MailAccountView } from "@/modules/accounts/application/accounts-service";
import {
  plainTextDocument,
  richElement,
  richText,
  validateRichDocument,
  type RichDocument,
} from "@/modules/mail/domain/rich-document";
import {
  automaticSignature,
  signatureFingerprint,
  type SignatureCatalog,
} from "@/modules/mail/domain/signature";
import type { DraftView } from "@/modules/mail/domain/draft";
import type { ComposePrefill } from "@/modules/mail/domain/compose-source";

const accountA = "00000000-0000-4000-8000-000000000001",
  accountB = "00000000-0000-4000-8000-000000000002";
const signatureA = "00000000-0000-4000-8000-000000000003",
  signatureB = "00000000-0000-4000-8000-000000000004";
const accounts = [accountA, accountB].map((id, i) => ({
  id,
  enabled: true,
  displayName: `Account ${i}`,
  email: `a${i}@example.com`,
  smtp: { host: "smtp.example.com" },
})) as MailAccountView[];
describe("rich signature composer", () => {
  let root: Root, host: HTMLDivElement;
  let catalog: SignatureCatalog;
  let saves: DraftView[];
  let remote: boolean;
  let pauseSnapshot: Promise<void> | undefined;
  let catalogUnavailable: boolean;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("TextEncoder", globalThis.TextEncoder);
    catalog = {
      signatures: [
        { id: signatureA, name: "NMI" },
        { id: signatureB, name: "Private" },
      ],
      defaults: {
        [accountA]: { new: signatureA, reply: signatureA, forward: signatureA },
        [accountB]: { new: signatureB, reply: signatureB, forward: signatureB },
      },
    };
    saves = [];
    remote = false;
    pauseSnapshot = undefined;
    catalogUnavailable = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/signatures")
          return catalogUnavailable
            ? Response.json({ error: "Unavailable" }, { status: 500 })
            : Response.json(catalog);
        if (url.endsWith("/snapshot")) {
          if (pauseSnapshot) await pauseSnapshot;
          const doc = plainTextDocument(
            url.includes(signatureA) ? "NMI signature" : "Private signature",
          );
          if (remote)
            doc.editor.root.children![0].children!.push({
              type: "maildock-image",
              version: 1,
              url: "https://third-party.invalid/tracker",
              alt: "Remote logo",
              width: 480,
            });
          return Response.json({ richDocument: doc, attachments: [] });
        }
        const input = JSON.parse(init?.body as string);
        const result = {
          ...input,
          id: input.id ?? url.split("/").pop(),
          richDocument: validateRichDocument(input.richDocument),
          revision: (input.expectedRevision ?? 0) + 1,
          attachments: input.attachments ?? [],
        };
        saves.push(result);
        return Response.json(result);
      }),
    );
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => new DOMRect(),
    });
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [],
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
    localStorage.clear();
    vi.unstubAllGlobals();
  });
  const editor = () =>
    getEditorPropertyFromDOMNode(
      host.querySelector('[aria-label="Message body"]'),
    ) as LexicalEditor;
  const documentValue = () =>
    validateRichDocument({
      version: 1,
      editor: editor().getEditorState().toJSON(),
    });
  async function settle() {
    for (let i = 0; i < 20; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
      if (
        !(host.querySelector('[aria-label="From"]') as HTMLSelectElement)
          ?.disabled
      )
        return;
    }
    throw Error("Signature initialization did not finish");
  }
  async function mount(prefill?: ComposePrefill, draft?: DraftView) {
    await act(async () =>
      root.render(
        <MailComposer
          accounts={accounts}
          accountId={accountA}
          prefill={prefill}
          draft={draft}
          onQueued={() => {}}
          onClose={() => {}}
        />,
      ),
    );
    await settle();
  }
  async function changeFrom(id: string) {
    await act(async () => {
      const select = host.querySelector(
        '[aria-label="From"]',
      ) as HTMLSelectElement;
      select.value = id;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
  }
  async function click(label: string) {
    await act(async () =>
      host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click(),
    );
  }
  async function manual() {
    await click("Insert signature");
    await act(async () =>
      Array.from(host.querySelectorAll("button"))
        .find((b) => b.textContent === "NMI")!
        .click(),
    );
    await settle();
  }
  it("places New signature after editable content and emits no third-party preview", async () => {
    remote = true;
    await mount();
    expect(documentValue().editor.root.children!.map((n) => n.type)).toEqual([
      "paragraph",
      "maildock-signature",
    ]);
    expect(host.querySelector('img[src^="https:"]')).toBeNull();
    expect(host.textContent).toContain("Remote image (preview blocked)");
  });
  it.each(["reply", "reply_all", "forward"] as const)(
    "places %s signature before the source header and quote",
    async (mode) => {
      const richDocument: RichDocument = {
        version: 1,
        editor: {
          root: richElement("root", [
            richElement("paragraph", []),
            richElement("paragraph", [richText("Original header")]),
            richElement("quote", [
              richElement("paragraph", [richText("Original body")]),
            ]),
          ]),
        },
      };
      await mount({
        accountId: accountA,
        to: "to@example.com",
        cc: "",
        subject: "Reply",
        plainText: "",
        richDocument,
        source: {
          accountId: accountA,
          mailboxId: accountB,
          messageId: signatureB,
          mode,
        },
        attachments: [],
        attachmentsOmitted: false,
      });
      expect(documentValue().editor.root.children!.map((n) => n.type)).toEqual([
        "paragraph",
        "maildock-signature",
        "paragraph",
        "quote",
      ]);
    },
  );
  it("replaces an untouched automatic signature", async () => {
    await mount();
    await changeFrom(accountB);
    expect(
      host.querySelector('[aria-label="Message body"]')!.textContent,
    ).toContain("Private signature");
  });
  it("keeps all reply paragraphs ahead of a signature loaded after typing", async () => {
    let resume!: () => void;
    pauseSnapshot = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const richDocument: RichDocument = {
      version: 1,
      editor: {
        root: richElement("root", [
          richElement("paragraph", []),
          richElement("paragraph", [richText("Header")]),
          richElement("quote", [
            richElement("paragraph", [richText("Original")]),
          ]),
        ]),
      },
    };
    const prefill: ComposePrefill = {
      accountId: accountA,
      to: "to@example.com",
      cc: "",
      subject: "Reply",
      plainText: "",
      richDocument,
      source: {
        accountId: accountA,
        mailboxId: accountB,
        messageId: signatureB,
        mode: "reply",
      },
      attachments: [],
      attachmentsOmitted: false,
    };
    await act(async () =>
      root.render(
        <MailComposer
          accounts={accounts}
          accountId={accountA}
          prefill={prefill}
          onQueued={() => {}}
          onClose={() => {}}
        />,
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      editor().update(
        () => {
          const first = $getRoot().getFirstChild();
          if ($isElementNode(first)) {
            first.append($createTextNode("Reply one"));
          }
        },
        { discrete: true },
      );
    });
    // Insert through Lexical's public node APIs while the template request is pending.
    await act(async () =>
      editor().update(
        () => {
          const first = $getRoot().getFirstChild();
          first?.insertAfter(
            $createParagraphNode().append($createTextNode("Reply two")),
          );
        },
        { discrete: true },
      ),
    );
    resume();
    await settle();
    expect(documentValue().editor.root.children!.map((n) => n.type)).toEqual([
      "paragraph",
      "paragraph",
      "maildock-signature",
      "paragraph",
      "quote",
    ]);
  });
  it("retries catalog failures and keeps supported edits in browser recovery while loading", async () => {
    catalogUnavailable = true;
    await expect(mount()).rejects.toThrow(
      "Signature initialization did not finish",
    );
    expect(
      (host.querySelector('button[type="submit"]') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await act(async () =>
      editor().update(
        () => {
          const first = $getRoot().getFirstChild();
          if ($isElementNode(first))
            first.append($createTextNode("Pending user text"));
        },
        { discrete: true },
      ),
    );
    expect(localStorage.getItem(localStorage.key(0)!)).toContain(
      "Pending user text",
    );
    catalogUnavailable = false;
    await act(async () =>
      Array.from(host.querySelectorAll("button"))
        .find((b) => b.textContent === "Retry signatures")!
        .click(),
    );
    await settle();
    expect(
      host.querySelector('[aria-label="Message body"]')!.textContent,
    ).toContain("Pending user text");
    expect(
      host.querySelector('[aria-label="Message body"]')!.textContent,
    ).toContain("NMI signature");
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
  it("removes an untouched automatic signature for None and can insert on a later switch", async () => {
    catalog.defaults[accountB].new = null;
    await mount();
    await changeFrom(accountB);
    expect(
      documentValue().editor.root.children!.some(
        (n) => n.type === "maildock-signature",
      ),
    ).toBe(false);
    await changeFrom(accountA);
    expect(
      host.querySelector('[aria-label="Message body"]')!.textContent,
    ).toContain("NMI signature");
  });
  it("preserves a user-edited automatic signature while switching accounts", async () => {
    await mount();
    await act(async () =>
      editor().update(
        () => {
          const signature = $getRoot().getChildren()[1];
          if ($isElementNode(signature)) {
            const p = signature.getFirstChild();
            if ($isElementNode(p)) p.append($createTextNode(" edited"));
          }
        },
        { discrete: true },
      ),
    );
    await changeFrom(accountB);
    expect(
      host.querySelector('[aria-label="Message body"]')!.textContent,
    ).toContain("NMI signature edited");
    expect(
      host.querySelector('[aria-label="Message body"]')!.textContent,
    ).not.toContain("Private signature");
  });
  it("rechecks content after a delayed account snapshot and preserves concurrent edits", async () => {
    await mount();
    let resume!: () => void;
    pauseSnapshot = new Promise<void>((resolve) => {
      resume = resolve;
    });
    await act(async () => {
      const select = host.querySelector(
        '[aria-label="From"]',
      ) as HTMLSelectElement;
      select.value = accountB;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      editor().update(
        () => {
          const signature = $getRoot().getChildren()[1];
          if ($isElementNode(signature)) {
            const p = signature.getFirstChild();
            if ($isElementNode(p))
              p.append($createTextNode(" concurrent edit"));
          }
        },
        { discrete: true },
      );
    });
    resume();
    await settle();
    expect(
      host.querySelector('[aria-label="Message body"]')!.textContent,
    ).toContain("NMI signature concurrent edit");
    expect(
      host.querySelector('[aria-label="Message body"]')!.textContent,
    ).not.toContain("Private signature");
  });
  it("inserts a single signature directly as ordinary content", async () => {
    catalog.signatures = [catalog.signatures[0]];
    catalog.defaults = {};
    await mount();
    await click("Insert signature");
    await settle();
    expect(
      host.querySelector('[aria-label="Message body"]')!.textContent,
    ).toContain("NMI signature");
    expect(
      documentValue().editor.root.children!.some(
        (n) => n.type === "maildock-signature",
      ),
    ).toBe(false);
    await changeFrom(accountB);
    expect(
      host.querySelector('[aria-label="Message body"]')!.textContent,
    ).toContain("NMI signature");
  });
  it("inserts manual signatures at the caret without automatic identity and preserves them", async () => {
    catalog.defaults[accountA].new = null;
    await mount();
    await manual();
    expect(
      documentValue().editor.root.children!.some(
        (n) => n.type === "maildock-signature",
      ),
    ).toBe(false);
    await changeFrom(accountB);
    expect(
      host.querySelector('[aria-label="Message body"]')!.textContent,
    ).toContain("NMI signature");
    expect(
      documentValue().editor.root.children!.some(
        (n) => n.type === "maildock-signature",
      ),
    ).toBe(true);
    expect(
      host.querySelector('[aria-label="Message body"]')!.textContent,
    ).toContain("Private signature");
  });
  it("autosaves automatic identity and restores it without reinserting a changed template", async () => {
    await mount();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1100));
    });
    expect(saves.length).toBeGreaterThan(0);
    const draft = {
      ...saves.at(-1)!,
      status: "active",
      source: null,
      composeMode: "new",
      outgoingMessageId: null,
    };
    const auto = draft.richDocument!.editor.root.children!.find(
      (n) => n.type === "maildock-signature",
    )!;
    expect(await signatureFingerprint(auto)).toBe(auto.fingerprint);
    await act(async () => root.unmount());
    root = createRoot(host);
    catalog.defaults[accountA].new = signatureB;
    await mount(undefined, draft);
    expect(
      host.querySelector('[aria-label="Message body"]')!.textContent,
    ).toContain("NMI signature");
    await changeFrom(accountB);
    expect(
      host.querySelector('[aria-label="Message body"]')!.textContent,
    ).toContain("Private signature");
  });
  it("offers an empty indication and hides insertion while editing a signature", async () => {
    catalog = { signatures: [], defaults: {} };
    await mount();
    await click("Insert signature");
    expect(host.textContent).toContain("No signatures yet");
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () =>
      root.render(
        <RichComposer
          initialDocument={plainTextDocument("")}
          onChange={() => {}}
          onError={() => {}}
          onValidation={() => {}}
          upload={async () => null}
          disabled={false}
          draftId={signatureA}
          revision={0}
        />,
      ),
    );
    expect(host.querySelector('[aria-label="Insert signature"]')).toBeNull();
  });
  it("rejects nested automatic identity and exact comparison detects formatting edits", async () => {
    const auto = await automaticSignature(
      signatureA,
      plainTextDocument("Hello"),
    );
    const modified = structuredClone(auto);
    modified.children![0].children![0].format = 1;
    expect(await signatureFingerprint(modified)).not.toBe(auto.fingerprint);
    expect(() =>
      validateRichDocument({
        version: 1,
        editor: { root: richElement("root", [richElement("quote", [auto])]) },
      }),
    ).toThrow();
  });
});
