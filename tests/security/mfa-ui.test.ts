import { createServer, type Server } from "node:http";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { readFile, mkdir } from "node:fs/promises";

// Actual React forms and local QR renderer in Chromium. Backend authority is
// exercised separately by the real Better Auth/PostgreSQL integration suite.
let server: Server;
let browser: Browser;
let origin: string;
let script: string;
const manualSecret = "JBSWY3DPEHPK3PXP";
const totpURI = `otpauth://totp/Maildock:owner?secret=${manualSecret}&issuer=Maildock`;
const recoveryCodes = ["abcde-12345", "fghij-67890"];

beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {InitialMfaForm} from './src/components/initial-mfa-form'; import {LoginForm} from './src/components/login-form'; import {OwnerRecoveryEnrollment} from './src/components/owner-recovery-enrollment'; createRoot(document.getElementById('root')).render(location.pathname === '/owner-recovery-mfa' ? <OwnerRecoveryEnrollment/> : location.pathname === '/initial-mfa' ? <InitialMfaForm/> : <LoginForm/>);`,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  script = result.outputFiles[0].text;
  const css = await readFile("src/app/styles.css", "utf8");
  server = createServer((request, response) => {
    if (request.url === "/form.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(script);
    } else if (request.url === "/styles.css") {
      response.setHeader("Content-Type", "text/css");
      response.end(css);
    } else {
      response.setHeader("Content-Type", "text/html");
      response.setHeader("Cache-Control", "no-store");
      response.end(
        '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"><main class="auth-page"><section class="auth-content"><h1>Maildock</h1><div id="root"></div></section></main><script src="/form.js"></script>',
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No browser test address");
  origin = `http://127.0.0.1:${address.port}`;
  await mkdir(".security-results", { recursive: true });
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
});

async function opened(path: string) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  const external: string[] = [];
  page.on("request", (request) => {
    if (!request.url().startsWith(origin)) external.push(request.url());
  });
  await page.goto(origin + path);
  return { context, page, external };
}
async function ephemeral(page: Page, secrets: string[]) {
  const persisted = await page.evaluate(() =>
    JSON.stringify({
      local: { ...localStorage },
      session: { ...sessionStorage },
      cookie: document.cookie,
      url: location.href,
    }),
  );
  for (const secret of secrets) expect(persisted).not.toContain(secret);
}

it("CLI-recovered password login leads only to controlled enrollment and fresh login; secrets stay ephemeral", async () => {
  const { context, page, external } = await opened("/login");
  const calls: { path: string; body: unknown }[] = [];
  await page.route("**/api/auth/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    calls.push({ path, body: route.request().postDataJSON() });
    await route.fulfill({
      contentType: "application/json",
      headers: { "Cache-Control": "no-store" },
      body: JSON.stringify(
        path.endsWith("/username")
          ? { ownerRecoveryRequired: true }
          : path.endsWith("/resume")
            ? { totpURI }
            : { completed: true, freshLoginRequired: true, recoveryCodes },
      ),
    });
  });
  try {
    await page.getByLabel("Username").fill("owner");
    await page
      .getByLabel("Password", { exact: true })
      .fill("Recovered password!");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL(origin + "/owner-recovery-mfa");
    await page
      .getByRole("button", { name: "Show authenticator setup" })
      .click();
    await page.getByLabel("Authenticator setup QR code").waitFor();
    expect(await page.locator(".mfa-secret").textContent()).toBe(manualSecret);
    expect(await page.locator("img, svg image").count()).toBe(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await ephemeral(page, ["Recovered password!", totpURI, manualSecret]);
    await page.getByLabel("Authenticator code").fill("123456");
    await page.getByRole("button", { name: "Verify authenticator" }).click();
    await page
      .getByRole("heading", { name: "Save your recovery codes" })
      .waitFor();
    expect(calls.at(-1)).toEqual({
      path: "/api/auth/owner-recovery/complete",
      body: { code: "123456" },
    });
    expect(await page.locator("svg, input, .mfa-secret").count()).toBe(0);
    await ephemeral(page, [totpURI, manualSecret, ...recoveryCodes]);
    await page.getByRole("link", { name: "I saved my codes" }).click();
    await page.waitForURL(origin + "/login");
    expect(await page.locator(".mfa-recovery-codes").count()).toBe(0);
    expect(external).toEqual([]);
  } finally {
    await context.close();
  }
});
it("recovery enrollment errors expose no server detail or codes and cancel returns to login", async () => {
  const { context, page } = await opened("/owner-recovery-mfa");
  await page.route("**/api/auth/owner-recovery/*", async (route) => {
    const cancel = route.request().url().endsWith("/cancel");
    await route.fulfill({
      status: cancel ? 200 : 401,
      contentType: "application/json",
      body: JSON.stringify(
        cancel
          ? { cancelled: true }
          : { error: "Secret internal detail", recoveryCodes },
      ),
    });
  });
  try {
    await page
      .getByRole("button", { name: "Show authenticator setup" })
      .click();
    await page.getByRole("alert").waitFor();
    expect(await page.locator("body").textContent()).not.toContain(
      "Secret internal detail",
    );
    expect(await page.locator("svg, .mfa-recovery-codes").count()).toBe(0);
    await page.getByRole("button", { name: "Cancel enrollment" }).click();
    await page.waitForURL(origin + "/login");
  } finally {
    await context.close();
  }
});

it("enrollment locally renders QR/manual key; reload requires renewed bootstrap/password; codes disappear on navigation", async () => {
  const { context, page, external } = await opened("/initial-mfa");
  const bootstrap = "b".repeat(44),
    password = "owner password 123";
  const bodies: { path: string; input: unknown }[] = [];
  await page.route("**/api/auth/initial-mfa/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    bodies.push({ path, input: route.request().postDataJSON() });
    await route.fulfill({
      contentType: "application/json",
      headers: { "Cache-Control": "no-store" },
      body: JSON.stringify(
        path.endsWith("/start")
          ? { totpURI, resumed: bodies.length > 1 }
          : { completed: true, freshLoginRequired: true, recoveryCodes },
      ),
    });
  });
  try {
    const start = async () => {
      await page.getByLabel("Setup secret", { exact: true }).fill(bootstrap);
      await page.getByLabel("Owner password").fill(password);
      await page.getByRole("button", { name: "Start or resume setup" }).click();
      await page.getByLabel("Authenticator setup QR code").waitFor();
    };
    await start();
    await page.screenshot({
      path: ".security-results/mfa-enrollment-preview.png",
      fullPage: true,
    });
    expect(await page.locator(".mfa-secret").textContent()).toBe(
      new URL(totpURI).searchParams.get("secret"),
    );
    expect(await page.locator("svg path").count()).toBeGreaterThan(0);
    expect(await page.locator("img, svg image").count()).toBe(0);
    await ephemeral(page, [bootstrap, password, totpURI, manualSecret]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.reload();
    expect(
      await page.getByLabel("Setup secret", { exact: true }).inputValue(),
    ).toBe("");
    expect(await page.locator("svg").count()).toBe(0);
    await start();
    await page.getByLabel("Authenticator code").fill("123456");
    await page.getByRole("button", { name: "Confirm authenticator" }).click();
    await page
      .getByRole("heading", { name: "Save your recovery codes" })
      .waitFor();
    expect(bodies.at(-1)?.input).toEqual({
      bootstrapSecret: bootstrap,
      code: "123456",
    });
    expect(await page.locator(".mfa-recovery-codes").textContent()).toBe(
      recoveryCodes.join("\n"),
    );
    expect(await page.locator("svg, .mfa-secret, input").count()).toBe(0);
    await page.screenshot({
      path: ".security-results/mfa-recovery-preview.png",
      fullPage: true,
    });
    await ephemeral(page, [bootstrap, totpURI, manualSecret, ...recoveryCodes]);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.getByRole("button", { name: "Copy all codes" }).click();
    await page.getByRole("button", { name: "Copied", exact: true }).waitFor();
    // Windows clipboard normalizes line endings to CRLF.
    expect(
      (await page.evaluate(() => navigator.clipboard.readText())).replaceAll(
        "\r\n",
        "\n",
      ),
    ).toBe(recoveryCodes.join("\n"));
    await page.getByRole("button", { name: "Continue to login" }).click();
    await page.waitForURL(origin + "/login");
    expect(await page.locator(".mfa-recovery-codes").count()).toBe(0);
    expect(external).toEqual([]);
  } finally {
    await context.close();
  }
});

it("login switches between password/TOTP/recovery, keeps generic errors, cancels and restarts expired challenges", async () => {
  const { context, page } = await opened("/login");
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let expired = false;
  await page.route("**/api/auth/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    calls.push({ path, body: route.request().postDataJSON() });
    const password = path.endsWith("/username"),
      cancel = path.endsWith("/cancel");
    await route.fulfill({
      status: password || cancel ? 200 : 401,
      contentType: "application/json",
      body: JSON.stringify(
        password
          ? { twoFactorRedirect: true }
          : cancel
            ? { cancelled: true }
            : {
                error: "Internal detail must not be rendered",
                restart: expired,
              },
      ),
    });
  });
  try {
    const signIn = async () => {
      await page.getByLabel("Username").fill("owner-01");
      await page
        .getByLabel("Password", { exact: true })
        .fill("owner password 123");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.getByLabel("Authenticator code").waitFor();
    };
    await signIn();
    expect(await page.locator('input[type="password"]').count()).toBe(0);
    await page.getByLabel("Authenticator code").fill("123456");
    await page.getByRole("button", { name: "Verify", exact: true }).click();
    await page.getByRole("alert").waitFor();
    expect(await page.getByRole("alert").textContent()).not.toContain(
      "Internal detail",
    );
    expect(calls.at(-1)?.body).toEqual({ code: "123456" });
    await page.getByRole("button", { name: "Use a recovery code" }).click();
    await page
      .getByLabel("Recovery code", { exact: true })
      .fill(recoveryCodes[0]);
    await page.getByRole("button", { name: "Verify", exact: true }).click();
    await page.getByRole("alert").waitFor();
    expect(calls.at(-1)?.body).toEqual({ code: recoveryCodes[0] });
    await ephemeral(page, ["owner password 123", "123456", ...recoveryCodes]);
    await page.getByRole("button", { name: "Use authenticator code" }).click();
    expect(await page.getByLabel("Authenticator code").inputValue()).toBe("");
    await page.getByRole("button", { name: "Back to password" }).click();
    await page.getByLabel("Password", { exact: true }).waitFor();
    expect(calls.at(-1)).toEqual({ path: "/api/auth/mfa/cancel", body: {} });
    expired = true;
    await signIn();
    await page.getByLabel("Authenticator code").fill("123456");
    await page.getByRole("button", { name: "Verify", exact: true }).click();
    await page.getByLabel("Password", { exact: true }).waitFor();
    expect(await page.getByRole("alert").textContent()).toBe(
      "Please sign in again.",
    );
  } finally {
    await context.close();
  }
});
