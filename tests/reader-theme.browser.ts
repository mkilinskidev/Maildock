import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AttachmentList } from "../src/components/attachment-list";
import type { AttachmentView } from "../src/modules/mail/domain/attachments";
import { sanitizeEmailHtml } from "../src/modules/mail/infrastructure/sanitize-email-html";
import { renderEmailDocument } from "../src/modules/mail/infrastructure/render-email-document";

const css = await readFile("src/app/styles.css", "utf8");
const samples = [
  [
    '<table bgcolor="white"><tr><td><p>Missing text color</p></td></tr></table>',
    "p",
    "rgb(32, 36, 43)",
  ],
  [
    '<style>@media(prefers-color-scheme:dark){p{color:white}}</style><div style="background-color:white"><p>Partial dark styling</p></div>',
    "p",
    "rgb(32, 36, 43)",
  ],
  [
    '<p style="color:#123456;background-color:#ffeeee">Explicit colors</p>',
    "p",
    "rgb(18, 52, 86)",
  ],
  [
    '<div style="color:#ffffff;background-color:#111111"><p>Dark sender background</p><b style="color:#ffff00">Mixed formatting</b></div>',
    "p",
    "rgb(255, 255, 255)",
  ],
  [
    '<div style="color:#ffffff;background-color:#111111"><p>Dark sender background</p><b style="color:#ffff00">Mixed formatting</b></div>',
    "b",
    "rgb(255, 255, 0)",
  ],
  [
    '<p style="color:initial;background-color:white">Initial system text color</p>',
    "p",
    "rgb(0, 0, 0)",
  ],
] as const;
const browser = await chromium.launch({ headless: true });
try {
  for (const theme of ["light", "dark"] as const) {
    const context = await browser.newContext({ colorScheme: theme });
    await context.route("**/*", (route) => route.abort());
    const page = await context.newPage();
    for (const [html, selector, color] of samples) {
      const clean = sanitizeEmailHtml(html).html;
      const document = renderEmailDocument(clean, false);
      await page.setContent(
        `<html data-theme="${theme}"><head><style>${css}</style></head><body><div class="mail-body"><iframe title="Email content" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer"></iframe></div></body></html>`,
      );
      await page.locator("iframe").evaluate((frame, html) => {
        (frame as HTMLIFrameElement).srcdoc = html;
      }, document);
      const frame = page.frames()[1];
      await frame.waitForSelector(selector);
      assert.equal(
        await frame
          .locator(selector)
          .evaluate((element) => getComputedStyle(element).color),
        color,
        `${theme}: ${selector}`,
      );
      assert.equal(
        await frame
          .locator("html")
          .evaluate((element) => getComputedStyle(element).backgroundColor),
        "rgb(255, 255, 255)",
      );
      assert.match(
        (await frame.locator("meta[http-equiv]").getAttribute("content"))!,
        /script-src 'none'/,
      );
      assert.equal(clean, sanitizeEmailHtml(html).html);
    }
    const filename = "long-file-name-without-spaces-".repeat(20) + ".pdf";
    const markup = renderToStaticMarkup(
      createElement(AttachmentList, {
        attachments: [
          {
            id: "fixture",
            filename,
            size: "1536",
            type: "application/pdf",
            status: "ready",
            visible: true,
            error: null,
          } as AttachmentView,
        ],
      }),
    );
    for (const width of [320, 1000]) {
      await page.setViewportSize({ width, height: 800 });
      await page.setContent(
        `<html data-theme="${theme}"><style>${css}</style><body>${markup}</body></html>`,
      );
      const chip = page.locator(".attachment-download");
      assert((await chip.textContent())!.includes(filename));
      const bounds = await chip.boundingBox();
      assert(bounds && bounds.width <= width);
      assert.equal(
        await chip.evaluate(
          (element) => element.scrollWidth > element.clientWidth,
        ),
        false,
      );
      await page.keyboard.press("Tab");
      assert.equal(
        await chip.evaluate((element) => element === document.activeElement),
        true,
      );
      assert.equal(
        await chip.evaluate(
          (element) => getComputedStyle(element).outlineStyle,
        ),
        "solid",
      );
      assert.equal(
        await chip.getAttribute("href"),
        "/api/attachments/fixture/download",
      );
    }
    await context.close();
  }
  console.log(
    "PASS: 12 HTML readability cases and 4 responsive/keyboard attachment cases across light/dark themes.",
  );
} finally {
  await browser.close();
}
