import { createServer, type Server } from "node:http";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, it } from "vitest";

let server: Server;
let browser: Browser;
let origin: string;
const totpURI =
  "otpauth://totp/Maildock:owner?secret=JBSWY3DPEHPK3PXP&issuer=Maildock";
const recoveryCodes = ["abcde-12345", "fghij-67890"];
beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {MfaManagement,ReplacementEnrollment} from './src/components/mfa-management'; createRoot(document.getElementById('root')).render(location.pathname === '/replace-authenticator' ? <ReplacementEnrollment/> : <MfaManagement/>);`,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const script = result.outputFiles[0].text;
  const css = await readFile("src/app/styles.css", "utf8");
  server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (request.url === "/form.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(script);
    } else if (request.url === "/styles.css") {
      response.setHeader("Content-Type", "text/css");
      response.end(css);
    } else {
      response.setHeader("Content-Type", "text/html");
      response.end(
        '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"><main class="auth-page"><section class="auth-content"><div id="root"></div></section></main><script src="/form.js"></script>',
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing address");
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
});
async function ephemeral(page: Page) {
  const stored = await page.evaluate(() =>
    JSON.stringify({
      local: { ...localStorage },
      session: { ...sessionStorage },
      cookie: document.cookie,
      url: location.href,
    }),
  );
  for (const value of [
    totpURI,
    "JBSWY3DPEHPK3PXP",
    ...recoveryCodes,
    "owner password 123",
    "123456",
  ])
    expect(stored).not.toContain(value);
}

it("Settings requires password and selected current proof; codes copy once and clear on close/reload", async () => {
  const context = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  const bodies: unknown[] = [];
  await page.route(
    "**/api/auth/mfa/manage/recovery/regenerate",
    async (route) => {
      bodies.push(route.request().postDataJSON());
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ recoveryCodes }),
      });
    },
  );
  try {
    await page.goto(origin + "/settings");
    expect(await page.getByText("Authenticator: enabled").count()).toBe(1);
    expect(
      await page
        .getByRole("button", { name: /disable|trusted|show existing/i })
        .count(),
    ).toBe(0);
    await page
      .getByRole("button", { name: "Generate new recovery codes" })
      .click();
    await page.getByLabel("Owner password").fill("owner password 123");
    await page.getByLabel("Current MFA proof").selectOption("recovery");
    await page.getByLabel("Recovery code", { exact: true }).fill("abcde-12345");
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await page
      .getByRole("heading", { name: "Save your new recovery codes" })
      .waitFor();
    expect(bodies).toEqual([
      {
        password: "owner password 123",
        proofType: "recovery",
        proofCode: "abcde-12345",
      },
    ]);
    await page.getByRole("button", { name: "Copy all", exact: true }).click();
    expect(
      (await page.evaluate(() => navigator.clipboard.readText())).replaceAll(
        "\r\n",
        "\n",
      ),
    ).toBe(recoveryCodes.join("\n"));
    await ephemeral(page);
    await page.screenshot({
      path: ".security-results/mfa-management-recovery-preview.png",
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    expect(await page.locator(".mfa-recovery-codes").count()).toBe(0);
    await page.reload();
    expect(await page.locator(".mfa-recovery-codes").count()).toBe(0);
  } finally {
    await context.close();
  }
});

it("replacement locally renders new QR, resumes after reload, clears codes and requires fresh login", async () => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  const external: string[] = [];
  const paths: string[] = [];
  page.on("request", (request) => {
    if (!request.url().startsWith(origin)) external.push(request.url());
  });
  await page.route("**/api/auth/mfa/manage/authenticator/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    paths.push(path);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        path.endsWith("/resume")
          ? { totpURI }
          : { completed: true, freshLoginRequired: true, recoveryCodes },
      ),
    });
  });
  try {
    await page.goto(origin + "/replace-authenticator");
    await page.getByRole("button", { name: "Resume replacement" }).click();
    await page.getByLabel("New authenticator QR code").waitFor();
    expect(await page.locator("svg path").count()).toBeGreaterThan(0);
    expect(await page.locator("img, svg image").count()).toBe(0);
    await ephemeral(page);
    expect(external).toEqual([]);
    await page.screenshot({
      path: ".security-results/mfa-replacement-preview.png",
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.reload();
    expect(await page.locator(".mfa-secret").count()).toBe(0);
    await page.getByRole("button", { name: "Resume replacement" }).click();
    await page
      .getByLabel("New authenticator code", { exact: true })
      .fill("123456");
    await page
      .getByRole("button", { name: "Confirm new authenticator" })
      .click();
    await page
      .getByRole("heading", { name: "Save your new recovery codes" })
      .waitFor();
    expect(await page.locator(".mfa-secret").count()).toBe(0);
    await ephemeral(page);
    await page.getByRole("button", { name: "Continue to login" }).click();
    await page.waitForURL(origin + "/login");
    expect(await page.locator(".mfa-recovery-codes").count()).toBe(0);
    expect(paths.filter((path) => path.endsWith("/complete"))).toHaveLength(1);
  } finally {
    await context.close();
  }
});

it("Settings replacement warns of revocation and sends password/current TOTP before navigation", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  let body: unknown;
  await page.route(
    "**/api/auth/mfa/manage/authenticator/start",
    async (route) => {
      body = route.request().postDataJSON();
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ replacementStarted: true }),
      });
    },
  );
  try {
    await page.goto(origin + "/settings");
    await page
      .getByRole("button", { name: "Replace authenticator", exact: true })
      .click();
    expect(await page.getByText(/signs out all sessions/).count()).toBe(1);
    await page.getByLabel("Owner password").fill("owner password 123");
    await page.getByLabel("Authenticator code", { exact: true }).fill("123456");
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await page.waitForURL(origin + "/replace-authenticator");
    expect(body).toEqual({
      password: "owner password 123",
      proofType: "totp",
      proofCode: "123456",
    });
    await ephemeral(page);
  } finally {
    await context.close();
  }
});
