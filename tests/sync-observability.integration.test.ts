import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { PgBoss } from "pg-boss";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabase } from "@/shared/infrastructure/database/database";
import {
  SyncObservationStore,
  diagnosticExecutor,
} from "@/modules/mail/infrastructure/sync-observation-store";
import { readSyncObservability } from "@/modules/mail/infrastructure/read-sync-observability";
import { GmailSyncService } from "@/modules/mail/application/gmail-sync-service";
import { GmailProvider } from "@/modules/mail/infrastructure/gmail-provider";
import { createGmailAccountLock } from "@/modules/mail/infrastructure/gmail-account-lock";
import {
  projectGmailMessage,
  projectGmailLabels,
} from "@/modules/mail/infrastructure/gmail-projector";
import { GmailApiError } from "@/modules/accounts/infrastructure/gmail-client";
import type { AccountsService } from "@/modules/accounts/application/accounts-service";
import { SyntheticGmail } from "./helpers/gmail-fixture";
import { ApplicationEventService } from "@/modules/diagnostics/application/application-event-service";

describe("sync observability on disposable PostgreSQL", () => {
  let container: StartedTestContainer;
  let database: ReturnType<typeof createDatabase>;
  let boss: PgBoss;
  beforeAll(async () => {
    container = await new GenericContainer("postgres:18.6-bookworm")
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
    const databaseUrl = `postgresql://maildock:test@${container.getHost()}:${container.getMappedPort(5432)}/maildock`;
    database = createDatabase({ databaseUrl, databasePoolSize: 1 });
    await migrate(database.db, { migrationsFolder: "db/migrations" });
    boss = new PgBoss({ connectionString: databaseUrl });
    await boss.start();
    await boss.createQueue("gmail-account-sync-v1");
  });
  afterAll(async () => {
    await boss?.stop();
    await database?.client.end();
    await container?.stop();
  });
  async function account(gmail = true) {
    const id = randomUUID();
    await database.client`insert into mail_accounts(id,display_name,email,provider_type,auth_method,oauth_provider_id,oauth_home_account_id,oauth_cache,oauth_status,smtp_host,smtp_port,smtp_security,smtp_uses_imap_credentials,smtp_username)
      values(${id},'Diagnostics','owner@test.invalid','gmail_smtp','oauth2','google',${id},'{}','connected','smtp.test',465,'tls',false,'owner')`;
    if (gmail)
      await database.client`insert into gmail_account_sync_state(account_id,account_revision,status,recent_ready,baseline_history_id,history_id,inbox_synced_at) values(${id},1,'ready',true,'100','100',now())`;
    return id;
  }
  it("reports the actual active phase, protects newer operation tokens, and fences revisions", async () => {
    const id = await account();
    const first = new SyncObservationStore(
      diagnosticExecutor(database.db),
      id,
      "1",
    );
    await first.start("history_drain", 1);
    expect(await readSyncObservability(database.db, id, 60)).toMatchObject({
      phase: "history_drain",
      priority: 1,
      worker: "executing",
    });
    const second = new SyncObservationStore(
      diagnosticExecutor(database.db),
      id,
      "1",
    );
    await second.start("inbox", 0);
    await first.finish();
    expect(await readSyncObservability(database.db, id, 60)).toMatchObject({
      phase: "inbox",
      priority: 0,
      worker: "executing",
    });
    await second.finish();
    await second.start("history_drain", 1);
    await database.client`update sync_observations set active_until=now()-interval '1 second' where account_id=${id}`;
    expect((await readSyncObservability(database.db, id, 60))?.phase).toBe(
      "idle",
    );
    await database.client`update mail_accounts set work_revision=2 where id=${id}`;
    await first.start("history_drain", 1);
    expect(await readSyncObservability(database.db, id, 60)).toMatchObject({
      freshness: "unknown",
      phase: "idle",
      events: [],
    });
  });
  it("bounds stored history and expires old events including inactive accounts", async () => {
    const id = await account();
    const store = new SyncObservationStore(
      diagnosticExecutor(database.db),
      id,
      "1",
    );
    await store.start("inbox", 0);
    const writes: number[] = [];
    for (let n = 0; n < 85; n++) {
      const start = performance.now();
      await store.record("completed", { count: n }, { running: true });
      writes.push(performance.now() - start);
    }
    const [row] =
      await database.client`select jsonb_array_length(events) as count,pg_column_size(events) as bytes,octet_length(events::text) as logical_bytes from sync_observations where account_id=${id}`;
    expect(row.count).toBe(80);
    const samples: number[] = [];
    for (let n = 0; n < 20; n++) {
      const start = performance.now();
      await readSyncObservability(database.db, id, 60);
      samples.push(performance.now() - start);
    }
    await writeFile(
      ".sync-observability-benchmark.log",
      JSON.stringify({
        storedEvents: row.count,
        eventBytes: row.bytes,
        logicalEventBytes: row.logical_bytes,
        writes: writes.length,
        meanWriteMs: writes.reduce((a, b) => a + b, 0) / writes.length,
        maxWriteMs: Math.max(...writes),
        reads: samples.length,
        meanReadMs: samples.reduce((a, b) => a + b, 0) / samples.length,
        maxReadMs: Math.max(...samples),
      }),
    );
    await database.client`update sync_observations set events=jsonb_build_array(jsonb_build_object('at',(now()-interval '25 hours'),'kind','completed','phase','inbox','priority',0)) where account_id=${id}`;
    await new ApplicationEventService(database.db).cleanup();
    const [retained] =
      await database.client`select jsonb_array_length(events) as count from sync_observations where account_id=${id}`;
    expect(retained.count).toBe(0);
    await store.record("recovery");
    const d = await readSyncObservability(database.db, id, 60);
    expect(d?.events).toHaveLength(1);
  });
  it("derives live lock and queued admission evidence without touching the provider", async () => {
    const id = await account();
    await database.client`update gmail_account_sync_state set inbox_synced_at=now()-interval '90 seconds' where account_id=${id}`;
    await boss.send("gmail-account-sync-v1", {
      accountId: id,
      accountRevision: "1",
    });
    expect(await readSyncObservability(database.db, id, 60)).toMatchObject({
      worker: "queued",
      freshness: "overdue",
    });
    const authority = createGmailAccountLock(database.client);
    await authority(id, async () => {
      expect((await readSyncObservability(database.db, id, 60))?.reason).toBe(
        "Another account operation holds the lock.",
      );
    });
  });
  it("records complete INBOX checks, actual read changes and quota recovery with unchanged cadence", async () => {
    const id = await account();
    const remote = new SyntheticGmail();
    remote.fixture("private-provider-id");
    const accounts = {
      getProviderGmailAccountForWork: vi.fn(async () => ({
        accountId: id,
        revision: "1",
        accessToken: "secret-token",
      })),
    } as unknown as AccountsService;
    const provider = new GmailProvider(database.db, accounts, remote.fetch, {
      MAILDOCK_GMAIL_USER_UNITS_PER_MINUTE: 6000,
      MAILDOCK_GMAIL_PROJECT_UNITS_PER_MINUTE: 100000,
      MAILDOCK_GMAIL_DAILY_UNITS: 2000000,
    });
    const sync = new GmailSyncService(
      database.db,
      provider,
      createGmailAccountLock(database.client),
    );
    await sync.run(id, "1"); // prepare labels/history
    await database.client`update gmail_account_sync_state set inbox_synced_at=null,next_attempt_at=null where account_id=${id}`;
    // INBOX must exist before projection.
    await projectGmailLabels(
      database.db,
      id,
      "1",
      remote.labels.map((l) => ({
        ...l,
        type: l.type === "system" ? ("system" as const) : ("user" as const),
      })),
    );
    await sync.run(id, "1");
    expect(
      (await readSyncObservability(database.db, id, 60))?.lastCheckAt,
    ).toBeNull();
    await sync.run(id, "1");
    let d = await readSyncObservability(database.db, id, 60);
    expect(d?.lastCheckAt).not.toBeNull();
    expect(d?.lastMaterializedAt).not.toBeNull();
    expect(
      d?.events.some((e) => e.kind === "materialized" && e.newMessages === 1),
    ).toBe(true);
    const checkTime = d!.lastCheckAt!;
    expect(Date.parse(d!.nextCheckAt!) - Date.parse(checkTime)).toBe(60000);
    remote.change("private-provider-id", ["INBOX"]);
    const changes = await projectGmailMessage(
      database.db,
      id,
      "1",
      "private-provider-id",
      remote.messages.get("private-provider-id")!,
    );
    expect(changes).toMatchObject({ newMessages: 0, readChanges: 1 });
    remote.change("private-provider-id", ["INBOX", "UNREAD"]);
    await database.client`update gmail_account_sync_state set inbox_synced_at=now()-interval '90 seconds',next_attempt_at=null where account_id=${id}`;
    const client = provider.client.bind(provider);
    const spy = vi.spyOn(provider, "client").mockImplementation((...args) => {
      const c = client(...args);
      vi.spyOn(c, "messages").mockRejectedValueOnce(
        new GmailApiError("quota", 30000, 429, {
          source: "gmail_http",
          reasons: ["rateLimitExceeded"],
          retryAfter: "30",
        }),
      );
      return c;
    });
    await sync.run(id, "1");
    spy.mockRestore();
    d = await readSyncObservability(database.db, id, 60);
    expect(d).toMatchObject({
      worker: "rate_limited",
      refusal: {
        source: "gmail_http",
        status: 429,
        reasons: ["rateLimitExceeded"],
      },
    });
    // Worker guards use the Node clock; Docker's DB clock may differ slightly.
    await database.client`update gmail_account_sync_state set next_attempt_at=${new Date(Date.now() - 60_000).toISOString()}::timestamptz where account_id=${id}`;
    await sync.run(id, "1");
    await sync.run(id, "1");
    d = await readSyncObservability(database.db, id, 60);
    expect(d?.worker).not.toBe("rate_limited");
    expect(d?.refusal?.status).toBe(429);
    expect(d?.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "recovery" })]),
    );
    expect(
      d?.events.some((e) => e.kind === "materialized" && e.readChanges === 1),
    ).toBe(true);
    expect(JSON.stringify(d)).not.toMatch(
      /private-provider-id|secret-token|Subject|hello/,
    );
  });
});
