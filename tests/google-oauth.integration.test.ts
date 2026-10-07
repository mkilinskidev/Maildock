import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createDatabase } from "@/shared/infrastructure/database/database";
import { parseConfig } from "@/shared/infrastructure/config/config";
import { AesGcmSecretEncryption } from "@/shared/infrastructure/crypto/aes-gcm-secret-encryption";
import {
  mailAccounts,
  oauthAuthorizationStates,
  mailboxes,
} from "@/shared/infrastructure/database/schema";
import { createOAuthComposition } from "@/modules/accounts/infrastructure/oauth-composition";
import {
  GoogleOAuthProvider,
  googleScopes,
} from "@/modules/accounts/infrastructure/google-oauth";
import { MicrosoftOAuthProvider } from "@/modules/accounts/infrastructure/microsoft-oauth";
import { accountCredentialContext } from "@/modules/accounts/domain/account";
import { AccountsService } from "@/modules/accounts/application/accounts-service";
import {
  ImapSmtpMailProvider,
  imapOptions,
  smtpOptions,
} from "@/modules/accounts/infrastructure/imap-smtp-mail-provider";
import { OAuthAuthorizationError } from "@/modules/accounts/domain/oauth-mail-provider";

describe("Google OAuth through the Phase 3G.1 extension point (real PostgreSQL, mocked Google)", () => {
  let container: StartedTestContainer;
  let database: ReturnType<typeof createDatabase>;
  let encryption: AesGcmSecretEncryption;
  let composition: ReturnType<typeof createOAuthComposition>;
  let google: GoogleOAuthProvider;
  let fetcher: ReturnType<typeof vi.fn>;
  const origin = "https://mail.example.com";
  const session = "authenticated-owner-session";
  const identity = {
    sub: "google-sub-1",
    email: "Owner@gmail.com",
    email_verified: true,
  };
  const tokens = {
    access_token: "access-private",
    refresh_token: "refresh-private",
    token_type: "Bearer",
    expires_in: 3600,
    scope: googleScopes.join(" "),
  };
  beforeAll(async () => {
    container = await new GenericContainer("postgres:18.6-bookworm")
      .withEnvironment({
        POSTGRES_DB: "google_oauth",
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
      DATABASE_URL: `postgresql://maildock:test@${container.getHost()}:${container.getMappedPort(5432)}/google_oauth`,
      AUTH_SECRET: Buffer.alloc(32, 1).toString("base64"),
      CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString("base64"),
      ATTACHMENTS_PATH: process.cwd(),
    });
    database = createDatabase(config);
    await migrate(database.db, { migrationsFolder: "db/migrations" });
    encryption = new AesGcmSecretEncryption(
      config.credentialsEncryption.activeKeyId,
      config.credentialsEncryption.keys,
    );
    composition = createOAuthComposition(database.db, encryption, config);
    google = composition.registry.get("google") as GoogleOAuthProvider;
  });
  afterAll(async () => {
    await database?.client.end();
    await container?.stop();
  });
  beforeEach(async () => {
    await database.db.delete(oauthAuthorizationStates);
    await database.db.delete(mailAccounts);
    await composition.configurations.save("google", {
      clientId: "google-client",
      clientSecret: "client-private",
      enabled: true,
    });
    fetcher = vi.fn(async (url: string) =>
      Response.json(url.includes("userinfo") ? identity : tokens),
    );
    vi.stubGlobal("fetch", fetcher);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  async function begin(accountId?: string) {
    const url = new URL(await google.begin(session, accountId));
    return { url, state: url.searchParams.get("state")! };
  }
  async function connect() {
    return google.complete(session, (await begin()).state, "code-private");
  }
  async function row(id: string) {
    return (
      await database.db
        .select()
        .from(mailAccounts)
        .where(eq(mailAccounts.id, id))
    )[0];
  }
  async function authorization(id: string) {
    return JSON.parse(
      encryption.decrypt(
        (await row(id)).oauthCache!,
        accountCredentialContext(id, "oauth-cache"),
      ),
    );
  }
  it("registers both real providers and safely rejects unknown IDs", () => {
    expect(composition.registry.list().map((p) => p.id)).toEqual([
      "microsoft",
      "google",
    ]);
    expect(composition.registry.get("google")).toBe(google);
    expect(composition.registry.get("microsoft")).toBeInstanceOf(
      MicrosoftOAuthProvider,
    );
    expect(() => composition.registry.get("unknown")).toThrow("unavailable");
    expect(() => composition.registry.get(null)).toThrow("unavailable");
  });
  it("uses DB-only configuration, encrypted write-only secrets and trusted redirects", async () => {
    expect(await google.isConfigured()).toBe(true);
    const view = await composition.configurations.view(google.getDefinition());
    expect(view).toMatchObject({
      id: "google",
      configured: true,
      enabled: true,
      hasClientSecret: true,
      redirectUri: `${origin}/api/oauth/google/callback`,
    });
    expect(JSON.stringify(view)).not.toMatch(
      /client-private|ciphertext|encryptedClientSecret/,
    );
    await composition.configurations.save("google", {
      clientId: "google-client",
      clientSecret: "",
      enabled: false,
    });
    expect(await google.isConfigured()).toBe(false);
    await expect(begin()).rejects.toThrow("not configured");
    await composition.configurations.save("google", {
      clientId: "google-client",
      clientSecret: "",
      enabled: true,
    });
    expect(await composition.configurations.credentials("google")).toEqual({
      clientId: "google-client",
      clientSecret: "client-private",
    });
  });
  it("requests full mail scope, minimal identity scopes, offline consent and matching S256 PKCE", async () => {
    const { url, state } = await begin();
    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(url.searchParams.get("scope")?.split(" ")).toEqual(googleScopes);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent select_account");
    expect(url.searchParams.get("redirect_uri")).toBe(
      `${origin}/api/oauth/google/callback`,
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await begin()).state).not.toBe(state);
    const [pending] = await database.db
      .select()
      .from(oauthAuthorizationStates)
      .where(
        eq(
          oauthAuthorizationStates.stateHash,
          createHash("sha256").update(state).digest("hex"),
        ),
      );
    expect(pending).toMatchObject({
      sessionId: session,
      providerId: "google",
      accountId: null,
    });
    expect(pending.expiresAt.getTime() - Date.now()).toBeGreaterThan(
      9 * 60_000,
    );
    const verifier = encryption.decrypt(
      pending.codeVerifier,
      "maildock:google-oauth-state:v1",
    );
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
      url.searchParams.get("code_challenge"),
    );
    expect(JSON.stringify(pending)).not.toContain(verifier);
    await google.complete(session, state, "code-private");
    const [endpoint, options] = fetcher.mock.calls[0];
    expect(endpoint).toBe("https://oauth2.googleapis.com/token");
    expect(options).toMatchObject({
      method: "POST",
      redirect: "error",
      cache: "no-store",
    });
    const body = options.body as URLSearchParams;
    expect(body.get("code")).toBe("code-private");
    expect(body.get("code_verifier")).toBe(verifier);
    expect(body.get("client_secret")).toBe("client-private");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(fetcher.mock.calls[1]).toMatchObject([
      "https://openidconnect.googleapis.com/v1/userinfo",
      { headers: { Authorization: "Bearer access-private" } },
    ]);
  });
  it("rejects wrong sessions/providers, expired, reused and invalid state before exchanging code", async () => {
    const { state } = await begin();
    await expect(
      google.complete("wrong-session", state, "code"),
    ).rejects.toThrow("state");
    await database.db
      .update(oauthAuthorizationStates)
      .set({ providerId: "microsoft" });
    await expect(google.complete(session, state, "code")).rejects.toThrow(
      "state",
    );
    await database.db
      .update(oauthAuthorizationStates)
      .set({ providerId: "google", expiresAt: new Date(0) });
    await expect(google.complete(session, state, "code")).rejects.toThrow(
      "state",
    );
    for (const invalid of ["", "x".repeat(513), "arbitrary"])
      await expect(google.complete(session, invalid, "code")).rejects.toThrow(
        "state",
      );
    expect(fetcher).not.toHaveBeenCalled();
    const fresh = await begin();
    await google.complete(session, fresh.state, "code");
    fetcher.mockClear();
    await expect(google.complete(session, fresh.state, "code")).rejects.toThrow(
      "state",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([undefined, "access_denied", "raw-token-private-error"])(
    "consumes invalid/denied callback state without reflecting provider payload (%s)",
    async (error) => {
      const { state } = await begin();
      await expect(
        google.complete(session, state, undefined, error),
      ).rejects.toBeInstanceOf(OAuthAuthorizationError);
      expect(fetcher).not.toHaveBeenCalled();
      await expect(google.complete(session, state, "code")).rejects.toThrow(
        "state",
      );
    },
  );
  it.each([
    { ...identity, email_verified: false },
    { ...identity, sub: "" },
    { ...identity, email: "malformed" },
    { email: "owner@gmail.com", email_verified: true },
  ])(
    "rejects unverified or incomplete trusted identity before persisting credentials",
    async (invalid) => {
      fetcher.mockImplementation(async (url: string) =>
        Response.json(url.includes("userinfo") ? invalid : tokens),
      );
      await expect(connect()).rejects.toThrow("verified mailbox identity");
      expect(await database.db.select().from(mailAccounts)).toHaveLength(0);
    },
  );
  it("creates an encrypted Google account with Gmail defaults and generic IMAP/SMTP credentials", async () => {
    const id = await connect();
    const account = await row(id);
    expect(account).toMatchObject({
      email: "owner@gmail.com",
      imapUsername: "owner@gmail.com",
      authMethod: "oauth2",
      oauthProviderId: "google",
      oauthHomeAccountId: null,
      oauthStatus: "connected",
      ...google.getMailDefaults(),
    });
    expect(JSON.stringify(account)).not.toMatch(
      /refresh-private|access-private|code-private|client-private/,
    );
    expect(await authorization(id)).toEqual({
      version: 1,
      subject: identity.sub,
      refreshToken: "refresh-private",
    });
    const scheduler = { schedule: vi.fn(async () => true) };
    const service = new AccountsService(
      database.db,
      encryption,
      new ImapSmtpMailProvider(),
      scheduler,
      composition.registry,
    );
    await service.requestMailboxDiscovery(id);
    expect(scheduler.schedule).toHaveBeenCalledWith(id);
    expect((await row(id)).mailboxDiscoveryStatus).toBe("pending");
    const imap = await service.getProviderImapAccountForWork(id);
    const smtp = await service.getProviderSmtpAccountForWork(id);
    expect(imap.imap.credential).toEqual({
      kind: "oauth2",
      accessToken: "access-private",
    });
    expect(smtp.smtp.credential).toEqual(imap.imap.credential);
    expect(imapOptions(imap.imap)).toMatchObject({
      host: "imap.gmail.com",
      port: 993,
      secure: true,
      auth: { user: "owner@gmail.com", accessToken: "access-private" },
    });
    expect(smtpOptions(smtp.smtp)).toMatchObject({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: {
        type: "OAuth2",
        user: "owner@gmail.com",
        accessToken: "access-private",
      },
    });
    expect(JSON.stringify(await service.get(id))).not.toMatch(
      /refresh-private|access-private|oauthCache|ciphertext/,
    );
  });
  it("refreshes after expiry/restart, preserves omitted refresh tokens and persists rotations encrypted", async () => {
    const id = await connect();
    const initial = (await row(id)).oauthCache;
    fetcher.mockResolvedValue(
      Response.json({
        access_token: "renewed-access",
        token_type: "Bearer",
        expires_in: 3600,
      }),
    );
    expect(await google.accessToken(id)).toBe("renewed-access");
    expect((await row(id)).oauthCache).toEqual(initial);
    const newProvider = new GoogleOAuthProvider(database.db, encryption, {
      appOrigin: origin,
    });
    fetcher.mockResolvedValue(
      Response.json({
        ...tokens,
        access_token: "next-access",
        refresh_token: "rotated-refresh",
      }),
    );
    expect(await newProvider.accessToken(id)).toBe("next-access");
    expect(await authorization(id)).toMatchObject({
      refreshToken: "rotated-refresh",
    });
    expect(JSON.stringify(await row(id))).not.toContain("rotated-refresh");
    fetcher.mockResolvedValue(
      Response.json({
        access_token: "after-expiry",
        token_type: "Bearer",
        expires_in: 3600,
      }),
    );
    expect(await newProvider.accessToken(id)).toBe("after-expiry");
    expect(
      (fetcher.mock.calls.at(-1)![1].body as URLSearchParams).get(
        "refresh_token",
      ),
    ).toBe("rotated-refresh");
    expect(await authorization(id)).toMatchObject({
      refreshToken: "rotated-refresh",
    });
  });
  it("marks invalid_grant revoked authorization reconnect_required with safe errors", async () => {
    const id = await connect();
    fetcher.mockResolvedValue(
      Response.json(
        {
          error: "invalid_grant",
          error_description: "refresh-private raw provider error",
        },
        { status: 400 },
      ),
    );
    await expect(google.accessToken(id)).rejects.toThrow(
      "Reconnect the account",
    );
    expect((await row(id)).oauthStatus).toBe("reconnect_required");
  });
  it.each([429, 500, 503, 401, 400])(
    "keeps temporary/configuration token failures recoverable (%s)",
    async (status) => {
      const id = await connect();
      fetcher.mockResolvedValue(
        Response.json(
          { error: "invalid_client", error_description: "client-private" },
          { status },
        ),
      );
      await expect(google.accessToken(id)).rejects.toBeInstanceOf(
        OAuthAuthorizationError,
      );
      expect((await row(id)).oauthStatus).toBe("connected");
    },
  );
  it("sanitizes network exceptions and malformed token responses without marking revoked", async () => {
    const id = await connect();
    fetcher.mockRejectedValue(
      new Error("network with refresh-private client-private"),
    );
    await expect(google.accessToken(id)).rejects.toThrow(
      "temporarily unavailable",
    );
    expect((await row(id)).oauthStatus).toBe("connected");
    for (const invalid of [
      {},
      { ...tokens, expires_in: 0 },
      { ...tokens, token_type: "Other" },
    ]) {
      fetcher.mockResolvedValue(Response.json(invalid));
      await expect(google.accessToken(id)).rejects.toThrow(
        "usable access token",
      );
      expect((await row(id)).oauthStatus).toBe("connected");
    }
  });
  it("does not mistake disabled configuration for revoked account authorization", async () => {
    const id = await connect();
    await composition.configurations.save("google", {
      clientId: "google-client",
      enabled: false,
    });
    await expect(google.accessToken(id)).rejects.toThrow("not configured");
    expect((await row(id)).oauthStatus).toBe("connected");
  });
  it("requires initial offline authorization and full mail permission", async () => {
    fetcher.mockImplementation(async (url: string) =>
      Response.json(
        url.includes("userinfo")
          ? identity
          : { access_token: "access", token_type: "Bearer", expires_in: 3600 },
      ),
    );
    await expect(connect()).rejects.toThrow("offline access");
    fetcher.mockResolvedValue(
      Response.json({ ...tokens, scope: "openid email" }),
    );
    await expect(connect()).rejects.toThrow("Reconnect");
    expect(await database.db.select().from(mailAccounts)).toHaveLength(0);
  });
  it("reconnects the same stable subject, updates changed email and preserves ID/local mail state", async () => {
    const id = await connect();
    await database.db.insert(mailboxes).values({
      id: "00000000-0000-4000-8000-000000000001",
      accountId: id,
      remotePath: "INBOX",
      name: "Inbox",
      selectable: true,
      firstDiscoveredAt: new Date(),
      lastDiscoveredAt: new Date(),
    });
    await database.db
      .update(mailAccounts)
      .set({ oauthStatus: "reconnect_required" })
      .where(eq(mailAccounts.id, id));
    fetcher.mockImplementation(async (url: string) =>
      Response.json(
        url.includes("userinfo")
          ? { ...identity, email: "renamed@workspace.example" }
          : { ...tokens, refresh_token: "reconnected-refresh" },
      ),
    );
    expect(
      await google.complete(session, (await begin(id)).state, "reconnect-code"),
    ).toBe(id);
    expect(await row(id)).toMatchObject({
      email: "renamed@workspace.example",
      oauthStatus: "connected",
    });
    expect(await authorization(id)).toMatchObject({
      refreshToken: "reconnected-refresh",
    });
    expect(
      await database.db
        .select()
        .from(mailboxes)
        .where(eq(mailboxes.accountId, id)),
    ).toHaveLength(1);
  });
  it("rejects a different trusted subject even with the same email before replacing credentials", async () => {
    const id = await connect();
    const before = await row(id);
    const { state } = await begin(id);
    const [pending] = await database.db.select().from(oauthAuthorizationStates);
    expect(pending.accountId).toBe(id);
    fetcher.mockImplementation(async (url: string) =>
      Response.json(
        url.includes("userinfo")
          ? { ...identity, sub: "different-sub" }
          : { ...tokens, refresh_token: "wrong-account-refresh" },
      ),
    );
    await expect(google.complete(session, state, "code")).rejects.toThrow(
      "same Google account",
    );
    expect(await row(id)).toEqual(before);
  });
  it("preserves a still usable refresh token on reconnect when Google omits it", async () => {
    const id = await connect();
    fetcher.mockImplementation(async (url: string) =>
      Response.json(
        url.includes("userinfo")
          ? identity
          : { access_token: "access", token_type: "Bearer", expires_in: 3600 },
      ),
    );
    expect(
      await google.complete(session, (await begin(id)).state, "code"),
    ).toBe(id);
    expect(await authorization(id)).toMatchObject({
      refreshToken: "refresh-private",
    });
    expect(
      (fetcher.mock.calls.at(-1)![1].body as URLSearchParams).get("grant_type"),
    ).toBe("refresh_token");
  });
  it("rejects reconnect without a new token if the previous grant is revoked", async () => {
    const id = await connect();
    const before = await row(id);
    fetcher.mockImplementation(async (url: string, options: RequestInit) => {
      if (url.includes("userinfo")) return Response.json(identity);
      if (
        (options.body as URLSearchParams).get("grant_type") === "refresh_token"
      )
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({
        access_token: "access",
        token_type: "Bearer",
        expires_in: 3600,
      });
    });
    await expect(
      google.complete(session, (await begin(id)).state, "code"),
    ).rejects.toThrow("Reconnect");
    expect(await row(id)).toEqual(before);
  });
  it("rejects reconnect targets belonging to a different provider", async () => {
    const id = await connect();
    await database.db
      .update(mailAccounts)
      .set({ oauthProviderId: "microsoft" })
      .where(eq(mailAccounts.id, id));
    await expect(begin(id)).rejects.toThrow("not found");
  });
});
