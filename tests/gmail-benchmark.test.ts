import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { GenericContainer, Wait } from "testcontainers";
import { it, expect } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq, sql } from "drizzle-orm";
import { createDatabase } from "@/shared/infrastructure/database/database";
import {
  mailAccounts,
  gmailAccountSyncState,
  messages,
  mailboxes,
} from "@/shared/infrastructure/database/schema";
import { AesGcmSecretEncryption } from "@/shared/infrastructure/crypto/aes-gcm-secret-encryption";
import type { AccountsService } from "@/modules/accounts/application/accounts-service";
import { GmailProvider } from "@/modules/mail/infrastructure/gmail-provider";
import { createGmailAccountLock } from "@/modules/mail/infrastructure/gmail-account-lock";
import { GmailSyncService } from "@/modules/mail/application/gmail-sync-service";
import { MessageContentService } from "@/modules/mail/application/message-content-service";
import type { MailProvider } from "@/modules/accounts/domain/mail-provider";
import { SyntheticGmail } from "./helpers/gmail-fixture";

/** Explicitly opt-in: disposable DB + synthetic HTTP only; never uses DATABASE_URL. */
it.runIf(process.env.MAILDOCK_GMAIL_BENCHMARK === "1")(
  "41k end-to-end synthetic native inventory/restart/interactive benchmark",
  async () => {
    const container = await new GenericContainer("postgres:18.6-bookworm")
      .withEnvironment({
        POSTGRES_DB: "maildock",
        POSTGRES_USER: "maildock",
        POSTGRES_PASSWORD: "test",
      })
      .withCopyContentToContainer([
        {
          content: await readFile(
            "scripts/postgres/99-maildock-authority.sql",
            "utf8",
          ),
          target: "/docker-entrypoint-initdb.d/99-maildock-authority.sql",
        },
      ])
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/, 2),
      )
      .start();
    const database = createDatabase({
      databaseUrl: `postgresql://maildock:test@${container.getHost()}:${container.getMappedPort(5432)}/maildock`,
      databasePoolSize: 1,
    });
    try {
      await migrate(database.db, { migrationsFolder: "db/migrations" });
      const remote = new SyntheticGmail();
      const labels = [
        ["INBOX", "UNREAD", "Label_one"],
        ["SENT", "Label_one"],
        ["TRASH"],
        ["SPAM"],
        ["Label_one"],
      ];
      const now = Date.now();
      for (let i = 0; i < 41000; i++)
        remote.fixture(
          `m-${i}`,
          labels[i % labels.length],
          i < 100 ? now : now - 60 * 86400000,
        );
      const initialRss = process.memoryUsage().rss;
      const accountId = randomUUID();
      const encryption = new AesGcmSecretEncryption("v1", {
        v1: Buffer.alloc(32, 9).toString("base64"),
      });
      await database.db.insert(mailAccounts).values({
        id: accountId,
        displayName: "Benchmark",
        email: "owner@example.test",
        providerType: "gmail_smtp",
        authMethod: "oauth2",
        oauthProviderId: "google",
        oauthHomeAccountId: "synthetic",
        oauthCache: encryption.encrypt(
          "fixture",
          `maildock:account-credential:v1:${accountId}:oauth-cache`,
        ),
        oauthStatus: "connected",
        smtpHost: "smtp.gmail.com",
        smtpPort: 465,
        smtpSecurity: "tls",
        smtpUsesImapCredentials: false,
        smtpUsername: "owner@example.test",
      });
      const accounts = {
        getProviderGmailAccountForWork: async () => ({
          accountId,
          revision: "1",
          accessToken: "synthetic",
        }),
      } as unknown as AccountsService;
      const provider = new GmailProvider(database.db, accounts, remote.fetch, {
        MAILDOCK_GMAIL_USER_UNITS_PER_MINUTE: 1000000000,
        MAILDOCK_GMAIL_PROJECT_UNITS_PER_MINUTE: 1000000000,
        MAILDOCK_GMAIL_DAILY_UNITS: 1000000000,
      });
      const transactionSamples: number[] = [];
      let transactionCount = 0;
      let peakRss = initialRss;
      const lock = createGmailAccountLock(
        database.client,
        ({ transactionMs }) => {
          transactionCount++;
          if (transactionSamples.length < 10000)
            transactionSamples.push(transactionMs);
          else transactionSamples[transactionCount % 10000] = transactionMs;
        },
      );
      let sync = new GmailSyncService(database.db, provider, lock, 30);
      const state = async () =>
        (
          await database.db
            .select()
            .from(gmailAccountSyncState)
            .where(eq(gmailAccountSyncState.accountId, accountId))
        )[0];
      const content = new MessageContentService(
        database.db,
        { schedule: async () => true },
        accounts,
        {} as MailProvider,
        { maxMessageTextPartBytes: 100000 },
        provider,
      );
      const querySamples: number[] = [];
      const interactiveSamples: number[] = [];
      let recentReadyMs: number | null = null;
      let restarts = 0;
      let slices = 0;
      let restartRecoveryMs: number | null = null;
      const start = performance.now();
      for (; slices < 10000; slices++) {
        const work = sync.run(accountId, "1");
        if (
          recentReadyMs !== null &&
          slices % 500 === 0 &&
          interactiveSamples.length < 6
        ) {
          const interactiveStart = performance.now();
          const [row] = await database.db
            .select()
            .from(messages)
            .where(
              eq(
                messages.providerMessageId,
                `m-${interactiveSamples.length * 5}`,
              ),
            );
          const [box] = await database.db
            .select()
            .from(mailboxes)
            .where(eq(mailboxes.providerMailboxId, "INBOX"));
          await content.request(accountId, box.id, row.id);
          await content.run(accountId, box.id, row.id, 1, "1");
          interactiveSamples.push(performance.now() - interactiveStart);
        }
        await work;
        const current = await state();
        if (current.recentReady && recentReadyMs === null)
          recentReadyMs = performance.now() - start;
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
        if (slices % 100 === 0) {
          const queryStart = performance.now();
          await database.db.execute(
            sql`select count(*) from public.gmail_sync_work where account_id=${accountId}::uuid`,
          );
          querySamples.push(performance.now() - queryStart);
          console.log(
            JSON.stringify({
              slice: slices,
              processed: current.processedCount.toString(),
              elapsedMs: performance.now() - start,
            }),
          );
        }
        if (slices > 0 && slices % 1000 === 0) {
          sync = new GmailSyncService(database.db, provider, lock, 30);
          restarts++;
          const restartStart = performance.now();
          await sync.run(accountId, "1");
          restartRecoveryMs = performance.now() - restartStart;
        }
        if (current.inventoryComplete && !current.historyRunId) break;
      }
      const inventoryMs = performance.now() - start;
      expect((await state()).inventoryComplete).toBe(true);
      const [count] = await database.db
        .select({ count: sql<number>`count(*)::int` })
        .from(messages)
        .where(eq(messages.accountId, accountId));
      expect(count.count).toBe(41000);
      const quotaBefore = (await state()).quotaDailyUnits;
      async function delta() {
        await database.db
          .update(gmailAccountSyncState)
          .set({ nextAttemptAt: null })
          .where(eq(gmailAccountSyncState.accountId, accountId));
        const start = performance.now();
        for (let i = 0; i < 100; i++) {
          await sync.run(accountId, "1");
          if (i > 0 && !(await state()).historyRunId)
            return performance.now() - start;
        }
        throw new Error("Delta did not finish");
      }
      const noChangesMs = await delta();
      for (let i = 0; i < 4; i++) remote.change(`m-${i}`, ["INBOX", "STARRED"]);
      const fourChangesMs = await delta();
      const final = await state();
      const distribution = (samples: number[]) => {
        const sorted = [...samples].sort((a, b) => a - b);
        return {
          samples: samples.length,
          p50Ms: sorted[Math.floor(sorted.length * 0.5)] ?? null,
          p95Ms: sorted[Math.floor(sorted.length * 0.95)] ?? null,
          maxMs: sorted.at(-1) ?? null,
        };
      };
      const report = {
        kind: "synthetic HTTP + disposable PostgreSQL, no live Gmail",
        messages: 41000,
        poolSize: 1,
        concurrency: 4,
        quotaThrottling:
          "disabled for throughput measurement; limiter tested separately",
        recentWindowMessages: 100,
        recentReadyMs,
        inventoryMs,
        noChangesMs,
        fourChangesMs,
        quotaUnitsInventory: quotaBefore.toString(),
        quotaUnitsAfterDeltas: final.quotaDailyUnits.toString(),
        httpRequests: remote.requests.length,
        queryRoundtrip: distribution(querySamples),
        transactions: {
          total: transactionCount,
          ...distribution(transactionSamples),
        },
        interactiveDuringBackfill: distribution(interactiveSamples),
        initialRssMiB: initialRss / 1048576,
        peakRssMiB: peakRss / 1048576,
        memoryIncludesSyntheticRemoteFixture: true,
        restarts,
        restartRecoveryMs,
        slices,
        bodyFetchRequests: remote.requests.filter(
          (r) =>
            r.path.startsWith("messages/") &&
            !r.query.has("fields") &&
            r.method === "GET",
        ).length,
      };
      await mkdir("docs/validation", { recursive: true });
      await writeFile(
        "docs/validation/gmail-synthetic-benchmark.json",
        JSON.stringify(report, null, 2) + "\n",
      );
      console.log(JSON.stringify(report));
    } finally {
      await database.client.end();
      await container.stop();
    }
  },
  3600000,
);
