import { reseedNativeAccountFixture } from "./native-account-fixture";
import { readMigrationFiles } from "drizzle-orm/migrator";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  copyFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { accountCredentialContext } from "@/modules/accounts/domain/account";
import {
  OAuthProviderConfigs,
  providerSecretContext,
} from "@/modules/accounts/infrastructure/oauth-provider-configs";
import type { OAuthMailProvider } from "@/modules/accounts/domain/oauth-mail-provider";
import { OAuthProviderRegistry } from "@/modules/accounts/application/oauth-provider-registry";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  revoked: false,
  renew: false,
  seenCode: "",
  serial: "",
  homeAccountId: "home-1",
  verifier: "",
}));
vi.mock("@azure/msal-node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@azure/msal-node")>();
  class ConfidentialClientApplication {
    private cache = "";
    constructor(
      private readonly configuration: {
        cache?: {
          cachePlugin?: {
            beforeCacheAccess(context: unknown): Promise<void>;
            afterCacheAccess(context: unknown): Promise<void>;
          };
        };
      },
    ) {}
    private context(changed: boolean) {
      return {
        cacheHasChanged: changed,
        tokenCache: {
          deserialize: (value: string) => {
            this.cache = value;
          },
          serialize: () => this.cache,
        },
      };
    }
    async getAuthCodeUrl(input: {
      state: string;
      codeChallenge: string;
      scopes: string[];
    }) {
      return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=${input.state}&code_challenge=${input.codeChallenge}&scope=${encodeURIComponent(input.scopes.join(" "))}`;
    }
    async acquireTokenByCode(input: { code: string; codeVerifier: string }) {
      fake.seenCode = input.code;
      fake.verifier = input.codeVerifier;
      this.cache = JSON.stringify({
        refreshToken: "refresh-secret-v1",
        accessToken: "access-secret-v1",
      });
      await this.configuration.cache?.cachePlugin?.afterCacheAccess(
        this.context(true),
      );
      return {
        account: {
          username: "owner@example.com",
          homeAccountId: fake.homeAccountId,
          name: "Owner",
        },
        accessToken: "access-secret-v1",
      };
    }
    getTokenCache() {
      return {
        getAllAccounts: async () => {
          await this.configuration.cache?.cachePlugin?.beforeCacheAccess(
            this.context(false),
          );
          return [{ username: "owner@example.com", homeAccountId: "home-1" }];
        },
      };
    }
    async acquireTokenSilent() {
      if (fake.revoked) throw new Error("invalid_grant");
      if (fake.renew) {
        this.cache = JSON.stringify({
          refreshToken: "refresh-secret-v2",
          accessToken: "access-secret-v2",
        });
        await this.configuration.cache?.cachePlugin?.afterCacheAccess(
          this.context(true),
        );
      }
      return {
        accessToken: fake.renew ? "access-secret-v2" : "access-secret-v1",
      };
    }
  }
  return { ...actual, ConfidentialClientApplication };
});

import {
  MicrosoftOAuthProvider,
  microsoftScopes,
} from "@/modules/accounts/infrastructure/microsoft-oauth";
import { AccountsService } from "@/modules/accounts/application/accounts-service";
import {
  ImapSmtpMailProvider,
  imapOptions,
  smtpOptions,
} from "@/modules/accounts/infrastructure/imap-smtp-mail-provider";
import { AesGcmSecretEncryption } from "@/shared/infrastructure/crypto/aes-gcm-secret-encryption";
import { parseConfig } from "@/shared/infrastructure/config/config";
import { createDatabase } from "@/shared/infrastructure/database/database";
import {
  mailAccounts,
  oauthAuthorizationStates,
  oauthProviderConfigs,
} from "@/shared/infrastructure/database/schema";

describe("Phase 1F Microsoft OAuth persistence and credential resolution", () => {
  let container: StartedTestContainer;
  let database: ReturnType<typeof createDatabase>;
  let oauth: MicrosoftOAuthProvider;
  let accounts: AccountsService;
  let accountId: string;
  let configurations: OAuthProviderConfigs;
  let encryption: AesGcmSecretEncryption;
  const legacyId = randomUUID();
  let legacyCache: unknown;

  beforeAll(async () => {
    container = await new GenericContainer("postgres:18.6-bookworm")
      .withEnvironment({
        POSTGRES_DB: "maildock_phase1f",
        POSTGRES_USER: "maildock",
        POSTGRES_PASSWORD: "maildock-test",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/, 2),
      )
      .start();
    const config = parseConfig({
      MAILDOCK_ENV: "test",
      APP_ORIGIN: "http://localhost:3000",
      DATABASE_URL: `postgresql://maildock:maildock-test@${container.getHost()}:${container.getMappedPort(5432)}/maildock_phase1f`,
      AUTH_SECRET: Buffer.alloc(32, 1).toString("base64"),
      CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString("base64"),
      ATTACHMENTS_PATH: process.cwd(),
      MICROSOFT_CLIENT_ID: "test-client",
      MICROSOFT_CLIENT_SECRET: "client-secret",
    });
    database = createDatabase(config);
    encryption = new AesGcmSecretEncryption(
      config.credentialsEncryption.activeKeyId,
      config.credentialsEncryption.keys,
    );
    // Upgrade a real Phase 3F schema with an already connected account and
    // a pending authorization. No volumes or account credentials are reset.
    const folder = await mkdtemp(join(tmpdir(), "maildock-3f-"));
    try {
      await mkdir(join(folder, "meta"));
      const journal = JSON.parse(
        await readFile("db/migrations/meta/_journal.json", "utf8"),
      );
      journal.entries = journal.entries.filter(
        (entry: { idx: number }) => entry.idx < 26,
      );
      await writeFile(
        join(folder, "meta/_journal.json"),
        JSON.stringify(journal),
      );
      for (const entry of journal.entries)
        await copyFile(
          `db/migrations/${entry.tag}.sql`,
          join(folder, `${entry.tag}.sql`),
        );
      await migrate(database.db, { migrationsFolder: folder });
    } finally {
      if (!resolve(folder).startsWith(resolve(tmpdir()) + sep))
        throw Error("Unexpected temporary migration path");
      await rm(folder, { recursive: true, force: true });
    }
    legacyCache = encryption.encrypt(
      JSON.stringify({
        refreshToken: "refresh-secret-v1",
        accessToken: "access-secret-v1",
      }),
      accountCredentialContext(legacyId, "oauth-cache"),
    );
    await database.client`INSERT INTO mail_accounts (id, display_name, email, auth_method, oauth_cache, oauth_home_account_id, oauth_status, imap_host, imap_port, imap_security, imap_username, smtp_host, smtp_port, smtp_security) VALUES (${legacyId}, 'Legacy', 'owner@example.com', 'oauth2', ${JSON.stringify(legacyCache)}::jsonb, 'home-1', 'connected', 'outlook.office365.com', 993, 'tls', 'owner@example.com', 'smtp.office365.com', 587, 'starttls')`;
    await database.client`INSERT INTO oauth_authorization_states (state_hash, session_id, code_verifier, expires_at) VALUES ('legacy-pending', 'owner-session', ${JSON.stringify(encryption.encrypt("legacy-verifier", "maildock:microsoft-oauth-state:v1"))}::jsonb, now() + interval '10 minutes')`;
    const allMigrations = readMigrationFiles({
      migrationsFolder: "db/migrations",
    });
    for (const migration of allMigrations.slice(26, 36))
      await database.client.begin(async (tx) => {
        for (const statement of migration.sql) await tx.unsafe(statement);
      });
    await reseedNativeAccountFixture(database, allMigrations[36]);
    for (const migration of allMigrations.slice(37))
      await database.client.begin(async (tx) => {
        for (const statement of migration.sql) await tx.unsafe(statement);
      });
    // Record exact release history for the reseeded synthetic fixture.
    await database.client`delete from drizzle.__drizzle_migrations`;
    for (const migration of allMigrations)
      await database.client`insert into drizzle.__drizzle_migrations(hash,created_at) values(${migration.hash},${migration.folderMillis})`;

    configurations = new OAuthProviderConfigs(
      database.db,
      encryption,
      config.appOrigin,
    );
    oauth = new MicrosoftOAuthProvider(database.db, encryption, config);
    accounts = new AccountsService(
      database.db,
      encryption,
      new ImapSmtpMailProvider(),
      undefined,
      new OAuthProviderRegistry([oauth]),
    );
  }, 120_000);

  afterAll(async () => {
    await database?.client.end();
    await container?.stop();
  });

  it("upgrades an existing account without changing its cache or requiring reconnect", async () => {
    expect(await oauth.isConfigured()).toBe(true);
    const [row] = await database.db
      .select()
      .from(mailAccounts)
      .where(eq(mailAccounts.id, legacyId));
    expect(row.oauthProviderId).toBe("microsoft");
    expect(row.oauthCache).toEqual(legacyCache);
    expect(row.oauthStatus).toBe("connected");
    expect(
      (await accounts.getProviderImapAccountForWork(legacyId)).imap.credential,
    ).toEqual({ kind: "oauth2", accessToken: "access-secret-v1" });
    const [pending] = await database.db
      .select()
      .from(oauthAuthorizationStates)
      .where(eq(oauthAuthorizationStates.stateHash, "legacy-pending"));
    expect(pending.providerId).toBe("microsoft");
  });

  it("bootstraps once, keeps DB authoritative, and encrypts replacements while blank preserves the secret", async () => {
    const definition = oauth.getDefinition();
    const [before] = await database.db.select().from(oauthProviderConfigs);
    expect(before.clientId).toBe("test-client");
    expect(
      encryption.decrypt(
        before.encryptedClientSecret,
        providerSecretContext("microsoft"),
      ),
    ).toBe("client-secret");
    expect(JSON.stringify(before)).not.toContain("client-secret");
    await oauth.bootstrap();
    expect((await database.db.select().from(oauthProviderConfigs))[0]).toEqual(
      before,
    );
    await configurations.save("microsoft", {
      clientId: "db-client",
      clientSecret: "replacement-private",
    });
    const [replaced] = await database.db.select().from(oauthProviderConfigs);
    expect(replaced.encryptedClientSecret).not.toEqual(
      before.encryptedClientSecret,
    );
    expect(JSON.stringify(replaced)).not.toContain("replacement-private");
    await configurations.save("microsoft", {
      clientId: "db-client-2",
      clientSecret: "",
    });
    await oauth.bootstrap();
    const [kept] = await database.db.select().from(oauthProviderConfigs);
    expect(kept.clientId).toBe("db-client-2");
    expect(kept.encryptedClientSecret).toEqual(replaced.encryptedClientSecret);
    const view = await configurations.view(definition);
    expect(view).toMatchObject({
      hasClientSecret: true,
      configured: true,
      redirectUri: "http://localhost:3000/api/oauth/microsoft/callback",
    });
    expect(view).not.toHaveProperty("encryptedClientSecret");
    expect(JSON.stringify(view)).not.toContain("replacement-private");
    expect(() =>
      encryption.decrypt(
        kept.encryptedClientSecret,
        accountCredentialContext(legacyId, "oauth-cache"),
      ),
    ).toThrow();
    await configurations.save("microsoft", {
      clientId: "db-client-2",
      enabled: false,
    });
    expect(await oauth.isConfigured()).toBe(false);
    expect((await accounts.get(legacyId)).oauthStatus).toBe("connected");
    await configurations.save("microsoft", {
      clientId: "db-client-2",
      enabled: true,
    });
  });

  it("keeps registry isolation and rejects unsupported persisted receive providers", async () => {
    const id = randomUUID();
    const provider: OAuthMailProvider = {
      id: "test-provider",
      getDefinition: () => ({ ...oauth.getDefinition(), id: "test-provider" }),
      isConfigured: async () => true,
      begin: async () => "test-url",
      complete: async () => id,
      accessToken: vi.fn(async () => "test-access"),
      getMailDefaults: () => oauth.getMailDefaults(),
    };
    const registry = new OAuthProviderRegistry([oauth, provider]);
    expect(registry.get("microsoft")).toBe(oauth);
    expect(registry.get("test-provider")).toBe(provider);
    expect(() => registry.get("unknown")).toThrow("unavailable");
    expect(() => registry.get(null)).toThrow("unavailable");
    await expect(
      database.db.insert(mailAccounts).values({
        id,
        displayName: "Test",
        email: "fake@example.com",
        authMethod: "oauth2",
        oauthProviderId: provider.id,
        oauthStatus: "connected",
        oauthCache: encryption.encrypt(
          "test-private-cache",
          accountCredentialContext(id, "oauth-cache"),
        ),
        ...provider.getMailDefaults(),
        imapUsername: "fake@example.com",
      }),
    ).rejects.toThrow();
    expect(provider.accessToken).not.toHaveBeenCalled();
    await expect(oauth.begin("session-1", id)).rejects.toThrow("not found");
    const callback = new URL(await oauth.begin("session-1"));
    await database.db
      .update(oauthAuthorizationStates)
      .set({ providerId: provider.id });
    await expect(
      oauth.complete("session-1", callback.searchParams.get("state")!, "code"),
    ).rejects.toThrow("state");
  });

  it("validates one-time state, creates an account, and persists only encrypted cache", async () => {
    const expiredUrl = new URL(await oauth.begin("session-1"));
    await database.db
      .update(oauthAuthorizationStates)
      .set({ expiresAt: new Date(0) });
    await expect(
      oauth.complete(
        "session-1",
        expiredUrl.searchParams.get("state")!,
        "code-secret",
      ),
    ).rejects.toThrow("state");
    const url = new URL(await oauth.begin("session-1"));
    const state = url.searchParams.get("state")!;
    const [pending] = await database.db
      .select()
      .from(oauthAuthorizationStates)
      .where(
        eq(
          oauthAuthorizationStates.stateHash,
          createHash("sha256").update(state).digest("hex"),
        ),
      );
    const verifier = encryption.decrypt(
      pending.codeVerifier,
      "maildock:microsoft-oauth-state:v1",
    );
    expect(JSON.stringify(pending.codeVerifier)).not.toContain(verifier);
    expect(url.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(verifier).digest("base64url"),
    );
    expect(pending.providerId).toBe("microsoft");

    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    for (const scope of microsoftScopes)
      expect(url.searchParams.get("scope")).toContain(scope);
    await expect(
      oauth.complete("wrong-session", state, "code-secret"),
    ).rejects.toThrow("state");
    await expect(
      oauth.complete("session-1", "wrong-state", "code-secret"),
    ).rejects.toThrow("state");
    accountId = await oauth.complete("session-1", state, "code-secret");
    expect(fake.seenCode).toBe("code-secret");
    expect(fake.verifier.length).toBeGreaterThanOrEqual(32);
    expect(state.length).toBeGreaterThanOrEqual(43);
    await expect(
      oauth.complete("session-1", state, "code-secret"),
    ).rejects.toThrow("state");
    const [row] = await database.db
      .select()
      .from(mailAccounts)
      .where(eq(mailAccounts.id, accountId));
    expect(row.authMethod).toBe("oauth2");
    expect(row.imapPassword).toBeNull();
    expect(row.oauthCache).toBeTruthy();
    expect(
      JSON.stringify(row, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    ).not.toMatch(/refresh-secret|access-secret|code-secret|client-secret/);
    const view = await accounts.get(accountId);
    expect(JSON.stringify(view)).not.toMatch(
      /refresh-secret|access-secret|code-secret|client-secret/,
    );
    expect(view.oauthStatus).toBe("connected");
    expect(view.oauthProviderName).toBe("Microsoft");
    expect(view.oauthAuthorizationPath).toBe("/api/oauth/microsoft/start");
  });

  it("resolves configuration and renews tokens with a one-connection pool", async () => {
    const single = createDatabase({
      databaseUrl: `postgresql://maildock:maildock-test@${container.getHost()}:${container.getMappedPort(5432)}/maildock_phase1f`,
      databasePoolSize: 1,
    });
    try {
      const provider = new MicrosoftOAuthProvider(single.db, encryption, {
        appOrigin: "http://localhost:3000",
        microsoft: { clientId: "", clientSecret: "" },
      });
      expect(await provider.accessToken(accountId)).toBe("access-secret-v1");
    } finally {
      await single.client.end();
    }
  }, 10000);

  it("requires the same remote Microsoft identity on reconnect", async () => {
    const url = new URL(await oauth.begin("session-1", accountId));
    expect(
      await oauth.complete(
        "session-1",
        url.searchParams.get("state")!,
        "reconnect-code",
      ),
    ).toBe(accountId);
    const other = new URL(await oauth.begin("session-1", accountId));
    const [before] = await database.db
      .select()
      .from(mailAccounts)
      .where(eq(mailAccounts.id, accountId));
    fake.homeAccountId = "different-account";
    await expect(
      oauth.complete(
        "session-1",
        other.searchParams.get("state")!,
        "other-code",
      ),
    ).rejects.toThrow("same Microsoft account");
    fake.homeAccountId = "home-1";
    const [after] = await database.db
      .select()
      .from(mailAccounts)
      .where(eq(mailAccounts.id, accountId));
    expect(after.oauthCache).toEqual(before.oauthCache);
  });

  it("resolves worker credentials, persists rotated cache, and marks revoked authorization", async () => {
    fake.renew = true;
    const resolved = await accounts.getProviderImapAccountForWork(accountId);
    expect(resolved.imap.credential).toEqual({
      kind: "oauth2",
      accessToken: "access-secret-v2",
    });
    expect(imapOptions(resolved.imap).auth).toEqual({
      user: "owner@example.com",
      accessToken: "access-secret-v2",
    });
    const [row] = await database.db
      .select()
      .from(mailAccounts)
      .where(eq(mailAccounts.id, accountId));
    expect(JSON.stringify(row.oauthCache)).not.toContain("refresh-secret-v2");
    const smtp = smtpOptions({
      ...resolved.imap,
      host: "smtp.office365.com",
      port: 587,
      security: "starttls",
    });
    expect(smtp.auth).toEqual({
      type: "OAuth2",
      user: "owner@example.com",
      accessToken: "access-secret-v2",
    });
    fake.revoked = true;
    await expect(
      accounts.getProviderImapAccountForWork(accountId),
    ).rejects.toThrow("Reconnect");
    expect((await accounts.get(accountId)).oauthStatus).toBe(
      "reconnect_required",
    );
  });
});
