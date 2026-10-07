import assert from "node:assert/strict";
import { createServer } from "node:http";
import { build } from "esbuild";
import path from "node:path";
import { readFile, mkdir } from "node:fs/promises";
import type { Browser } from "playwright";
import { JSDOM } from "jsdom";
import { sanitizeEmailHtml } from "../../src/modules/mail/infrastructure/sanitize-email-html";
import { importRichDom } from "../../src/modules/mail/domain/rich-import";
import {
  richElement,
  plainTextDocument,
  serializeRichDocument,
  validateRichDocument,
  type RichDocument,
} from "../../src/modules/mail/domain/rich-document";
import { png } from "./fixtures";
import type { SignatureCatalog } from "../../src/modules/mail/domain/signature";

/** Mount the actual MailComposer in a local harness; no mocked editor or reader iframe. */
export async function verifyComposeBrowser(
  browser: Browser,
  trapOrigin: string,
) {
  const accountId = "00000000-0000-4000-8000-000000000001",
    draftId = "00000000-0000-4000-8000-000000000002";
  const otherAccountId = "00000000-0000-4000-8000-000000000003",
    signatureId = "00000000-0000-4000-8000-000000000004",
    otherSignatureId = "00000000-0000-4000-8000-000000000005";
  let signatureCatalog: SignatureCatalog = { signatures: [], defaults: {} };
  const clean = sanitizeEmailHtml(
    `<p><b>Original formatting</b></p><img src="${trapOrigin}/compose-tracker" srcset="${trapOrigin}/compose-srcset 2x"><div style="background:url(${trapOrigin}/compose-bg)">Quoted</div><style>@import '${trapOrigin}/compose-import';@font-face{font-family:x;src:url(${trapOrigin}/compose-font)}</style><iframe src="${trapOrigin}/compose-frame"></iframe><link rel="preload" href="${trapOrigin}/compose-hint">`,
  );
  const dom = new JSDOM(clean.html);
  const quoted = importRichDom(dom.window.document, (img) => {
    const url = img.getAttribute("data-maildock-remote");
    return url
      ? {
          type: "maildock-image",
          version: 1,
          url,
          alt: "Quoted remote image",
          width: 480,
        }
      : null;
  });
  dom.window.close();
  const initial: RichDocument = {
    version: 1,
    editor: {
      root: richElement("root", [
        richElement("paragraph", []),
        richElement("quote", quoted.editor.root.children!),
      ]),
    },
  };
  const bundle = await build({
    stdin: {
      contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {MailComposer} from './src/components/mail-composer';
    const accounts=[{id:${JSON.stringify(accountId)},displayName:'Owner',email:'owner@example.com',enabled:true,smtp:{host:'smtp.example.com'}}, {id:${JSON.stringify(otherAccountId)},displayName:'Private',email:'private@example.com',enabled:true,smtp:{host:'smtp.example.com'}}];
    const root=createRoot(document.getElementById('app'));
    window.renderCompose=(draft,prefill)=>root.render(<MailComposer key={window.mountCount=(window.mountCount||0)+1} accounts={accounts} accountId={accounts[0].id} draft={draft} prefill={prefill} onQueued={()=>{}} onClose={()=>{}}/>);
    window.renderCompose(window.initialDraft);`,
      resolveDir: process.cwd(),
      sourcefile: "compose-security.tsx",
      loader: "tsx",
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    alias: { "@": path.resolve("src") },
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const styles = (await readFile("src/app/styles.css", "utf8")).replace(
    '@import "tailwindcss";',
    "",
  );
  let saved: Record<string, unknown> = {
    id: draftId,
    accountId,
    to: "to@example.com",
    cc: "",
    bcc: "",
    subject: "Reply",
    plainText: "",
    richDocument: initial,
    source: null,
    composeMode: "new",
    revision: 1,
    status: "active",
    outgoingMessageId: null,
    attachments: [],
  };
  const uploads: { inline: boolean; filename: string }[] = [];
  let resourceCount = 10;
  const resources = new Map<string, Buffer>();
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.url === "/styles.css") {
      res.setHeader("Content-Type", "text/css");
      res.end(styles);
      return;
    }
    if (req.url === "/bundle.js") {
      res.setHeader("Content-Type", "application/javascript");
      res.end(bundle.outputFiles[0].contents);
      return;
    }
    if (
      req.url?.startsWith("/api/attachments/staged/") &&
      req.method === "GET"
    ) {
      res.setHeader("Content-Type", "image/png");
      res.end(png);
      return;
    }
    if (
      req.url?.startsWith("/api/attachments/staged") &&
      req.method === "DELETE"
    ) {
      res.end("{}");
      return;
    }
    if (req.url === "/api/signatures") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(signatureCatalog));
      return;
    }
    if (req.url?.startsWith("/api/")) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      res.setHeader("Content-Type", "application/json");
      if (
        req.url?.startsWith("/api/signatures/") &&
        req.url.endsWith("/snapshot")
      ) {
        const richDocument = plainTextDocument(
          req.url.includes(otherSignatureId)
            ? "Private signature"
            : "NMI signature",
        );
        const id = `00000000-0000-4000-8000-${String(resourceCount++).padStart(12, "0")}`;
        resources.set(id, png);
        richDocument.editor.root.children![0].children!.push(
          {
            type: "maildock-image",
            version: 1,
            resourceId: id,
            alt: "Signature logo",
            width: 160,
          },
          {
            type: "maildock-image",
            version: 1,
            url: `${trapOrigin}/signature-tracker`,
            alt: "Signature remote",
            width: 160,
          },
        );
        res.end(
          JSON.stringify({
            richDocument,
            attachments: [
              {
                id,
                kind: "staged",
                inline: true,
                visible: false,
                filename: "signature.png",
                type: "image/png",
                size: String(png.length),
                status: "ready",
                error: null,
              },
            ],
          }),
        );
        return;
      }
      if (req.url === "/api/attachments/staged") {
        const filename = decodeURIComponent(
          String(req.headers["x-attachment-filename"]),
        );
        const inline = req.headers["x-attachment-disposition"] === "inline";
        uploads.push({ filename, inline });
        if (filename === "fail.png") {
          res.statusCode = 413;
          res.end(JSON.stringify({ error: "Simulated oversized upload" }));
          return;
        }
        const id = `00000000-0000-4000-8000-${String(resourceCount++).padStart(12, "0")}`;
        resources.set(id, Buffer.concat(chunks));
        res.end(
          JSON.stringify({
            id,
            filename,
            type: req.headers["content-type"],
            size: String(Buffer.concat(chunks).length),
            status: "ready",
            error: null,
          }),
        );
        return;
      }
      if (req.method === "PATCH" || req.method === "POST") {
        const input = JSON.parse(Buffer.concat(chunks).toString());
        const richDocument = validateRichDocument(input.richDocument);
        const cids = new Map<string, string>(
          input.attachments
            .filter((a: { inline: boolean }) => a.inline)
            .map(
              (a: { id: string }) =>
                [a.id, `${a.id}@maildock.invalid`] as [string, string],
            ),
        );
        saved = {
          ...saved,
          ...input,
          richDocument,
          plainText: serializeRichDocument(richDocument, cids).plainText,
          revision: Number(saved.revision) + 1,
          attachments: input.attachments.map(
            (a: { id: string; inline: boolean }) => ({
              ...a,
              kind: "draft",
              filename: a.inline ? "screen.png" : "file.pdf",
              type: a.inline ? "image/png" : "application/pdf",
              size: "68",
              status: "ready",
              error: null,
              visible: !a.inline,
            }),
          ),
        };
      }
      res.end(JSON.stringify(saved));
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'nonce-compose-test'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'",
    );
    res.end(
      `<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head><body><div id="app"></div><script nonce="compose-test">window.initialDraft=${JSON.stringify(saved).replace(/</g, "\\u003c")}</script><script nonce="compose-test" src="/bundle.js"></script></body></html>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const context = await browser.newContext();
  const requests: string[] = [],
    errors: string[] = [];
  context.on("request", (request) => {
    if (!request.url().startsWith(origin)) requests.push(request.url());
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  async function waitSaved(predicate: () => boolean) {
    const deadline = Date.now() + 8000;
    while (!predicate()) {
      if (Date.now() >= deadline) {
        assert.fail(
          `Composer did not persist the expected change: ${JSON.stringify({
            errors,
            alerts: await page.getByRole("alert").allTextContents(),
            html: await page
              .getByRole("textbox", { name: "Message body", exact: true })
              .innerHTML(),
          })}`,
        );
      }
      await page.waitForTimeout(50);
    }
  }
  const inlineCount = () =>
    (saved.attachments as { inline: boolean }[]).filter((a) => a.inline).length;
  try {
    await page.goto(origin);
    const body = page.getByRole("textbox", {
      name: "Message body",
      exact: true,
    });
    await body.waitFor();
    await page.waitForTimeout(1200);
    assert.deepEqual(requests, [], "Reply quote caused third-party requests");
    assert.equal(await page.locator('img[src^="http"]').count(), 0);
    await body.click();
    await page.keyboard.press("Control+Home");
    await page.keyboard.press("Control+b");
    await page.keyboard.type("Browser bold text");
    await page.keyboard.press("Control+b");
    await waitSaved(() =>
      String(saved.plainText).includes("Browser bold text"),
    );
    assert(
      serializeRichDocument(saved.richDocument, new Map()).html.includes(
        "<strong>Browser bold text</strong>",
      ),
      JSON.stringify({
        html: serializeRichDocument(saved.richDocument).html,
        errors,
        alerts: await page.getByRole("alert").allTextContents(),
        body: await body.innerHTML(),
        save: await page.locator(".composer-save-status").textContent(),
      }),
    );
    await page.keyboard.press("Control+Home");
    // Browser line-selection keys depend on caret focus after an autosave.
    // Set a real DOM range so this check exercises the link command deterministically.
    await body.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element.querySelector("strong")!);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    await page.waitForFunction(
      () => window.getSelection()?.toString() === "Browser bold text",
    );
    page.once("dialog", (dialog) => void dialog.accept("https://example.com/"));
    await page.keyboard.press("Control+k");
    await waitSaved(() =>
      String(saved.plainText).includes("<https://example.com/>"),
    );
    page.once(
      "dialog",
      (dialog) => void dialog.accept("https://example.com/edited"),
    );
    await page.keyboard.press("Control+k");
    await waitSaved(() =>
      String(saved.plainText).includes("<https://example.com/edited>"),
    );
    page.once("dialog", (dialog) => void dialog.accept(""));
    await page.keyboard.press("Control+k");
    await waitSaved(
      () => !String(saved.plainText).includes("<https://example.com/edited>"),
    );
    await page.keyboard.press("ArrowRight");
    const hostile = `<p style="color:#ff0000;background:url(${trapOrigin}/paste-css)"><b>Safe paste</b><a href="javascript:alert(1)">bad link</a><img src="${trapOrigin}/paste-tracker" onerror="alert(1)"></p><iframe src="${trapOrigin}/paste-frame"></iframe><script>alert(1)</script><table><tr><td>Table paste</td></tr></table>`;
    await body.evaluate((element, html) => {
      const data = new DataTransfer();
      data.setData("text/html", html);
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: data,
        }),
      );
    }, hostile);
    await waitSaved(() => String(saved.plainText).includes("Safe paste"));
    let html = serializeRichDocument(saved.richDocument).html;
    assert(
      html.includes("Safe paste"),
      JSON.stringify({
        html,
        errors,
        alerts: await page.getByRole("alert").allTextContents(),
        body: await body.innerHTML(),
        save: await page.locator(".composer-save-status").textContent(),
      }),
    );
    assert(html.includes("<table"));
    assert(!html.includes("javascript:"));
    assert.deepEqual(requests, [], "Rich paste caused third-party requests");
    await body.evaluate((element, html) => {
      const data = new DataTransfer();
      data.setData("text/html", html.replace("Safe paste", "Safe drag"));
      element.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: data,
        }),
      );
    }, hostile);
    await waitSaved(() => String(saved.plainText).includes("Safe drag"));
    assert.deepEqual(
      requests,
      [],
      "Rich HTML drag caused third-party requests",
    );
    page.once(
      "dialog",
      (dialog) => void dialog.accept(`${trapOrigin}/explicit-image-url`),
    );
    await page
      .getByRole("button", { name: "Image from URL", exact: true })
      .click();
    await waitSaved(() =>
      JSON.stringify(saved.richDocument).includes(
        `${trapOrigin}/explicit-image-url`,
      ),
    );
    assert(
      serializeRichDocument(saved.richDocument).html.includes(
        `${trapOrigin}/explicit-image-url`,
      ),
    );
    assert.deepEqual(
      requests,
      [],
      "Explicit image URL triggered an unexpected preview request",
    );
    const encoded = png.toString("base64");
    await body.evaluate((element, base64) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], "screen.png", { type: "image/png" }));
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: data,
        }),
      );
    }, encoded);
    await waitSaved(() => inlineCount() === 1);
    assert(uploads.some((a) => a.filename === "screen.png" && a.inline));
    const drop = async (selector: string, name: string, type: string) =>
      page.locator(selector).evaluate(
        (element, { name, type, base64 }) => {
          const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
          const data = new DataTransfer();
          data.items.add(new File([bytes], name, { type }));
          element.dispatchEvent(
            new DragEvent("drop", {
              bubbles: true,
              cancelable: true,
              dataTransfer: data,
            }),
          );
        },
        { name, type, base64: encoded },
      );
    await drop(".rich-editor-container", "dropped.png", "image/png");
    await waitSaved(() => inlineCount() === 2);
    await drop(".composer-attachments", "attached.png", "image/png");
    await waitSaved(() => (saved.attachments as unknown[]).length === 3);
    await drop(".rich-editor-container", "document.pdf", "application/pdf");
    await waitSaved(() => (saved.attachments as unknown[]).length === 4);
    assert.deepEqual(
      uploads.map((a) => [a.filename, a.inline]),
      [
        ["screen.png", true],
        ["dropped.png", true],
        ["attached.png", false],
        ["document.pdf", false],
      ],
    );
    const associations = saved.attachments as { id: string; inline: boolean }[];
    html = serializeRichDocument(
      saved.richDocument,
      new Map(
        associations
          .filter((a) => a.inline)
          .map((a) => [a.id, `${a.id}@maildock.invalid`]),
      ),
    ).html;
    assert(html.includes("cid:"));
    assert(!JSON.stringify(saved.richDocument).match(/base64|blob:/));
    const restored = saved;
    await page.reload();
    await body.waitFor();
    await page.waitForTimeout(1200);
    assert.deepEqual(saved.richDocument, restored.richDocument);
    assert.equal(await page.locator(".compose-image img").count(), 2);
    await page
      .getByRole("button", { name: "Select image: screen.png", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Remove image", exact: true })
      .click();
    await waitSaved(() => inlineCount() === 1);
    assert.equal(
      (saved.attachments as { inline: boolean }[]).filter((a) => a.inline)
        .length,
      1,
    );
    await drop(".rich-editor-container", "fail.png", "image/png");
    await page.waitForTimeout(200);
    assert(
      (await page.getByRole("alert").allTextContents()).some((text) =>
        text.includes("oversized"),
      ),
    );
    assert.equal(
      (saved.attachments as unknown[]).length,
      associations.length - 1,
    );
    signatureCatalog = {
      signatures: [
        { id: signatureId, name: "NMI" },
        { id: otherSignatureId, name: "Private" },
      ],
      defaults: {
        [accountId]: {
          new: signatureId,
          reply: signatureId,
          forward: signatureId,
        },
        [otherAccountId]: {
          new: otherSignatureId,
          reply: otherSignatureId,
          forward: otherSignatureId,
        },
      },
    };
    await page.evaluate(() =>
      (window as unknown as { renderCompose: () => void }).renderCompose(),
    );
    await waitSaved(() => String(saved.plainText).includes("NMI signature"));
    assert.deepEqual(
      (saved.richDocument as RichDocument).editor.root.children!.map(
        (n) => n.type,
      ),
      ["paragraph", "maildock-signature"],
    );
    assert.equal(await page.locator(".compose-image img").count(), 1);
    assert(
      (await body.textContent())!.includes(
        "Remote image (preview blocked): Signature remote",
      ),
    );
    await page.getByLabel("From", { exact: true }).selectOption(otherAccountId);
    await waitSaved(() =>
      String(saved.plainText).includes("Private signature"),
    );
    assert(!String(saved.plainText).includes("NMI signature"));
    await page.getByLabel("From", { exact: true }).selectOption(accountId);
    await waitSaved(() => String(saved.plainText).includes("NMI signature"));
    await body.getByText("NMI signature", { exact: true }).click();
    await page.keyboard.press("Home");
    await page.keyboard.insertText("Edited ");
    await waitSaved(() =>
      String(saved.plainText).includes("Edited NMI signature"),
    );
    await page.getByLabel("From", { exact: true }).selectOption(otherAccountId);
    await waitSaved(() => saved.accountId === otherAccountId);
    assert(String(saved.plainText).includes("Edited NMI signature"));
    assert(!String(saved.plainText).includes("Private signature"));
    await body.locator("p").first().click();
    await page
      .getByRole("button", { name: "Insert signature", exact: true })
      .click();
    await page.getByRole("button", { name: "Private", exact: true }).click();
    await waitSaved(() =>
      String(saved.plainText).includes("Private signature"),
    );
    assert.equal(
      (saved.richDocument as RichDocument).editor.root.children!.filter(
        (n) => n.type === "maildock-signature",
      ).length,
      1,
    );
    await page.getByLabel("From", { exact: true }).selectOption(accountId);
    await waitSaved(() => saved.accountId === accountId);
    assert(String(saved.plainText).includes("Private signature"));
    assert(String(saved.plainText).includes("Edited NMI signature"));
    const signatureDraft = saved;
    signatureCatalog.signatures = [];
    signatureCatalog.defaults = {};
    await page.reload();
    await body.waitFor();
    await page.waitForTimeout(1200);
    assert.deepEqual(saved.richDocument, signatureDraft.richDocument);
    assert.equal(await page.locator(".compose-image img").count(), 2);
    // A deleted template never participates in reopening its durable copies.
    await page
      .getByRole("button", { name: "Insert signature", exact: true })
      .click();
    assert(
      (await page
        .getByRole("group", { name: "Choose signature" })
        .textContent())!.includes("No signatures yet"),
    );
    signatureCatalog = {
      signatures: [{ id: signatureId, name: "NMI" }],
      defaults: {
        [accountId]: {
          new: signatureId,
          reply: signatureId,
          forward: signatureId,
        },
      },
    };
    for (const mode of ["reply", "reply_all", "forward"] as const) {
      const doc: RichDocument = {
        version: 1,
        editor: {
          root: richElement("root", [
            richElement("paragraph", []),
            ...plainTextDocument("Original header").editor.root.children!,
            richElement(
              "quote",
              plainTextDocument("Original body").editor.root.children!,
            ),
          ]),
        },
      };
      await page.evaluate(
        ({ mode, doc, accountId, draftId, otherAccountId }) => {
          (
            window as unknown as {
              renderCompose: (draft: undefined, prefill: unknown) => void;
            }
          ).renderCompose(undefined, {
            accountId,
            to: "to@example.com",
            cc: "",
            subject: mode,
            plainText: "",
            richDocument: doc,
            source: {
              mode,
              accountId,
              mailboxId: draftId,
              messageId: otherAccountId,
            },
            attachments: [],
            attachmentsOmitted: false,
          });
        },
        { mode, doc, accountId, draftId, otherAccountId },
      );
      await waitSaved(
        () =>
          (saved.source as { mode?: string })?.mode === mode &&
          String(saved.plainText).includes("NMI signature"),
      );
      assert.deepEqual(
        (saved.richDocument as RichDocument).editor.root.children!.map(
          (n) => n.type,
        ),
        ["paragraph", "maildock-signature", "paragraph", "quote"],
      );
    }
    assert.deepEqual(requests, []);
    assert.deepEqual(errors, []);
    await mkdir(".security-results", { recursive: true });
    await page.screenshot({
      path: ".security-results/compose.png",
      fullPage: true,
    });
    return {
      thirdPartyRequests: requests,
      editorErrors: errors,
      verified: [
        "quoted remote privacy",
        "bold shortcut",
        "link insert/edit/remove shortcut",
        "hostile rich paste",
        "hostile rich HTML drag",
        "pasted table",
        "clipboard image",
        "inline image drop",
        "attachment area image drop",
        "PDF drop",
        "durable draft restore",
        "remote image URL without preview",
        "inline image removal",
        "failed image upload",
        "signature New/Reply/Reply All/Forward placement",
        "signature CID and blocked remote preview",
        "automatic signature account replacement",
        "edited/manual signature preservation",
        "signature draft reopen after template deletion",
        "signature selector and empty indication",
      ],
    };
  } finally {
    await context.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
