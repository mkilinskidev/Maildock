import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";

let server: Server;
let browser: Browser;
let page: Page;
let origin: string;
let submissions: Record<string, unknown>[];
const credentials = {
  bootstrapSecret: "a".repeat(44),
  username: "owner",
  password: "correct horse battery staple",
};

beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `import {createRoot} from 'react-dom/client'; import {SetupForm} from './src/components/setup-form'; createRoot(document.getElementById('root')).render(<SetupForm/>);`,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "setup-router",
        setup(builder) {
          builder.onResolve({ filter: /^next\/navigation$/ }, () => ({
            path: "router",
            namespace: "setup-test",
          }));
          builder.onLoad({ filter: /.*/, namespace: "setup-test" }, () => ({
            contents: `export const useRouter = () => ({replace: path => {document.body.dataset.redirect = path}, refresh: () => {document.body.dataset.refreshed = 'true'}});`,
          }));
        },
      },
    ],
  });
  const css = await readFile("src/app/styles.css", "utf8");
  server = createServer((request, response) => {
    if (request.url === "/form.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(result.outputFiles[0].text);
    } else if (request.url === "/styles.css") {
      response.setHeader("Content-Type", "text/css");
      response.end(css);
    } else {
      response.setHeader("Content-Type", "text/html");
      response.end(
        '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"><main class="auth-page"><section class="auth-content"><div id="root"></div></section></main><script src="/form.js"></script></html>',
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

beforeEach(async () => {
  page = await browser.newPage();
  submissions = [];
  await page.route("**/api/setup", async (route) => {
    submissions.push(route.request().postDataJSON());
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: '{"initialized":true}',
    });
  });
  await page.goto(origin);
  await page
    .getByLabel("Setup secret", { exact: true })
    .fill(credentials.bootstrapSecret);
  await page.getByLabel("Username", { exact: true }).fill(credentials.username);
  await page.getByLabel("Password", { exact: true }).fill(credentials.password);
});

afterEach(async () => {
  await page?.close();
});
afterAll(async () => {
  await browser?.close();
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function expectPreservedValues(confirmation: string) {
  expect(
    await page.getByLabel("Setup secret", { exact: true }).inputValue(),
  ).toBe(credentials.bootstrapSecret);
  expect(await page.getByLabel("Username", { exact: true }).inputValue()).toBe(
    credentials.username,
  );
  expect(await page.getByLabel("Password", { exact: true }).inputValue()).toBe(
    credentials.password,
  );
  expect(
    await page.getByLabel("Confirm password", { exact: true }).inputValue(),
  ).toBe(confirmation);
}

it("requires confirmation and prevents a native submission without it", async () => {
  await page.getByRole("button", { name: "Create owner", exact: true }).click();
  await page.getByRole("alert").waitFor();
  expect(await page.getByRole("alert").textContent()).toBe(
    "Please confirm your password.",
  );
  expect(
    await page
      .getByLabel("Confirm password", { exact: true })
      .evaluate((element: HTMLInputElement) => element.validity.valueMissing),
  ).toBe(true);
  expect(submissions).toEqual([]);
  await expectPreservedValues("");
});

it("also rejects missing confirmation when native validation is bypassed", async () => {
  await page
    .locator("form")
    .evaluate((form) =>
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      ),
    );
  await page.getByRole("alert").waitFor();
  expect(await page.getByRole("alert").textContent()).toBe(
    "Please confirm your password.",
  );
  expect(submissions).toEqual([]);
  await expectPreservedValues("");
});

it("shows an associated mismatch error, retains all values, and allows correction", async () => {
  const confirmation = page.getByLabel("Confirm password", { exact: true });
  await confirmation.fill(credentials.password + " ");
  await page.getByRole("button", { name: "Create owner", exact: true }).click();
  await page.getByRole("alert").waitFor();
  expect(await page.getByRole("alert").textContent()).toBe(
    "Passwords do not match.",
  );
  expect(await confirmation.getAttribute("aria-invalid")).toBe("true");
  expect(await confirmation.getAttribute("aria-describedby")).toBe(
    await page.getByRole("alert").getAttribute("id"),
  );
  expect(
    await confirmation.evaluate(
      (element) => element === document.activeElement,
    ),
  ).toBe(true);
  expect(submissions).toEqual([]);
  await expectPreservedValues(credentials.password + " ");
  await confirmation.fill(credentials.password);
  expect(await page.getByRole("alert").count()).toBe(0);
  await page.getByRole("button", { name: "Create owner", exact: true }).click();
  await page.waitForFunction(() => document.body.dataset.redirect === "/login");
  expect(submissions).toEqual([credentials]);
});

it("submits matching passwords using only the existing API fields", async () => {
  await page
    .getByLabel("Confirm password", { exact: true })
    .fill(credentials.password);
  expect(
    await page
      .locator("form")
      .evaluate((form: HTMLFormElement) =>
        new FormData(form).has("confirmPassword"),
      ),
  ).toBe(false);
  expect(
    await page
      .getByLabel("Confirm password", { exact: true })
      .getAttribute("name"),
  ).toBeNull();
  await page.getByRole("button", { name: "Create owner", exact: true }).click();
  await page.waitForFunction(() => document.body.dataset.refreshed === "true");
  expect(submissions).toEqual([credentials]);
  expect(await page.locator("body").getAttribute("data-redirect")).toBe(
    "/login",
  );
});

it("toggles each password independently with keyboard-accessible controls without submitting", async () => {
  await page
    .getByLabel("Confirm password", { exact: true })
    .fill(credentials.password);
  for (const field of ["Password", "Confirm password"]) {
    const input = page.getByLabel(field, { exact: true });
    expect(await input.getAttribute("type")).toBe("password");
    const show = page.getByRole("button", {
      name: `Show ${field.toLowerCase()}`,
      exact: true,
    });
    expect(await show.getAttribute("aria-controls")).toBe(
      await input.getAttribute("id"),
    );
    await show.focus();
    await page.keyboard.press("Enter");
    expect(await input.getAttribute("type")).toBe("text");
    const other = page.getByLabel(
      field === "Password" ? "Confirm password" : "Password",
      { exact: true },
    );
    expect(await other.getAttribute("type")).toBe("password");
    await page
      .getByRole("button", { name: `Hide ${field.toLowerCase()}`, exact: true })
      .focus();
    await page.keyboard.press("Space");
    expect(await input.getAttribute("type")).toBe("password");
  }
  expect(submissions).toEqual([]);
  await expectPreservedValues(credentials.password);
  expect(
    await page.evaluate(() => [localStorage.length, sessionStorage.length]),
  ).toEqual([0, 0]);
});

it("keeps the existing password length policy", async () => {
  const password = page.getByLabel("Password", { exact: true });
  expect(await password.getAttribute("minlength")).toBe("12");
  expect(await password.getAttribute("maxlength")).toBe("128");
  await password.press("ControlOrMeta+A");
  await password.pressSequentially("short");
  await page.getByLabel("Confirm password", { exact: true }).fill("short");
  await page.getByRole("button", { name: "Create owner", exact: true }).click();
  expect(
    await password.evaluate(
      (element: HTMLInputElement) => element.validity.tooShort,
    ),
  ).toBe(true);
  expect(submissions).toEqual([]);
});

it.each(["light", "dark"])(
  "fits desktop and mobile layouts in the %s theme",
  async (theme) => {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const password = await page
        .getByLabel("Password", { exact: true })
        .boundingBox();
      const confirmation = await page
        .getByLabel("Confirm password", { exact: true })
        .boundingBox();
      expect(confirmation!.y).toBeGreaterThan(password!.y + password!.height);
      expect(confirmation!.width).toBe(password!.width);
      expect(
        await page
          .locator(".auth-card")
          .evaluate((element) => getComputedStyle(element).backgroundColor),
      ).toBe(theme === "dark" ? "rgb(27, 31, 39)" : "rgb(255, 255, 255)");
    }
  },
);
