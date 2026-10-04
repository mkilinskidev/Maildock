/** Standalone local security harness: never imported by production code. */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Frame,
} from "playwright";
import { attackFixtures, hostileMime, png } from "./fixtures";
import { parseFixture } from "./pipeline";
import { renderEmailDocument } from "../../src/modules/mail/infrastructure/render-email-document";
import { createContentSecurityPolicy } from "../../src/shared/infrastructure/security/content-security-policy";

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}
const close = (server: Server) =>
  new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
const received: { path: string; referrer: string | null }[] = [];
const trap = createServer((req, res) => {
  received.push({ path: req.url!, referrer: req.headers.referer ?? null });
  res.setHeader("Cache-Control", "no-store");
  if (req.url === "/redirect") {
    res.writeHead(302, { Location: "/redirect-img" });
    res.end();
  } else if (req.url === "/svg-as-img") {
    res.setHeader("Content-Type", "image/svg+xml");
    res.end(
      `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" onload="fetch('/svg-onload')"><script>fetch('/svg-script')</script><image href="/svg-nested-image"/><foreignObject><iframe xmlns="http://www.w3.org/1999/xhtml" src="/svg-iframe"/></foreignObject></svg>`,
    );
  } else if (req.url === "/html-as-img") {
    res.setHeader("Content-Type", "text/html");
    res.end(
      "<script>fetch('/html-image-script')</script><img src='/html-nested-image'>",
    );
  } else if (req.url === "/safe-link") {
    res.setHeader("Content-Type", "text/html");
    res.end(
      "<!doctype html><title>Safe external destination</title><p>Opened by user</p>",
    );
  } else {
    res.setHeader("Content-Type", "image/png");
    res.end(png);
  }
});
const trapOrigin = await listen(trap);
const fixtures = attackFixtures(trapOrigin);
const documents = new Map<string, string>();
for (const fixture of fixtures) {
  const { clean } = await parseFixture(hostileMime(fixture.html));
  for (const allow of [false, true])
    documents.set(
      `${fixture.name}:${allow}`,
      renderEmailDocument(clean.html, allow),
    );
}
const cidClean = (
  await parseFixture(
    hostileMime(
      '<p>CID browser control</p><img src="cid:logo"><img src="cid:fake">',
      [{ cid: "<logo>", type: "image/png", bytes: png }],
    ),
  )
).clean;
const fake = Buffer.concat([
  png.subarray(0, 8),
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" onload="parent.document.getElementById('sentinel').textContent='PWNED'"><image href="${trapOrigin}/polyglot"/></svg>`,
  ),
]);
documents.set(
  "cid:false",
  renderEmailDocument(
    cidClean.html,
    false,
    new Map([
      ["logo", `data:image/png;base64,${png.toString("base64")}`],
      ["fake", `data:image/png;base64,${fake.toString("base64")}`],
    ]),
  ),
);

// Read the deployed component attributes: fail on drift, never silently guess.
const component = await readFile(
  new URL("../../src/components/rich-email-body.tsx", import.meta.url),
  "utf8",
);
const sandbox = component.match(/sandbox="([^"]*)"/)?.[1];
const referrerPolicy = component.match(/referrerPolicy="([^"]*)"/)?.[1];
assert.equal(sandbox, "allow-popups allow-popups-to-escape-sandbox");
assert.equal(referrerPolicy, "no-referrer");
// Deliberately bypass sanitizer in this separate defense control, retaining the
// production frame CSP. This checks sandbox/CSP even if a future filter regresses.
const hostileControl = `<script>parent.document.getElementById('sentinel').textContent='PWNED';fetch('${trapOrigin}/script');window.open('${trapOrigin}/popup');top.location='${trapOrigin}/navigation'</script><img src="bad:" onerror="fetch('${trapOrigin}/onerror')"><iframe src="${trapOrigin}/iframe"></iframe><object data="${trapOrigin}/object"></object><audio src="${trapOrigin}/media" autoplay></audio><style>@import '${trapOrigin}/css-import';@font-face{font-family:evil;src:url(${trapOrigin}/font)}p{font-family:evil;background-image:url(${trapOrigin}/css-background)}</style><p>Defense control</p><form action="${trapOrigin}/form"><input type="submit" value="Submit"></form><a href="${trapOrigin}/navigation" target="_top">Navigate top</a>`;
documents.set(
  "defense:false",
  renderEmailDocument("<p>placeholder</p>", false).replace(
    "<p>placeholder</p>",
    hostileControl,
  ),
);
assert.equal(
  received.length,
  0,
  "MIME parsing/sanitizing/rendering made a trap request",
);
const nonce = "maildock-security-harness-nonce";
const parentCsp = createContentSecurityPolicy(nonce);
const app = createServer((req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.url?.startsWith("/document?")) {
    const p = new URL(req.url, "http://localhost").searchParams;
    const doc = documents.get(`${p.get("fixture")}:${p.get("allow")}`);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ document: doc ?? null }));
    return;
  }
  res.setHeader("Content-Security-Policy", parentCsp);
  res.setHeader("Content-Type", "text/html");
  res.setHeader(
    "Set-Cookie",
    "maildock_test_cookie=secret; SameSite=Lax; Path=/",
  );
  res.end(
    `<!doctype html><title>Maildock local security verification</title><link rel="icon" href="data:,"><div id="sentinel">INTACT</div><button id="load">Load images</button><iframe title="Email content" sandbox="${sandbox}" referrerpolicy="${referrerPolicy}"></iframe><script nonce="${nonce}">localStorage.setItem('maildock_test_secret','parent-only');const fixture=new URL(location.href).searchParams.get('fixture');async function render(allow){const r=await fetch('/document?fixture='+encodeURIComponent(fixture)+'&allow='+allow);document.querySelector('iframe').srcdoc=(await r.json()).document;}document.getElementById('load').onclick=()=>render(true);render(false);</script>`,
  );
});
const appOrigin = await listen(app);
let browser: Browser | undefined;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.SECURITY_BROWSER_EXECUTABLE
      ? { executablePath: process.env.SECURITY_BROWSER_EXECUTABLE }
      : process.platform === "win32"
        ? { channel: "msedge" }
        : {}),
  });
  const results: unknown[] = [];
  for (const fixture of fixtures) {
    const context = await browser.newContext();
    const dialogs: string[] = [];
    context.on("page", (p) =>
      p.on("dialog", (dialog) => {
        dialogs.push(dialog.type());
        void dialog.dismiss();
      }),
    );
    const attempts: { path: string; type: string }[] = [];
    context.on("request", (r) => {
      if (!r.url().startsWith(appOrigin))
        attempts.push({
          path: new URL(r.url()).pathname + new URL(r.url()).search,
          type: r.resourceType(),
        });
    });
    const page = await context.newPage();
    received.length = 0;
    const response = await page.goto(`${appOrigin}/?fixture=${fixture.name}`);
    assert.equal(response?.headers()["content-security-policy"], parentCsp);
    await page.waitForFunction(
      () => !!document.querySelector("iframe")?.srcdoc,
    );
    await page.waitForTimeout(800);
    assert.equal(received.length, 0, `${fixture.name} default remote requests`);
    assert.equal(
      attempts.length,
      0,
      `${fixture.name} default network attempts`,
    );
    assert.equal(await page.locator("#sentinel").textContent(), "INTACT");
    assert.equal(context.pages().length, 1);
    assert.equal(dialogs.length, 0);
    const defaultFrame = page.frames().find((f) => f !== page.mainFrame())!;
    assert.equal(
      await defaultFrame.locator("body").getAttribute("data-executed"),
      null,
    );
    const defaultResults = { received: [...received], attempts: [...attempts] };
    await page.locator("#load").click();
    await page.waitForFunction(() =>
      document
        .querySelector("iframe")
        ?.srcdoc.includes("img-src data: https: http:"),
    );
    await page.waitForTimeout(1200);
    // An independent explicit expectation, not one computed from sanitizer output.
    const allowed: Record<string, string[]> = {
      "execution-and-navigation": ["/img"],
      "foreign-content-and-clobbering": [],
      "resource-surface": [
        "/tracker",
        "/redirect",
        "/redirect-img",
        "/svg-as-img",
        "/html-as-img",
      ],
      "css-differentials": [],
      "parser-mutations": ["/nested-img", "/select-img"],
      "url-and-forged-capabilities": [
        "/entity",
        "/encoded%2Fimg",
        "/query-img?x=%22&y=1",
        "/protocol-relative",
      ],
    };
    for (const attempt of attempts) {
      assert(
        allowed[fixture.name].includes(attempt.path),
        `${fixture.name} unexpected request: ${attempt.path}`,
      );
      assert.equal(attempt.type, "image");
    }
    for (const request of received) {
      assert(
        allowed[fixture.name].includes(request.path),
        `${fixture.name} unexpected trap request: ${request.path}`,
      );
      assert.equal(request.referrer, null);
    }
    const expectedReceived = allowed[fixture.name].filter(
      (p) => p !== "/protocol-relative",
    );
    assert.deepEqual(
      received.map((r) => r.path).sort(),
      expectedReceived.sort(),
    );
    assert.equal(await page.locator("#sentinel").textContent(), "INTACT");
    assert.equal(page.url(), `${appOrigin}/?fixture=${fixture.name}`);
    assert.equal(context.pages().length, 1);
    assert.equal(dialogs.length, 0);
    const frame = page.frames().find((f) => f !== page.mainFrame())!;
    assert.equal(
      await frame.locator("body").getAttribute("data-executed"),
      null,
    );
    // String avoids tsx's named-function instrumentation crossing the browser seam.
    const isolation = await frame.evaluate(`(() => {
      const blocked = (read) => { try { read(); return false; } catch { return true; } };
      return { parentDomBlocked: blocked(() => parent.document.body), cookiesBlocked: blocked(() => document.cookie), storageBlocked: blocked(() => localStorage.getItem("maildock_test_secret")) };
    })()`);
    assert.deepEqual(isolation, {
      parentDomBlocked: true,
      cookiesBlocked: true,
      storageBlocked: true,
    });
    results.push({
      fixture: fixture.name,
      default: defaultResults,
      loadImages: { received: [...received], attempts: [...attempts] },
      isolation,
    });
    if (fixture.name === "url-and-forged-capabilities") {
      received.length = 0;
      const popupPromise = context.waitForEvent("page");
      await frame.getByText("safe link", { exact: true }).click();
      const popup = await popupPromise;
      await popup.waitForLoadState();
      assert.equal(popup.url(), `${trapOrigin}/safe-link`);
      assert.equal(await popup.evaluate(() => window.opener), null);
      assert.equal(
        received.find((r) => r.path === "/safe-link")?.referrer,
        null,
      );
      results.push({
        clickedExternalLink: "opened",
        opener: null,
        referrer: null,
      });
    }
    await context.close();
  }
  for (const name of ["cid", "defense"]) {
    const context: BrowserContext = await browser.newContext();
    const dialogs: string[] = [];
    context.on("page", (p) =>
      p.on("dialog", (dialog) => {
        dialogs.push(dialog.type());
        void dialog.dismiss();
      }),
    );
    const page: Page = await context.newPage();
    received.length = 0;
    await page.goto(`${appOrigin}/?fixture=${name}`);
    await page.waitForFunction(
      () => !!document.querySelector("iframe")?.srcdoc,
    );
    await page.waitForTimeout(800);
    const frame: Frame = page.frames().find((f) => f !== page.mainFrame())!;
    if (name === "cid") {
      const sizes = await frame.locator("img").evaluateAll((images) =>
        images.map((i) => ({
          complete: (i as HTMLImageElement).complete,
          width: (i as HTMLImageElement).naturalWidth,
        })),
      );
      assert.deepEqual(sizes, [
        { complete: true, width: 1 },
        { complete: true, width: 0 },
      ]);
      results.push({
        cid: {
          validRasterWidth: 1,
          magicPrefixedSvgWidth: 0,
          remoteRequests: [...received],
        },
      });
    } else {
      await frame.getByRole("button", { name: "Submit" }).click();
      await frame.getByText("Navigate top", { exact: true }).click();
      await page.waitForTimeout(300);
      assert.equal(page.url(), `${appOrigin}/?fixture=defense`);
      results.push({
        defenseControl:
          "scripts, event handlers, forms, top navigation, CSS/fonts, frames, media and objects blocked",
        remoteRequests: [...received],
      });
    }
    assert.deepEqual(received, []);
    assert.equal(await page.locator("#sentinel").textContent(), "INTACT");
    assert.equal(context.pages().length, 1);
    assert.equal(dialogs.length, 0);
    await context.close();
  }
  const output = {
    browser: browser.version(),
    parentCsp,
    sandbox,
    referrerPolicy,
    results,
  };
  await mkdir(".security-results", { recursive: true });
  await writeFile(
    ".security-results/browser.json",
    JSON.stringify(output, null, 2) + "\n",
  );
  console.log(JSON.stringify(output, null, 2));
} finally {
  await browser?.close();
  await close(app);
  await close(trap);
}
