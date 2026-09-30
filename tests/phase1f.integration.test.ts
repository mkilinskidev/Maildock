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
    async acquireTokenByCode(input: { code: string }) {
      fake.seenCode = input.code;
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
          homeAccountId: "home-1",
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
  MicrosoftOAuthService,
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
} from "@/shared/infrastructure/database/schema";

describe("Phase 1F Microsoft OAuth persistence and credential resolution", () => {
  let container: StartedTestContainer;
  let database: ReturnType<typeof createDatabase>;
  let oauth: MicrosoftOAuthService;
  let accounts: AccountsService;
  let accountId: string;

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
      ATTACHMENTS_PATH: "D:/Projects/JS/Maildock/.test-attachments",
      MICROSOFT_CLIENT_ID: "test-client",
      MICROSOFT_CLIENT_SECRET: "client-secret",
    });
    database = createDatabase(config);
    await migrate(database.db, { migrationsFolder: "db/migrations" });
    const encryption = new AesGcmSecretEncryption(
      config.credentialsEncryption.activeKeyId,
      config.credentialsEncryption.keys,
    );
    oauth = new MicrosoftOAuthService(database.db, encryption, config);
    accounts = new AccountsService(
      database.db,
      encryption,
      new ImapSmtpMailProvider(),
      undefined,
      oauth,
    );
  }, 120_000);

  afterAll(async () => {
    await database?.client.end();
    await container?.stop();
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
    expect(JSON.stringify(row)).not.toMatch(
      /refresh-secret|access-secret|code-secret|client-secret/,
    );
    const view = await accounts.get(accountId);
    expect(JSON.stringify(view)).not.toMatch(
      /refresh-secret|access-secret|code-secret|client-secret/,
    );
    expect(view.oauthStatus).toBe("connected");
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
