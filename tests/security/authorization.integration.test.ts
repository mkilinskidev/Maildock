import {
  GET as oauthConfigRead,
  PUT as oauthConfigSave,
} from "../../src/app/api/settings/oauth-providers/route";
import { createOAuthComposition } from "../../src/modules/accounts/infrastructure/oauth-composition";
import { AesGcmSecretEncryption } from "../../src/shared/infrastructure/crypto/aes-gcm-secret-encryption";
import { GET as applicationLogs } from "../../src/app/api/application-events/route";
import { randomUUID } from "node:crypto";
import { SignatureService } from "../../src/modules/mail/application/signature-service";
import { plainTextDocument } from "../../src/modules/mail/domain/rich-document";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { JSDOM } from "jsdom";
import { createDatabase } from "../../src/shared/infrastructure/database/database";
import { parseConfig } from "../../src/shared/infrastructure/config/config";
import { LocalBlobStorage } from "../../src/shared/infrastructure/storage/local-blob-storage";
import { initializeOwner } from "../../src/modules/auth/application/instance-auth";
import { createAuth } from "../../src/modules/auth/infrastructure/auth-factory";
import { checkOwnerApiAccess } from "../../src/modules/auth/application/api-access-check";
import { MessageContentService } from "../../src/modules/mail/application/message-content-service";
import {
  AttachmentService,
  registerBlob,
} from "../../src/modules/mail/application/attachment-service";
import { DEFAULT_ATTACHMENT_LIMITS } from "../../src/modules/mail/domain/attachments";
import { EMAIL_HTML_POLICY } from "../../src/modules/mail/infrastructure/sanitize-email-html";
import {
  mailAccounts,
  mailboxes,
  messages,
  mailboxMessages,
  messageContents,
  messageAttachments,
  blobs,
  remoteContentSenders,
  signatures,
} from "../../src/shared/infrastructure/database/schema";
import type { RemoteMimePart } from "../../src/modules/accounts/domain/mail-provider";
import { hostileMime, png, type MimeResource } from "./fixtures";
import { parseFixture } from "./pipeline";

// Replace application singletons, not the route, guard, session, DB, storage or services.
const runtime = vi.hoisted(() => ({
  db: undefined as unknown,
  content: undefined as unknown,
  attachments: undefined as unknown,
  signatures: undefined as unknown,
  guard: undefined as unknown,
  oauth: undefined as unknown,
}));
vi.mock("@/shared/infrastructure/database/runtime-database", () => ({
  get db() {
    return runtime.db;
  },
}));
vi.mock("@/modules/accounts/infrastructure/accounts", () => ({
  get oauthProviders() {
    return (runtime.oauth as ReturnType<typeof createOAuthComposition>)
      .registry;
  },
  get oauthProviderConfigs() {
    return (runtime.oauth as ReturnType<typeof createOAuthComposition>)
      .configurations;
  },
  get messageContentService() {
    return runtime.content;
  },
  get attachmentService() {
    return runtime.attachments;
  },
  get signatureService() {
    return runtime.signatures;
  },
}));
vi.mock("@/modules/auth/application/api-access", () => ({
  requireOwnerApiAccess: (r: Request, mutation = false) =>
    (runtime.guard as (r: Request, m: boolean) => Promise<Response | null>)(
      r,
      mutation,
    ),
}));
import { POST } from "../../src/app/api/accounts/[id]/mailboxes/[mailboxId]/messages/[messageId]/render/route";
import {
  GET,
  DELETE,
} from "../../src/app/api/settings/remote-content-senders/route";
import { GET as download } from "../../src/app/api/attachments/[attachmentId]/download/route";
import {
  GET as signatureList,
  POST as signatureCreate,
} from "../../src/app/api/signatures/route";
import {
  GET as signatureRead,
  PATCH as signatureUpdate,
  DELETE as signatureDelete,
} from "../../src/app/api/signatures/[id]/route";
import { POST as signatureSnapshot } from "../../src/app/api/signatures/[id]/snapshot/route";
import { PUT as signatureDefaults } from "../../src/app/api/accounts/[id]/signatures/route";
import {
  GET as notificationSettings,
  PUT as saveNotificationSettings,
} from "../../src/app/api/settings/notifications/route";
import { POST as notificationPoll } from "../../src/app/api/notifications/route";
import { defaultNotificationPreferences } from "../../src/modules/mail/domain/notifications";

describe("Phase 2H direct API + real owner session + PostgreSQL/blob attacks", () => {
  let container: StartedTestContainer;
  let database: ReturnType<typeof createDatabase>;
  let root: string, storage: LocalBlobStorage, cookie: string;
  let content: MessageContentService, attachments: AttachmentService;
  const enqueue = vi.fn(async () => {});
  const origin = "http://localhost:3000";
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "maildock-security-"));
    container = await new GenericContainer("postgres:18.6-bookworm")
      .withEnvironment({
        POSTGRES_DB: "security",
        POSTGRES_USER: "maildock",
        POSTGRES_PASSWORD: "test",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/, 2),
      )
      .start();
    const config = parseConfig({
      MAILDOCK_ENV: "test",
      APP_ORIGIN: origin,
      DATABASE_URL: `postgresql://maildock:test@${container.getHost()}:${container.getMappedPort(5432)}/security`,
      AUTH_SECRET: Buffer.alloc(32, 3).toString("base64"),
      CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"),
      ATTACHMENTS_PATH: root,
      LOG_LEVEL: "fatal",
    });
    database = createDatabase(config);
    await migrate(database.db, { migrationsFolder: "db/migrations" });
    await initializeOwner(database.db, {
      username: "owner",
      password: "correct horse battery staple",
    });
    const auth = createAuth(config, database.db);
    const login = await auth.handler(
      new Request(`${origin}/api/auth/sign-in/username`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "owner",
          password: "correct horse battery staple",
          rememberMe: false,
        }),
      }),
    );
    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")!.split(";")[0];
    storage = new LocalBlobStorage(root);
    content = new MessageContentService(database.db);
    attachments = new AttachmentService(
      database.db,
      storage,
      DEFAULT_ATTACHMENT_LIMITS,
      enqueue,
    );
    runtime.oauth = createOAuthComposition(
      database.db,
      new AesGcmSecretEncryption(
        config.credentialsEncryption.activeKeyId,
        config.credentialsEncryption.keys,
      ),
      config,
    );
    runtime.db = database.db;
    runtime.content = content;
    runtime.attachments = attachments;
    runtime.signatures = new SignatureService(database.db, attachments);
    runtime.guard = (r: Request, mutation: boolean) =>
      checkOwnerApiAccess(auth, config, r, mutation);
  });
  afterAll(async () => {
    await database?.client.end();
    await container?.stop();
    if (root) await rm(root, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await database.db.delete(signatures);
    await database.db.delete(remoteContentSenders);
    await database.db.delete(mailAccounts);
    await database.db.delete(blobs);
    enqueue.mockClear();
  });
  function req(
    method = "POST",
    body = "{}",
    auth = true,
    requestOrigin: string | null = origin,
  ) {
    return new Request(`${origin}/api/security-test`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(auth ? { cookie } : {}),
        ...(requestOrigin !== null ? { Origin: requestOrigin } : {}),
      },
      ...(method !== "GET" ? { body } : {}),
    });
  }
  it("protects OAuth configuration with actual owner sessions and Origin/CSRF checks", async () => {
    const body = JSON.stringify({
      providerId: "microsoft",
      clientId: "application-id",
      clientSecret: "provider-private-secret",
    });
    expect((await oauthConfigRead(req("GET", "", false))).status).toBe(401);
    expect((await oauthConfigSave(req("PUT", body, false))).status).toBe(401);
    for (const requestOrigin of [
      null,
      "http://evil.test",
      `${origin}.evil.test`,
    ]) {
      expect(
        (await oauthConfigSave(req("PUT", body, true, requestOrigin))).status,
      ).toBe(403);
    }
    expect(
      (
        await oauthConfigSave(
          req(
            "PUT",
            JSON.stringify({ providerId: "unknown", clientId: "client" }),
          ),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await oauthConfigSave(
          req("PUT", JSON.stringify({ providerId: "microsoft", clientId: "" })),
        )
      ).status,
    ).toBe(400);
    const saved = await oauthConfigSave(req("PUT", body));
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      hasClientSecret: true,
      configured: true,
      redirectUri: `${origin}/api/oauth/microsoft/callback`,
    });
    const read = await oauthConfigRead(req("GET"));
    const data = await read.json();
    expect(data.providers).toHaveLength(2);
    expect(data.providers[0].id).toBe("microsoft");
    expect(data.providers[1]).toMatchObject({
      id: "google",
      name: "Google",
      configured: false,
      redirectUri: `${origin}/api/oauth/google/callback`,
    });
    expect(JSON.stringify(data)).not.toMatch(
      /provider-private-secret|ciphertext|encryptedClientSecret|authTag/,
    );
    const kept = await oauthConfigSave(
      req(
        "PUT",
        JSON.stringify({
          providerId: "microsoft",
          clientId: "updated-client",
          clientSecret: "",
        }),
      ),
    );
    expect(await kept.json()).toMatchObject({
      hasClientSecret: true,
      configured: true,
    });
  });

  it("secures Google DB-backed configuration with real owner auth and write-only secrets", async () => {
    const body = JSON.stringify({
      providerId: "google",
      clientId: "google-id",
      clientSecret: "google-private-secret",
    });
    expect((await oauthConfigSave(req("PUT", body, false))).status).toBe(401);
    expect(
      (await oauthConfigSave(req("PUT", body, true, "https://evil.example")))
        .status,
    ).toBe(403);
    expect((await oauthConfigSave(req("PUT", body))).status).toBe(200);
    const view = await (await oauthConfigRead(req("GET"))).json();
    expect(view.providers.map((p: { id: string }) => p.id)).toEqual([
      "microsoft",
      "google",
    ]);
    expect(view.providers[1]).toMatchObject({
      configured: true,
      enabled: true,
      hasClientSecret: true,
      redirectUri: `${origin}/api/oauth/google/callback`,
    });
    expect(JSON.stringify(view)).not.toMatch(
      /google-private-secret|ciphertext|encryptedClientSecret|authTag/,
    );
    const kept = await oauthConfigSave(
      req(
        "PUT",
        JSON.stringify({
          providerId: "google",
          clientId: "google-id",
          clientSecret: "",
          enabled: false,
        }),
      ),
    );
    expect(await kept.json()).toMatchObject({
      configured: false,
      enabled: false,
      hasClientSecret: true,
    });
  });

  async function seed(
    html = '<p>Body</p><img src="http://127.0.0.1:54321/img">',
    resources: MimeResource[] = [],
    from = "Display <evil@example.test>",
  ) {
    const accountId = randomUUID(),
      mailboxId = randomUUID(),
      messageId = randomUUID();
    const { parsed, clean } = await parseFixture(
      hostileMime(html, resources, from),
    );
    await database.db.insert(mailAccounts).values({
      id: accountId,
      displayName: "Security",
      email: `${accountId}@example.test`,
      imapHost: "unused.test",
      imapPort: 993,
      imapSecurity: "tls",
      imapUsername: "owner",
      imapPassword: { v: 1 } as never,
      smtpHost: "unused.test",
      smtpPort: 465,
      smtpSecurity: "tls",
    });
    await database.db.insert(mailboxes).values({
      id: mailboxId,
      accountId,
      name: "Inbox",
      remotePath: "INBOX",
      selectable: true,
      uidValidity: 7n,
      recentSyncUidValidity: 7n,
      firstDiscoveredAt: new Date(),
      lastDiscoveredAt: new Date(),
    });
    const part = (
      id: string,
      type: string,
      cid: string | null = null,
    ): RemoteMimePart => ({
      part: id,
      type,
      contentId: cid,
      disposition: cid ? "inline" : null,
      filename: null,
      encoding: "base64",
      size: "100",
      parameters: {},
      dispositionParameters: {},
      children: [],
    });
    const structure = {
      ...part("", "multipart/related"),
      children: [
        part("1", "text/html"),
        ...parsed.attachments.map((a, i) =>
          part(String(i + 2), a.contentType, a.contentId ?? null),
        ),
      ],
    };
    await database.db.insert(messages).values({
      id: messageId,
      accountId,
      internalDate: new Date(),
      size: 100n,
      from: parsed.from?.value ?? [],
      mimeStructure: structure,
    });
    await database.db.insert(mailboxMessages).values({
      id: randomUUID(),
      mailboxId,
      messageId,
      uidValidity: 7n,
      uid: 42n,
      firstSynchronizedAt: new Date(),
      lastSynchronizedAt: new Date(),
    });
    await database.db.insert(messageContents).values({
      messageId,
      status: "ready",
      plainText: "Fallback",
      sanitizedHtml: clean.html,
      remoteContentBlocked: clean.remoteContentBlocked,
      policyVersion: EMAIL_HTML_POLICY,
    });
    await content.detail(accountId, mailboxId, messageId);
    const parts = await database.db
      .select()
      .from(messageAttachments)
      .where(eq(messageAttachments.messageId, messageId));
    const context = {
      params: Promise.resolve({ id: accountId, mailboxId, messageId }),
    };
    return { accountId, mailboxId, messageId, parts, context };
  }
  async function cache(
    part: typeof messageAttachments.$inferSelect,
    bytes: Buffer,
  ) {
    const blob = await storage.put(
      Readable.from([bytes]),
      DEFAULT_ATTACHMENT_LIMITS.maxAttachmentBytes,
    );
    const blobId = await registerBlob(database.db, blob);
    await database.db
      .update(messageAttachments)
      .set({ status: "ready", blobId })
      .where(eq(messageAttachments.id, part.id));
    return blobId;
  }
  it("Phase 3F protects diagnostic history with real owner sessions", async () => {
    expect((await applicationLogs(req("GET", "", false))).status).toBe(401);
    const response = await applicationLogs(req("GET"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect((await response.json()).events).toEqual([]);
  });
  it("protects notification settings and durable consumption using real owner sessions and Origin checks", async () => {
    expect((await notificationSettings(req("GET", "", false))).status).toBe(
      401,
    );
    for (const authenticated of [false, true]) {
      const status = authenticated ? 403 : 401;
      const requestOrigin = authenticated ? "http://evil.test" : origin;
      expect(
        (
          await saveNotificationSettings(
            req(
              "PUT",
              JSON.stringify(defaultNotificationPreferences),
              authenticated,
              requestOrigin,
            ),
          )
        ).status,
      ).toBe(status);
      expect(
        (
          await notificationPoll(
            req("POST", '{"action":"poll"}', authenticated, requestOrigin),
          )
        ).status,
      ).toBe(status);
    }
    const noOrigin = req("POST", '{"action":"poll"}');
    noOrigin.headers.delete("Origin");
    expect((await notificationPoll(noOrigin)).status).toBe(403);
    expect(
      (
        await saveNotificationSettings(
          req(
            "PUT",
            JSON.stringify({
              ...defaultNotificationPreferences,
              enabled: true,
            }),
          ),
        )
      ).status,
    ).toBe(200);
    expect(
      (await (await notificationSettings(req("GET"))).json()).enabled,
    ).toBe(true);
    expect(
      (await notificationPoll(req("POST", '{"action":"start"}'))).status,
    ).toBe(200);
    expect(
      (await notificationPoll(req("POST", '{"action":"poll"}'))).status,
    ).toBe(200);
    for (const body of [
      "{}",
      '{"action":"other"}',
      '{"action":"poll","checkpoint":100}',
      "null",
    ]) {
      expect((await notificationPoll(req("POST", body))).status).toBe(400);
    }
    expect(
      (await saveNotificationSettings(req("PUT", '{"enabled":true}'))).status,
    ).toBe(400);
  });
  it("protects all signature APIs with real owner auth and mutation Origin checks", async () => {
    const id = randomUUID(),
      draftId = randomUUID();
    const context = { params: Promise.resolve({ id }) };
    const body = JSON.stringify({
      id,
      name: "NMI",
      richDocument: plainTextDocument("Owner signature"),
    });
    expect((await signatureList(req("GET", "", false))).status).toBe(401);
    expect((await signatureRead(req("GET", "", false), context)).status).toBe(
      401,
    );
    for (const auth of [false, true]) {
      const originValue = auth ? "http://evil.test" : origin;
      expect([401, 403]).toContain(
        (await signatureCreate(req("POST", body, auth, originValue))).status,
      );
      expect([401, 403]).toContain(
        (await signatureUpdate(req("PATCH", "{}", auth, originValue), context))
          .status,
      );
      expect([401, 403]).toContain(
        (await signatureDelete(req("DELETE", "{}", auth, originValue), context))
          .status,
      );
      expect([401, 403]).toContain(
        (
          await signatureSnapshot(
            req("POST", JSON.stringify({ draftId }), auth, originValue),
            context,
          )
        ).status,
      );
      expect([401, 403]).toContain(
        (await signatureDefaults(req("PUT", "{}", auth, originValue), context))
          .status,
      );
    }
    expect(await database.db.select().from(signatures)).toEqual([]);
    const created = await signatureCreate(req("POST", body));
    expect(created.status).toBe(201);
    const definition = await (await signatureRead(req("GET"), context)).json();
    expect(definition.name).toBe("NMI");
    expect(
      (
        await signatureSnapshot(
          req("POST", JSON.stringify({ draftId })),
          context,
        )
      ).status,
    ).toBe(200);
    const malicious = JSON.stringify({
      id: randomUUID(),
      name: "Unsafe",
      richDocument: {
        version: 1,
        editor: { root: { type: "script", version: 1, text: "x" } },
      },
    });
    expect((await signatureCreate(req("POST", malicious))).status).toBe(400);
    expect(
      (
        await signatureSnapshot(
          req("POST", JSON.stringify({ draftId, blobId: randomUUID() })),
          context,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await signatureDelete(
          req(
            "DELETE",
            JSON.stringify({ expectedRevision: definition.revision }),
          ),
          context,
        )
      ).status,
    ).toBe(204);
  });
  it("rejects missing/forged sessions and absent/null/foreign Origin before CID preparation or sender trust", async () => {
    const s = await seed('<img src="cid:logo">', [
      { cid: "<logo>", type: "image/png", bytes: png },
    ]);
    for (const request of [
      req("POST", '{"trustSender":true}', false),
      req("POST", '{"trustSender":true}', true, null),
      req("POST", '{"trustSender":true}', true, "null"),
      req("POST", '{"trustSender":true}', true, "http://evil.test"),
      req("POST", "{}", true, `${origin}.evil.test`),
    ]) {
      expect([401, 403]).toContain((await POST(request, s.context)).status);
    }
    const forged = req();
    forged.headers.set("cookie", "maildock.session_token=guessed");
    expect((await POST(forged, s.context)).status).toBe(401);
    expect((await GET(req("GET", "", false))).status).toBe(401);
    expect(
      (await DELETE(req("DELETE", '{"address":"evil@example.test"}', false)))
        .status,
    ).toBe(401);
    expect(
      (
        await DELETE(
          req("DELETE", '{"address":"evil@example.test"}', true, null),
        )
      ).status,
    ).toBe(403);
    expect(enqueue).not.toHaveBeenCalled();
    expect(await database.db.select().from(remoteContentSenders)).toHaveLength(
      0,
    );
  });
  it("rejects all account/mailbox/message tuple substitutions before trust mutation", async () => {
    const a = await seed(),
      b = await seed();
    for (const tuple of [
      [b.accountId, a.mailboxId, a.messageId],
      [a.accountId, b.mailboxId, a.messageId],
      [a.accountId, a.mailboxId, b.messageId],
      [a.accountId, a.mailboxId, randomUUID()],
    ]) {
      const response = await POST(req("POST", '{"trustSender":true}'), {
        params: Promise.resolve({
          id: tuple[0],
          mailboxId: tuple[1],
          messageId: tuple[2],
        }),
      });
      expect(response.status).toBe(404);
      expect(await response.text()).toBe(
        '{"error":"Email rendering is unavailable."}',
      );
    }
    expect(await database.db.select().from(remoteContentSenders)).toHaveLength(
      0,
    );
  });
  it.each([
    "{",
    "null",
    "[]",
    '{"loadImages":"true"}',
    '{"trustSender":1}',
    '{"loadImages":{}}',
  ])("fails closed for malformed/incorrect JSON %s", async (body) => {
    const s = await seed();
    const response = await POST(req("POST", body), s.context);
    expect([400, 503]).toContain(response.status);
    expect(await response.text()).toBe(
      '{"error":"Email rendering is unavailable."}',
    );
    expect(enqueue).not.toHaveBeenCalled();
    expect(await database.db.select().from(remoteContentSenders)).toHaveLength(
      0,
    );
  });
  it("unknown input and a 1 MiB storage-path field never grant capabilities (there is no route body-size ceiling)", async () => {
    const s = await seed();
    const response = await POST(
      req(
        "POST",
        JSON.stringify({
          blobPath: "../secret/" + "x".repeat(1024 * 1024),
          attachmentId: randomUUID(),
          sender: "trusted@example.test",
          accountId: randomUUID(),
        }),
      ),
      s.context,
    );
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.blocked).toBe(true);
    expect(result.trusted).toBe(false);
    expect(result.document).not.toContain("../secret");
    expect(enqueue).not.toHaveBeenCalled();
    expect((await DELETE(req("DELETE", "{"))).status).toBe(400);
    expect(
      (
        await DELETE(
          req("DELETE", JSON.stringify({ address: "x".repeat(321) })),
        )
      ).status,
    ).toBe(400);
  });
  it("rejects path/invalid opaque IDs and guessed attachment/blob UUIDs without path leakage", async () => {
    const s = await seed();
    for (const id of ["../secret", "%2e%2e", "not-a-uuid"]) {
      expect(
        (
          await POST(req(), {
            params: Promise.resolve({
              id,
              mailboxId: s.mailboxId,
              messageId: s.messageId,
            }),
          })
        ).status,
      ).toBe(400);
    }
    for (const id of [randomUUID(), "../blob"]) {
      const response = await download(req("GET"), {
        params: Promise.resolve({ attachmentId: id }),
      });
      expect([400, 409]).toContain(response.status);
      expect(await response.text()).not.toMatch(
        /storageKey|postgres|SELECT|secret|\\|\/blob/,
      );
    }
  });
  it("CID resolution is message-scoped even with same CID in another message, and unrelated attachments are never prepared", async () => {
    const b = await seed('<img src="cid:secret">', [
      { cid: "<secret>", type: "image/png", bytes: png },
    ]);
    const blobId = await cache(b.parts[0], png);
    const a = await seed('<p>A</p><img src="cid:secret">', [
      { cid: "<unrelated>", type: "image/png", bytes: png },
    ]);
    const response = await POST(
      req("POST", JSON.stringify({ attachmentId: b.parts[0].id, blobId })),
      a.context,
    );
    const result = await response.json();
    expect(result.inlineFailures).toBe(1);
    expect(result.document).not.toContain("data:image/png");
    expect(enqueue).not.toHaveBeenCalled();
    await expect(
      attachments.inlineResource(a.messageId, b.parts[0].id, "secret"),
    ).rejects.toThrow("Inline resource is unavailable");
    const guessedBlob = await download(req("GET"), {
      params: Promise.resolve({ attachmentId: blobId }),
    });
    expect(guessedBlob.status).toBe(409);
    expect(
      (
        await download(req("GET", "", false), {
          params: Promise.resolve({ attachmentId: b.parts[0].id }),
        })
      ).status,
    ).toBe(401);
  });
  it("duplicate normalized CID, SVG and spoofed PNG fail without accidentally preparing unrelated parts", async () => {
    const s = await seed(
      '<img src="cid:dup@example.test"><img src="cid:svg"><img src="cid:spoof"><img src="cid:%zz"><img src="cid:%00bad">',
      [
        { cid: "<dup@EXAMPLE.TEST>", type: "image/png", bytes: png },
        { cid: "<dup@example.test>", type: "image/png", bytes: png },
        {
          cid: "<svg>",
          type: "image/svg+xml",
          bytes: Buffer.from('<svg onload="alert(1)"/>'),
        },
        {
          cid: "<spoof>",
          type: "image/png",
          bytes: Buffer.from('<svg onload="alert(1)"/>'),
        },
      ],
    );
    await cache(
      s.parts.find(
        (p) => p.contentId === "<spoof>" || p.contentId === "spoof",
      )!,
      Buffer.from('<svg onload="alert(1)"/>'),
    );
    const result = await (await POST(req(), s.context)).json();
    expect(result.document).not.toContain("data:image/");
    expect(result.inlineFailures).toBeGreaterThanOrEqual(4);
    expect(enqueue).not.toHaveBeenCalled();
  });
  it("verified raster CID is embedded without consent; storage failure closes safely", async () => {
    const s = await seed('<img src="cid:logo">', [
      { cid: "<logo>", type: "image/png", bytes: png },
    ]);
    const blobId = await cache(s.parts[0], png);
    let result = await (await POST(req(), s.context)).json();
    expect(result.inlineFailures).toBe(0);
    expect(result.blocked).toBe(false);
    const dom = new JSDOM(result.document);
    expect(dom.window.document.querySelector("img")?.src).toBe(
      `data:image/png;base64,${png.toString("base64")}`,
    );
    dom.window.close();
    const spy = vi
      .spyOn(storage, "open")
      .mockRejectedValueOnce(
        Error("D:\\private\\blob\\secret postgres details"),
      );
    result = await (await POST(req(), s.context)).json();
    spy.mockRestore();
    expect(result.inlineFailures).toBe(1);
    expect(result.document).not.toContain("data:image/");
    expect(JSON.stringify(result)).not.toMatch(/private|postgres|secret/);
    await expect(
      database.db
        .update(blobs)
        .set({ sha256: "0".repeat(64) })
        .where(eq(blobs.id, blobId)),
    ).rejects.toThrow();
    const [blob] = await database.db
      .select()
      .from(blobs)
      .where(eq(blobs.id, blobId));
    expect(blob.storageKey).toMatch(/^[a-f0-9-]{36}$/);
    const corrupted = Buffer.from(png);
    corrupted[corrupted.length - 1] ^= 1;
    // Alter only this disposable fixture's actual bytes; DB snapshots stay immutable.
    await writeFile(
      path.join(root, "blobs", blob.storageKey.slice(0, 2), blob.storageKey),
      corrupted,
    );
    result = await (await POST(req(), s.context)).json();
    expect(result.inlineFailures).toBe(1);
    expect(result.document).not.toContain("data:image/");
    const corrupt = await download(req("GET"), {
      params: Promise.resolve({ attachmentId: s.parts[0].id }),
    });
    expect(corrupt.status).toBe(503);
    expect(await corrupt.text()).not.toMatch(
      /sha256|storageKey|SELECT|postgres|private/,
    );
  });
  it("sender preferences use exact parsed normalized address across owner accounts, reject ambiguous From, and removal is protected", async () => {
    const a = await seed(
      undefined,
      [],
      '"trusted@example.test" <EVIL@Example.Test>',
    );
    expect(
      (
        await (
          await POST(req("POST", '{"trustSender":true}'), a.context)
        ).json()
      ).trusted,
    ).toBe(true);
    const same = await seed(undefined, [], "evil@example.test");
    expect((await (await POST(req(), same.context)).json()).trusted).toBe(true);
    for (const from of [
      "trusted@example.test",
      "other@example.test",
      "evil@other.test",
      "one@example.test, evil@example.test",
    ]) {
      const s = await seed(undefined, [], from);
      const result = await (
        await POST(
          req("POST", JSON.stringify({ trustSender: from.includes(",") })),
          s.context,
        )
      ).json();
      if (from.includes(",")) {
        expect(result.sender).toBeNull();
        expect(result.trusted).toBe(false);
      } else {
        expect(result.sender).toBe(from);
        expect(result.trusted).toBe(false);
        expect(result.blocked).toBe(true);
      }
    }
    expect(await database.db.select().from(remoteContentSenders)).toHaveLength(
      1,
    );
    const other = await seed(undefined, [], "other@example.test");
    expect((await (await POST(req(), other.context)).json()).trusted).toBe(
      false,
    );
    expect(
      (
        await DELETE(
          req(
            "DELETE",
            '{"address":"evil@example.test"}',
            true,
            "http://evil.test",
          ),
        )
      ).status,
    ).toBe(403);
    expect((await (await POST(req(), same.context)).json()).trusted).toBe(true);
    expect(
      (await DELETE(req("DELETE", '{"address":" EVIL@EXAMPLE.TEST "}'))).status,
    ).toBe(200);
    expect((await (await POST(req(), same.context)).json()).blocked).toBe(true);
  });
  it("unversioned historical HTML is re-sanitized rather than activated as stored capabilities", async () => {
    const s = await seed();
    await database.db
      .update(messageContents)
      .set({
        policyVersion: "unknown",
        sanitizedHtml:
          '<script>alert(1)</script><img data-maildock-remote="http://127.0.0.1:54321/forged"><p>Historical</p>',
      })
      .where(eq(messageContents.messageId, s.messageId));
    const result = await (
      await POST(req("POST", '{"loadImages":true}'), s.context)
    ).json();
    expect(result.document).toContain("Historical");
    expect(result.document).not.toMatch(/<script|\/forged/);
  });
});
