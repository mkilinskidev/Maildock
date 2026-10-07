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
const recoveryCodes = [
  "abcde-12345",
  "fghij-67890",
  "klmno-23456",
  "pqrst-34567",
  "uvwxy-45678",
  "ABCDE-56789",
  "FGHIJ-67890",
  "KLMNO-78901",
  "PQRST-89012",
  "UVWXY-90123",
];
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
      const layout =
        request.url === "/replace-authenticator"
          ? '<main class="auth-page"><section class="auth-content"><div id="root"></div></section></main>'
          : '<main class="settings-shell"><header class="settings-header"><h1>Settings</h1><a class="button-link secondary" href="/mail">Back to mail</a></header><div class="settings-layout"><nav class="settings-nav" aria-label="Settings navigation"><div class="settings-nav-group"><h2>General</h2><button>Appearance</button><button aria-current="page">Security</button><button>Mail</button></div></nav><div class="settings-pane"><div id="root"></div></div></div></main>';
      response.end(
        '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css">' +
          layout +
          '<script src="/form.js"></script>',
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

it.each(["light", "dark"])(
  "Security cards and compact dialogs follow the %s theme at desktop widths",
  async (theme) => {
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
    });
    const page = await context.newPage();
    try {
      await page.goto(origin + "/settings");
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      expect(
        await page
          .getByRole("region", { name: "Authenticator", exact: true })
          .count(),
      ).toBe(1);
      expect(
        await page
          .getByRole("region", { name: "Recovery codes", exact: true })
          .getByText("Configured", { exact: true })
          .count(),
      ).toBe(1);
      expect(
        (await page.locator(".mfa-settings").boundingBox())!.width,
      ).toBeLessThanOrEqual(760);
      await page.screenshot({
        path: `.security-results/mfa-settings-${theme}-desktop.png`,
        fullPage: true,
      });
      await page
        .getByRole("button", { name: "Generate new recovery codes" })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Generate new recovery codes",
        exact: true,
      });
      expect(
        await dialog
          .getByText(
            "Your existing recovery codes will stop working immediately.",
          )
          .count(),
      ).toBe(1);
      const box = (await dialog.boundingBox())!;
      expect(box.width).toBeLessThanOrEqual(460);
      expect(
        (await page.getByLabel("Current password").boundingBox())!.width,
      ).toBeLessThan(420);
      expect(
        await dialog.evaluate(
          (element) => getComputedStyle(element).backgroundColor,
        ),
      ).toBe(theme === "dark" ? "rgb(27, 31, 39)" : "rgb(255, 255, 255)");
      await page.screenshot({
        path: `.security-results/mfa-settings-${theme}-dialog.png`,
        fullPage: true,
      });
    } finally {
      await context.close();
    }
  },
);

it("Cancel/Escape close without mutation, restore trigger focus and reset transient proof fields", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  let mutations = 0;
  await page.route("**/api/auth/mfa/manage/**", async (route) => {
    mutations++;
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      body: "{}",
    });
  });
  try {
    await page.goto(origin + "/settings");
    for (const action of [
      "Generate new recovery codes",
      "Replace authenticator",
    ]) {
      const trigger = page.getByRole("button", { name: action, exact: true });
      await trigger.focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: action, exact: true });
      await dialog.waitFor();
      expect(
        await page
          .getByLabel("Current password")
          .evaluate((element) => document.activeElement === element),
      ).toBe(true);
      await page.getByLabel("Current authenticator code").fill("123456");
      await page.getByLabel("Verification method").selectOption("recovery");
      expect(await page.getByLabel("Current recovery code").inputValue()).toBe(
        "",
      );
      await page.getByLabel("Current recovery code").fill("abcde-12345");
      await page.getByLabel("Verification method").selectOption("totp");
      expect(
        await page.getByLabel("Current authenticator code").inputValue(),
      ).toBe("");
      // Native showModal makes the background inert and keeps tab navigation
      // from selecting any Settings/sidebar controls.
      for (let i = 0; i < 10; i++) {
        await page.keyboard.press("Tab");
        expect(
          await page.evaluate(
            () =>
              document.activeElement === document.body ||
              Boolean(document.activeElement?.closest("dialog")),
          ),
        ).toBe(true);
      }
      await page.keyboard.press("Escape");
      expect(await page.getByRole("dialog").count()).toBe(0);
      expect(
        await trigger.evaluate((element) => document.activeElement === element),
      ).toBe(true);
      await trigger.click();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(await page.getByRole("dialog").count()).toBe(0);
      expect(
        await trigger.evaluate((element) => document.activeElement === element),
      ).toBe(true);
    }
    expect(mutations).toBe(0);
    await ephemeral(page);
  } finally {
    await context.close();
  }
});

it("pending regeneration cannot be dismissed; desktop codes form a two-column five-row group until explicit Done", async () => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  let release!: () => void;
  let requested = false;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    "**/api/auth/mfa/manage/recovery/regenerate",
    async (route) => {
      requested = true;
      await wait;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ recoveryCodes }),
      });
    },
  );
  try {
    await page.goto(origin + "/settings");
    await page
      .getByRole("button", { name: "Generate new recovery codes" })
      .click();
    await page.getByLabel("Current password").fill("owner password 123");
    await page.getByLabel("Current authenticator code").fill("123456");
    await page
      .getByRole("button", { name: "Generate codes", exact: true })
      .click();
    await page.getByLabel("Current password").waitFor({ state: "visible" });
    expect(await page.getByLabel("Current password").isDisabled()).toBe(true);
    await page.keyboard.press("Escape");
    await page.mouse.click(2, 2);
    expect(await page.getByRole("dialog").isVisible()).toBe(true);
    expect(requested).toBe(true);
    release();
    const dialog = page.getByRole("dialog", {
      name: "Save your new recovery codes",
    });
    await dialog.waitFor();
    const grid = dialog.locator(".mfa-code-grid");
    expect(await grid.locator("code").allTextContents()).toEqual(recoveryCodes);
    expect(
      await grid.evaluate(
        (element) =>
          getComputedStyle(element).gridTemplateColumns.split(" ").length,
      ),
    ).toBe(2);
    expect(
      await grid.evaluate(
        (element) =>
          new Set(
            [...element.children].map(
              (child) => child.getBoundingClientRect().top,
            ),
          ).size,
      ),
    ).toBe(5);
    expect(
      await dialog
        .getByRole("heading")
        .evaluate((element) => document.activeElement === element),
    ).toBe(true);
    await page.keyboard.press("Escape");
    expect(await dialog.isVisible()).toBe(true);
    await page.screenshot({
      path: ".security-results/mfa-settings-codes-desktop.png",
      fullPage: true,
    });
    await ephemeral(page);
    await dialog.getByRole("button", { name: "Done" }).focus();
    await page.keyboard.press("Enter");
    expect(await page.getByRole("dialog").count()).toBe(0);
  } finally {
    release();
    await context.close();
  }
});

it.each(["light", "dark"])(
  "narrow %s controls fit and failed proof retains generic errors without storing credentials",
  async (theme) => {
    const context = await browser.newContext({
      viewport: { width: 320, height: 640 },
    });
    const page = await context.newPage();
    await page.route(
      "**/api/auth/mfa/manage/recovery/regenerate",
      async (route) => {
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({
            error: "MFA management could not be completed.",
          }),
        });
      },
    );
    try {
      await page.goto(origin + "/settings");
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      await page
        .getByRole("button", { name: "Generate new recovery codes" })
        .click();
      await page.getByLabel("Current password").fill("owner password 123");
      await page.getByLabel("Current authenticator code").fill("123456");
      await page
        .getByRole("button", { name: "Generate codes", exact: true })
        .click();
      await page.getByRole("alert").waitFor();
      expect(await page.getByRole("alert").textContent()).toBe(
        "MFA management could not be completed. Check your details and try again.",
      );
      expect(await page.getByLabel("Current password").inputValue()).toBe("");
      expect(
        await page.getByLabel("Current authenticator code").inputValue(),
      ).toBe("");
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const dialog = page.getByRole("dialog");
      expect(
        await dialog.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `.security-results/mfa-settings-${theme}-mobile.png`,
        fullPage: true,
      });
      await ephemeral(page);
    } finally {
      await context.close();
    }
  },
);
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
    expect(
      await page
        .getByRole("region", { name: "Authenticator", exact: true })
        .getByText("Enabled", { exact: true })
        .count(),
    ).toBe(1);
    expect(
      await page
        .getByRole("button", { name: /disable|trusted|show existing/i })
        .count(),
    ).toBe(0);
    await page
      .getByRole("button", { name: "Generate new recovery codes" })
      .click();
    await page.getByLabel("Current password").fill("owner password 123");
    await page.getByLabel("Verification method").selectOption("recovery");
    await page
      .getByLabel("Current recovery code", { exact: true })
      .fill("abcde-12345");
    await page
      .getByRole("button", { name: "Generate codes", exact: true })
      .click();
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
    const dialog = page.getByRole("dialog", {
      name: "Save your new recovery codes",
    });
    expect(
      await dialog.locator(".mfa-code-grid code").allTextContents(),
    ).toEqual(recoveryCodes);
    expect(
      await dialog
        .locator(".mfa-code-grid")
        .evaluate(
          (element) =>
            getComputedStyle(element).gridTemplateColumns.split(" ").length,
        ),
    ).toBe(1);
    await page.keyboard.press("Escape");
    expect(await dialog.isVisible()).toBe(true);
    await page.mouse.click(2, 2);
    expect(await dialog.isVisible()).toBe(true);
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
    await page.getByRole("button", { name: "Done", exact: true }).click();
    expect(await page.getByRole("dialog").count()).toBe(0);
    expect(await page.locator(".mfa-code-grid").count()).toBe(0);
    expect(
      await page
        .getByRole("button", { name: "Generate new recovery codes" })
        .evaluate((element) => document.activeElement === element),
    ).toBe(true);
    await page
      .getByRole("button", { name: "Generate new recovery codes" })
      .click();
    expect(await page.locator(".mfa-code-grid").count()).toBe(0);
    expect(await page.getByLabel("Current password").inputValue()).toBe("");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
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
    const dialog = page.getByRole("dialog", {
      name: "Replace authenticator",
      exact: true,
    });
    expect(
      await dialog.getByText(/all sessions will be signed out/).count(),
    ).toBe(1);
    await page.getByLabel("Current password").fill("owner password 123");
    await page
      .getByLabel("Current authenticator code", { exact: true })
      .fill("123456");
    await dialog
      .getByRole("button", { name: "Replace authenticator", exact: true })
      .click();
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
