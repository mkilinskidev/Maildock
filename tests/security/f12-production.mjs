// Run only inside the disposable production image, copied to /app/f12-production.mjs.
// Uses synthetic setup/MFA and inspects the actual published blobs and database.
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, writeFile, stat, readdir } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

assert.equal(process.env.APP_ORIGIN, "https://f12.invalid");
assert.match(
  process.env.DATABASE_URL,
  /^postgresql:\/\/maildock:f12-disposable-only@maildock-f12-1-[a-z0-9-]+:5432\/maildock$/,
);
const require = createRequire("/app/server.js");
const sql = require("postgres")(process.env.DATABASE_URL, { max: 1 });
const baseline = process.argv.includes("--baseline");
const high = process.argv.includes("--high");
const MiB = 1024 * 1024;
const jar = new Map();
const password = "F12-disposable-password-2026";
const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
let secret;
function totp() {
  let bits = "";
  for (const c of secret.toUpperCase())
    bits += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
      .indexOf(c)
      .toString(2)
      .padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = createHmac("sha1", key).update(counter).digest();
  return String((h.readUInt32BE(h[19] & 15) & 0x7fffffff) % 1000000).padStart(
    6,
    "0",
  );
}
async function call(url, body) {
  const r = await fetch(`http://127.0.0.1:3000${url}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Origin: process.env.APP_ORIGIN,
      "Content-Type": "application/json",
      Cookie: cookie(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  for (const c of r.headers.getSetCookie()) {
    const kv = c.split(";")[0],
      i = kv.indexOf("=");
    jar.set(kv.slice(0, i), kv.slice(i + 1));
  }
  assert.equal(r.ok, true, `${url}: ${r.status}`);
  return r.json();
}
async function enroll() {
  const { initialized } = await call("/api/setup");
  if (!initialized) {
    if (!baseline) {
      const tooLarge = await fetch("http://127.0.0.1:3000/api/setup", {
        method: "POST",
        headers: {
          Origin: process.env.APP_ORIGIN,
          "Content-Type": "application/json",
        },
        body: Buffer.alloc(4097, 120),
      });
      assert.equal(tooLarge.status, 413);
      console.log("fresh setup 4097-byte rejection: PASS");
    }
    await call("/api/setup", {
      username: "f12owner",
      password,
      bootstrapSecret: process.env.MAILDOCK_BOOTSTRAP_SECRET,
    });
    await call("/api/auth/sign-in/username", {
      username: "f12owner",
      password,
    });
    const denied = await fetch("http://127.0.0.1:3000/api/attachments/staged", {
      method: "POST",
      headers: { Cookie: cookie(), Origin: process.env.APP_ORIGIN },
      body: "synthetic",
    });
    assert.equal(denied.status, 401);
    const enrollment = await call("/api/auth/initial-mfa/start", {
      password,
      bootstrapSecret: process.env.MAILDOCK_BOOTSTRAP_SECRET,
    });
    secret = new URL(enrollment.totpURI).searchParams.get("secret");
    await writeFile("/tmp/f12-totp", secret, { mode: 0o600 });
    await call("/api/auth/initial-mfa/complete", {
      code: totp(),
      bootstrapSecret: process.env.MAILDOCK_BOOTSTRAP_SECRET,
    });
  } else {
    secret = await readFile("/tmp/f12-totp", "utf8");
  }
  await call("/api/auth/sign-in/username", { username: "f12owner", password });
  await call("/api/auth/mfa/totp", { code: totp() });
  await call("/api/accounts");
  console.log("real setup/MFA/business session: PASS");
}
function upload(
  size,
  {
    chunked = false,
    origin = process.env.APP_ORIGIN,
    authenticated = true,
    declared = size,
    abort = false,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const headers = {
      Origin: origin,
      "Content-Type": "application/octet-stream",
      "X-Attachment-Filename": "f12-synthetic.bin",
      ...(authenticated ? { Cookie: cookie() } : {}),
    };
    if (!chunked) headers["Content-Length"] = String(declared);
    const req = httpRequest(
      "http://127.0.0.1:3000/api/attachments/staged",
      { method: "POST", headers },
      (res) => {
        let text = "";
        res
          .setEncoding("utf8")
          .on("data", (c) => {
            text += c;
          })
          .on("end", () => resolve({ status: res.statusCode, text }));
      },
    );
    req.on("error", (e) => (abort ? resolve({ aborted: e.code }) : reject(e)));
    let remaining = size;
    function write() {
      while (remaining > 0) {
        const n = Math.min(64 * 1024, remaining);
        remaining -= n;
        if (!req.write(Buffer.alloc(n, 65))) {
          req.once("drain", write);
          return;
        }
      }
      if (abort) setTimeout(() => req.destroy(), 50);
      else req.end();
    }
    write();
  });
}
async function verifiedUpload(size, options) {
  const r = await upload(size, options);
  assert.equal(r.status, 201, r.text);
  const result = JSON.parse(r.text);
  const [blob] =
    await sql`select b.* from staged_attachments s join blobs b on b.id = s.blob_id where s.id = ${result.id}`;
  const file = path.join(
    process.env.ATTACHMENTS_PATH,
    "blobs",
    blob.storage_key.slice(0, 2),
    blob.storage_key,
  );
  const persisted = await readFile(file);
  const digest = createHash("sha256")
    .update(Buffer.alloc(size, 65))
    .digest("hex");
  if (baseline) {
    console.log(
      JSON.stringify({
        baseline: true,
        sent: size,
        status: r.status,
        registered: Number(blob.size),
        disk: persisted.length,
        truncated: persisted.length !== size,
      }),
    );
    assert.notEqual(persisted.length, size);
    return;
  }
  assert.equal(Number(result.size), size);
  assert.equal(Number(blob.size), size);
  assert.equal((await stat(file)).size, size);
  assert.equal(createHash("sha256").update(persisted).digest("hex"), digest);
  assert.equal(blob.sha256, digest);
  console.log(
    JSON.stringify({
      upload: size,
      chunked: !!options?.chunked,
      status: r.status,
      sizeAndSha256: "PASS",
    }),
  );
}
async function count() {
  return Number((await sql`select count(*) as n from staged_attachments`)[0].n);
}
async function rejected(size, options, expected) {
  const before = await count();
  const result = await upload(size, options);
  if (expected) assert.equal(result.status, expected, result.text);
  // Client socket closure precedes asynchronous server-side file cleanup.
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      (await readdir(path.join(process.env.ATTACHMENTS_PATH, "tmp"))).length ===
      0
    )
      break;
    await delay(20);
  }
  assert.equal(await count(), before);
  assert.deepEqual(
    await readdir(path.join(process.env.ATTACHMENTS_PATH, "tmp")),
    [],
  );
  console.log(
    JSON.stringify({
      rejected: size,
      options,
      result,
      noPublishedAttachment: true,
    }),
  );
}
async function nativeCanaries() {
  for (const marker of [
    "F12_1_AFTER_QUERY_CANARY",
    "%46%31%32%5F%31%5FENCODED_CANARY",
    "F12_1_CONTROL%0aFORGED_EXTRA_LOG_LINE%0d%1b",
    `F12_1_LONG_${"q".repeat(2048)}`,
  ]) {
    const r = await fetch(`http://127.0.0.1:3000/api/setup?f12=${marker}`, {
      method: "POST",
      headers: {
        Origin: process.env.APP_ORIGIN,
        "Content-Type": "application/json",
      },
      body: Buffer.alloc(10 * MiB + 1, 120),
    });
    assert.equal(r.status, 413);
    assert.equal(await r.text(), "Request body is too large.");
    console.log("native canary: rejected 413");
  }
  // Also exercise a page: no matcher workaround hides the native warning.
  const page = await fetch(
    "http://127.0.0.1:3000/login?f12=F12_1_PAGE_CANARY",
    { method: "POST", body: Buffer.alloc(10 * MiB + 1) },
  );
  assert.equal(page.status, 413);
}
async function publicLimits() {
  for (const url of [
    "/api/auth/sign-in/username",
    "/api/auth/initial-mfa/start",
    "/api/auth/mfa/totp",
    "/api/auth/mfa/manage/authenticator/start",
  ]) {
    const r = await fetch(`http://127.0.0.1:3000${url}`, {
      method: "POST",
      headers: {
        Origin: process.env.APP_ORIGIN,
        "Content-Type": "application/json",
      },
      body: Buffer.alloc(4097, 120),
    });
    assert.equal(r.status, 413, url);
  }
  console.log("public login/MFA 4097-byte rejection: PASS");
}
// With HTTP/1 framing, bytes past a smaller Content-Length are a subsequent
// message, not part of this body. The malformed suffix must never yield a
// successfully published staged attachment in this pipelined probe.
async function shortLength() {
  const before = await count();
  const response = await new Promise((resolve, reject) => {
    const socket = connect(3000, "127.0.0.1");
    let result = "";
    socket.setTimeout(5000, () => socket.destroy());
    socket
      .on("error", reject)
      .on("data", (c) => {
        result += c;
      })
      .on("close", () => resolve(result));
    socket.on("connect", () =>
      socket.end(
        `POST /api/attachments/staged HTTP/1.1\r\nHost: localhost\r\nOrigin: ${process.env.APP_ORIGIN}\r\nCookie: ${cookie()}\r\nContent-Type: application/octet-stream\r\nContent-Length: 4\r\nConnection: close\r\n\r\nAAAAXXXXXXXXXXXX`,
      ),
    );
  });
  assert.match(response, /400 Bad Request/);
  assert.doesNotMatch(response, /201/);
  assert.equal(await count(), before);
  console.log(
    "smaller declared length + malformed suffix: HTTP parser 400, no publication",
  );
}
try {
  await enroll();
  if (baseline) {
    await verifiedUpload(11 * MiB);
  } else if (high) {
    await verifiedUpload(16 * MiB);
    await verifiedUpload(100 * MiB, { chunked: true });
    await rejected(100 * MiB + 1, { chunked: true }, 413);
  } else {
    for (const size of [
      1024,
      10 * MiB - 1,
      10 * MiB,
      10 * MiB + 1,
      11 * MiB,
      15 * MiB,
    ])
      await verifiedUpload(size);
    await verifiedUpload(11 * MiB, { chunked: true });
    await rejected(15 * MiB + 1, {}, 413);
    await rejected(15 * MiB + 1, { chunked: true }, 413);
    await rejected(1024, { authenticated: false }, 401);
    await rejected(1024, { origin: "https://evil.invalid" }, 403);
    await rejected(1024, { declared: 2048, abort: true });
    await rejected(1024, { chunked: true, abort: true });
    await shortLength();
    await nativeCanaries();
    await publicLimits();
  }
  console.log(
    baseline
      ? "F12 baseline regression reproduced"
      : "F12 production probes: PASS",
  );
} finally {
  await sql.end();
}
