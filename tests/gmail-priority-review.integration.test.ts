import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { PgBoss } from "pg-boss";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDatabase } from "@/shared/infrastructure/database/database";
import {
  installSyncAdmission,
  syncCandidatesSql,
  SYNC_QUEUES,
} from "@/modules/mail/infrastructure/sync-admission";
import {
  ensureGmailQueue,
  GMAIL_SYNC_QUEUE,
} from "@/modules/mail/infrastructure/gmail-sync-jobs";
import { GmailSyncService } from "@/modules/mail/application/gmail-sync-service";
import { GmailProvider } from "@/modules/mail/infrastructure/gmail-provider";
import { createGmailAccountLock } from "@/modules/mail/infrastructure/gmail-account-lock";
import type { AccountsService } from "@/modules/accounts/application/accounts-service";
import { gmailSyncWork } from "@/shared/infrastructure/database/schema";
import { SyntheticGmail } from "./helpers/gmail-fixture";

import { readGmailPriorityDecision } from "@/modules/mail/infrastructure/gmail-priority-decision";

function baselineSql() {
  const source = execFileSync(
    "git",
    [
      "show",
      "73406ff39f821303395af4d8fdd47b1a910b9408:src/modules/mail/infrastructure/sync-admission.ts",
    ],
    { encoding: "utf8" },
  );
  const marker = "export const syncCandidatesSql = `";
  const start = source.indexOf(marker) + marker.length;
  return source
    .slice(start, source.indexOf("`;", start))
    .replace("${GMAIL_HISTORY_PENDING_HIGH_WATER - 1}", "4499");
}

const benchmark = process.env.MAILDOCK_PHASE3B_BENCHMARK === "1";
describe("Gmail Phase 3b targeted review on disposable PostgreSQL", () => {
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
    database = createDatabase({ databaseUrl, databasePoolSize: 3 });
    await migrate(database.db, { migrationsFolder: "db/migrations" });
    boss = new PgBoss({ connectionString: databaseUrl });
    await boss.start();
    await ensureGmailQueue(boss);
  });
  afterAll(async () => {
    await boss?.stop();
    await database?.client.end();
    await container?.stop();
  });
  async function seed(
    accounts: number,
    identities: number,
    ceiling: boolean,
    inventoryHeavy = false,
  ) {
    await boss.deleteAllJobs(GMAIL_SYNC_QUEUE);
    await database.client`delete from mail_accounts`;
    const ids = Array.from({ length: accounts }, () => randomUUID());
    for (const id of ids) {
      await database.client`insert into mail_accounts(id,display_name,email,provider_type,auth_method,oauth_provider_id,oauth_home_account_id,oauth_cache,oauth_status,smtp_host,smtp_port,smtp_security,smtp_uses_imap_credentials,smtp_username)
        values(${id},'Review','owner@test.invalid','gmail_smtp','oauth2','google',${id},'{}','connected','smtp.test',465,'tls',false,'owner')`;
    }
    await database.client`insert into gmail_account_sync_state(account_id,account_revision,status,recent_ready,baseline_history_id,history_id,history_run_id,history_start_id,history_candidate_id,history_pages_complete,history_drain_due,history_discovered_at,inventory_run_id,inventory_phase,recent_cutoff,priority_burst,last_lower_priority)
      select id,1,'ready',true,'100','100',gen_random_uuid(),'100',${ceiling ? null : "101"},${!ceiling},${!ceiling},now(),gen_random_uuid(),'historical',now(),case when ordinal%3=0 then 8 when ordinal%3=1 then 1 else 0 end,case when ordinal%2=0 then 1 else 2 end
      from unnest(${ids}::uuid[]) with ordinality a(id,ordinal)`;
    // Balanced matrix spreads total identities across accounts. Ceiling cases
    // concentrate them on one hot account, including legacy over-ceiling work.
    await database.client`insert into gmail_sync_work(account_id,account_revision,run_id,purpose,gmail_message_id,priority_class,created_at)
      select a.id,1,case when p.class=2 then s.inventory_run_id else s.history_run_id end,
        case when p.class=2 then 'inventory' else 'history' end,'work-'||g.i,p.class,
        now()-case when g.i%4=0 then interval '2 minutes' else interval '1 second' end
      from generate_series(0,${identities - 1}) g(i)
      join unnest(${ids}::uuid[]) with ordinality a(id,ordinal) on a.ordinal=case when ${ceiling || inventoryHeavy} then 1 else g.i%${accounts}+1 end
      join gmail_account_sync_state s on s.account_id=a.id
      cross join lateral(select case when ${inventoryHeavy} then case when g.i%10<9 then 2 when g.i%20<10 then 0 else 1 end when ${ceiling} then case when g.i%10<9 then 1 else 2 end
        when (g.i/${accounts})%10<4 then 0 when (g.i/${accounts})%10<7 then 1 else 2 end as class) p`;
    await boss.insert(
      GMAIL_SYNC_QUEUE,
      ids.map((accountId) => ({
        data: { version: 1, accountId, accountRevision: "1" },
        singletonKey: accountId,
      })),
    );
    // Other accounts hold active/retry jobs, leaving the hot account eligible.
    await database.client`update pgboss.job set state='active',started_on=now(),priority=100 where name=${GMAIL_SYNC_QUEUE} and data->>'accountId'=any(${ids.filter((_, i) => i === 1 || (i > 0 && i % 13 === 0 && i < 78))}::text[])`;
    await database.client`update pgboss.job set state='retry',start_after=now()+interval '10 minutes',retry_count=1 where name=${GMAIL_SYNC_QUEUE} and data->>'accountId'=any(${ids.filter((_, i) => i === 2 || (i > 0 && i % 13 !== 0 && i % 11 === 0))}::text[])`;
    await database.client`update gmail_account_sync_state set next_attempt_at=now()+interval '10 minutes',error_category='quota' where account_id=any(${ids.filter((_, i) => i === 3 || (i > 0 && i % 17 === 0))}::uuid[])`;
    await database.client`analyze gmail_sync_work`;
    await database.client`analyze gmail_account_sync_state`;
    await database.client`analyze mail_accounts`;
    // These fixtures exercise drain/discovery admission after a fresh INBOX observation.
    await database.client`update gmail_account_sync_state set inbox_synced_at=now()`;
    await database.client`analyze pgboss.job_common`;
    return ids;
  }
  async function worker(id: string) {
    const remote = new SyntheticGmail();
    const work = await database.db
      .select()
      .from(gmailSyncWork)
      .where(eq(gmailSyncWork.accountId, id));
    for (const item of work)
      remote.fixture(
        item.gmailMessageId,
        item.priorityClass === 0 ? ["INBOX"] : ["Label_one"],
      );
    const accounts = {
      getProviderGmailAccountForWork: async (_id: string, revision = "1") => ({
        accountId: id,
        revision,
        accessToken: "fixture",
      }),
    } as unknown as AccountsService;
    const provider = new GmailProvider(database.db, accounts, remote.fetch, {
      MAILDOCK_GMAIL_USER_UNITS_PER_MINUTE: 1000000,
      MAILDOCK_GMAIL_PROJECT_UNITS_PER_MINUTE: 10000000,
      MAILDOCK_GMAIL_DAILY_UNITS: 10000000,
    });
    const debug = vi.fn();
    return {
      remote,
      debug,
      service: new GmailSyncService(
        database.db,
        provider,
        createGmailAccountLock(database.client),
        30,
        { debug },
      ),
    };
  }
  it("admission and actual drain agree despite host/database clock skew", async () => {
    const [id] = await seed(1, 30, false);
    const result = await boss
      .getDb()
      .executeSql(syncCandidatesSql, [[...SYNC_QUEUES], 2]);
    const w = await worker(id);
    const skew = vi.spyOn(Date, "now").mockReturnValue(Date.now() - 3600000);
    try {
      await w.service.run(id, "1");
    } finally {
      skew.mockRestore();
    }
    const slice = w.debug.mock.calls
      .map(([value]) => value)
      .find((value) => value.event === "mail.gmail_priority_slice");
    expect(slice.priorityClass).toBe(`P${result.rows[0].class}`);
  });
  it("admits a due INBOX observation as P0 even when historical fairness would select P2", async () => {
    const [id] = await seed(1, 30, false);
    await database.client`update gmail_account_sync_state set inbox_synced_at=null,priority_burst=8,last_lower_priority=1 where account_id=${id}`;
    const admission = await boss
      .getDb()
      .executeSql(syncCandidatesSql, [[...SYNC_QUEUES], 2]);
    expect(admission.rows[0].class).toBe(0);
    expect((await readGmailPriorityDecision(database.db, id)).action).toBe(
      "inbox_reconcile",
    );
    const w = await worker(id);
    for (const message of w.remote.messages.values())
      message.labelIds = ["Label_one"];
    w.remote.fixture("new-current", ["INBOX", "UNREAD"]);
    await w.service.run(id, "1", undefined, false, 0);
    expect(w.remote.requests.map((r) => r.path)).toEqual([
      "messages",
      "messages/new-current",
    ]);
    expect(
      w.debug.mock.calls.some(
        ([v]) => v.event === "mail.gmail_priority_changed",
      ),
    ).toBe(false);
    await database.client`update gmail_account_sync_state set error_category='invalid_response' where account_id=${id}`;
    expect((await readGmailPriorityDecision(database.db, id)).action).toBe(
      "drain",
    );
    expect(
      (await readGmailPriorityDecision(database.db, id)).priority_class,
    ).toBe(2);
  });
  it.each([
    ["mixed fresh P0", 0, 1, false, 0],
    ["eight slices alternate to P2", 8, 1, false, 2],
    ["eight slices alternate to P1", 8, 2, false, 1],
    ["aged lower work alternates P2", 1, 1, true, 2],
    ["aged lower work alternates P1", 1, 2, true, 1],
    ["age alone cannot preempt first P0", 0, 1, true, 0],
  ])(
    "compares identical persisted state: %s",
    async (_name, burst, last, aged, expected) => {
      const [id] = await seed(1, 30, false);
      await database.client`update gmail_account_sync_state set priority_burst=${burst},last_lower_priority=${last}`;
      await database.client`update gmail_sync_work set created_at=now()-case when ${aged} then interval '61 seconds' else interval '1 second' end`;
      const admitted = await boss
        .getDb()
        .executeSql(syncCandidatesSql, [[...SYNC_QUEUES], 2]);
      const decision = await readGmailPriorityDecision(database.db, id);
      expect(admitted.rows[0].class).toBe(expected);
      expect(decision.priority_class).toBe(expected);
      const w = await worker(id);
      await w.service.run(id, "1", undefined, false, expected as number);
      const slice = w.debug.mock.calls
        .map(([value]) => value)
        .find((value) => value.event === "mail.gmail_priority_slice");
      expect(slice.priorityClass).toBe(`P${expected}`);
      const [state] =
        await database.client`select history_id,priority_burst,last_lower_priority from gmail_account_sync_state where account_id=${id}`;
      expect(state.history_id).toBe("100"); // A drain never owns the checkpoint.
      expect(state.priority_burst).toBe(expected === 0 ? 1 : 0);
      if (expected !== 0) expect(state.last_lower_priority).toBe(expected);
    },
  );

  it.each([
    ["discovery below ceiling", 30, "history_discover", 0],
    ["discovery at ceiling", 5000, "drain", 1],
  ])(
    "compares %s including inventory backlog",
    async (_name, count, action, expected) => {
      const [id] = await seed(1, count as number, true);
      const admission = await boss
        .getDb()
        .executeSql(syncCandidatesSql, [[...SYNC_QUEUES], 2]);
      const decision = await readGmailPriorityDecision(database.db, id);
      expect(decision.action).toBe(action);
      expect(admission.rows[0].class).toBe(expected);
      const w = await worker(id);
      await w.service.run(id, "1", undefined, false, expected as number);
      if (action === "drain") {
        expect(
          w.debug.mock.calls.some(
            ([v]) =>
              v.event === "mail.gmail_priority_slice" &&
              v.priorityClass === "P1",
          ),
        ).toBe(true);
        expect(w.remote.requests.some((r) => r.path === "history")).toBe(false);
      } else
        expect(w.remote.requests.some((r) => r.path === "history")).toBe(true);
    },
  );

  it.each([false, true])(
    "compares inventory with history discovery due=%s",
    async (due) => {
      const [id] = await seed(1, 30, false);
      await database.client`delete from gmail_sync_work where priority_class<2`;
      await database.client`update gmail_account_sync_state set history_run_id=null,history_start_id=null,history_candidate_id=null,history_pages_complete=false,history_discovered_at=now()-case when ${due} then interval '61 seconds' else interval '1 second' end`;
      const decision = await readGmailPriorityDecision(database.db, id);
      const admission = await boss
        .getDb()
        .executeSql(syncCandidatesSql, [[...SYNC_QUEUES], 2]);
      expect(decision.action).toBe(due ? "history_start" : "inventory");
      expect(admission.rows[0].class).toBe(due ? 0 : 2);
      const w = await worker(id);
      await w.service.run(id, "1", undefined, false, due ? 0 : 2);
      const [state] =
        await database.client`select history_run_id from gmail_account_sync_state where account_id=${id}`;
      if (due) {
        expect(state.history_run_id).not.toBeNull();
        expect(w.remote.requests).toHaveLength(0);
      } else {
        expect(state.history_run_id).toBeNull();
        expect(w.remote.requests.some((r) => r.path === "labels")).toBe(true);
      }
    },
  );

  it("ignores aged stale-revision rows before worker cleanup", async () => {
    const [id] = await seed(1, 30, false);
    await database.client`update gmail_sync_work set created_at=now()-interval '1 second'`;
    await database.client`insert into gmail_sync_work(account_id,account_revision,run_id,purpose,gmail_message_id,priority_class,created_at)
      select account_id,2,history_run_id,'history','stale',1,now()-interval '2 minutes' from gmail_account_sync_state`;
    if (benchmark) {
      const original = await boss
        .getDb()
        .executeSql(baselineSql(), [[...SYNC_QUEUES], 2]);
      expect(original.rows[0].class).toBe(1);
    }
    const admission = await boss
      .getDb()
      .executeSql(syncCandidatesSql, [[...SYNC_QUEUES], 2]);
    expect(admission.rows[0].class).toBe(0);
    const w = await worker(id);
    await w.service.run(id, "1", undefined, false, 0);
    expect(
      w.debug.mock.calls.some(
        ([v]) =>
          v.event === "mail.gmail_priority_slice" && v.priorityClass === "P0",
      ),
    ).toBe(true);
  });

  it("excludes stale revisions from the discovery ceiling", async () => {
    const [id] = await seed(1, 30, true);
    await database.client`insert into gmail_sync_work(account_id,account_revision,run_id,purpose,gmail_message_id,priority_class)
      select s.account_id,2,s.history_run_id,'history','stale-'||g.i,1 from gmail_account_sync_state s cross join generate_series(1,5000) g(i)`;
    expect((await readGmailPriorityDecision(database.db, id)).action).toBe(
      "history_discover",
    );
    const admission = await boss
      .getDb()
      .executeSql(syncCandidatesSql, [[...SYNC_QUEUES], 2]);
    expect(admission.rows[0].class).toBe(0);
    const w = await worker(id);
    await w.service.run(id, "1", undefined, false, 0);
    expect(w.remote.requests.some((r) => r.path === "history")).toBe(true);
    const [remaining] =
      await database.client`select count(*)::int as count from gmail_sync_work where account_revision=2`;
    expect(remaining.count).toBe(4500); // Preserve bounded cleanup, independent of ceiling decisions.
  });

  it("admission anticipates revision reset and stale deliveries retain authority fencing", async () => {
    const [id] = await seed(1, 30, false);
    await database.client`delete from gmail_sync_work where priority_class=0`;
    await database.client`update mail_accounts set work_revision=2 where id=${id}`;
    if (benchmark) {
      const original = await boss
        .getDb()
        .executeSql(baselineSql(), [[...SYNC_QUEUES], 2]);
      expect(original.rows[0].class).toBe(1);
    }
    const admission = await boss
      .getDb()
      .executeSql(syncCandidatesSql, [[...SYNC_QUEUES], 2]);
    expect(admission.rows[0].class).toBe(0);
    const w = await worker(id);
    await expect(w.service.run(id, "1")).rejects.toThrow();
    expect(w.remote.requests).toHaveLength(0);
    await w.service.run(id, "2", undefined, false, 0);
    expect(w.remote.requests.some((r) => r.path === "profile")).toBe(true);
  });

  it("exposes the frozen pg-boss class and yields on transitions before execution", async () => {
    const [id] = await seed(1, 30, false);
    await database.client`update gmail_account_sync_state set priority_burst=0`;
    const restore = installSyncAdmission(boss, 2);
    try {
      const [job] = await boss.fetch(GMAIL_SYNC_QUEUE, {
        includeMetadata: true,
      });
      expect(job.priority).toBe(100);
      await database.client`update gmail_account_sync_state set priority_burst=8,last_lower_priority=1`;
      const w = await worker(id);
      await w.service.run(id, "1", undefined, false, 0);
      expect(w.remote.requests).toHaveLength(0);
      expect(
        w.debug.mock.calls.some(
          ([v]) => v.event === "mail.gmail_priority_changed",
        ),
      ).toBe(true);
      await boss.complete(GMAIL_SYNC_QUEUE, job.id);
      await boss.send(
        GMAIL_SYNC_QUEUE,
        { version: 1, accountId: id, accountRevision: "1" },
        { singletonKey: id },
      );
      const [next] = await boss.fetch(GMAIL_SYNC_QUEUE, {
        includeMetadata: true,
      });
      expect(next.priority).toBe(-10);
      await w.service.run(id, "1", undefined, false, 2);
      expect(
        w.debug.mock.calls.some(
          ([v]) =>
            v.event === "mail.gmail_priority_slice" && v.priorityClass === "P2",
        ),
      ).toBe(true);
      await boss.complete(GMAIL_SYNC_QUEUE, next.id);
    } finally {
      restore();
    }
  });

  it.each(["quota", "network"])(
    "retains %s and retry-job deadlines",
    async (category) => {
      const [id] = await seed(1, 30, false);
      await database.client`update gmail_account_sync_state set next_attempt_at=now()+interval '10 minutes',error_category=${category}`;
      expect(
        (
          await boss
            .getDb()
            .executeSql(syncCandidatesSql, [[...SYNC_QUEUES], 2])
        ).rows,
      ).toHaveLength(0);
      const w = await worker(id);
      await w.service.run(id, "1", undefined, false, 0);
      expect(w.remote.requests).toHaveLength(0);
      await database.client`update gmail_account_sync_state set next_attempt_at=null`;
      await database.client`update pgboss.job set state='retry',retry_count=1,start_after=now()+interval '10 minutes' where name=${GMAIL_SYNC_QUEUE}`;
      expect(
        (
          await boss
            .getDb()
            .executeSql(syncCandidatesSql, [[...SYNC_QUEUES], 2])
        ).rows,
      ).toHaveLength(0);
      const [job] =
        await database.client`select retry_count from pgboss.job where name=${GMAIL_SYNC_QUEUE}`;
      expect(job.retry_count).toBe(1);
    },
  );
  it.each([
    "history_probe",
    "history_checkpoint",
    "inventory_clock",
    "history_start",
  ])("compares the P0/P2 transition %s", async (action) => {
    const [id] = await seed(1, 30, false);
    if (action === "history_probe") {
      await database.client`update gmail_account_sync_state set history_discovered_at=now()-interval '61 seconds'`;
    } else if (action === "history_checkpoint") {
      await database.client`delete from gmail_sync_work where purpose='history'`;
    } else {
      await database.client`delete from gmail_sync_work`;
      await database.client`update gmail_account_sync_state set history_run_id=null,history_start_id=null,history_candidate_id=null,history_pages_complete=false,history_discovered_at=null,
        inventory_run_id=case when ${action}='inventory_clock' then inventory_run_id else null end,inventory_phase=case when ${action}='inventory_clock' then inventory_phase else null end`;
    }
    const admission = await boss
      .getDb()
      .executeSql(syncCandidatesSql, [[...SYNC_QUEUES], 2]);
    const decision = await readGmailPriorityDecision(database.db, id);
    expect(decision.action).toBe(action);
    expect(admission.rows[0].class).toBe(action === "inventory_clock" ? 2 : 0);
    const w = await worker(id);
    await w.service.run(id, "1", undefined, false, admission.rows[0].class);
    expect(
      w.debug.mock.calls.some(
        ([v]) => v.event === "mail.gmail_priority_changed",
      ),
    ).toBe(false);
    const [state] =
      await database.client`select history_id,history_pages_complete,history_start_id,history_run_id,history_discovered_at from gmail_account_sync_state where account_id=${id}`;
    if (action === "history_probe") {
      expect(state.history_id).toBe("100");
      expect(state.history_start_id).toBe("101");
      expect(state.history_pages_complete).toBe(false);
    }
    if (action === "history_checkpoint") expect(state.history_id).toBe("101");
    if (action === "inventory_clock")
      expect(state.history_discovered_at).not.toBeNull();
    if (action === "history_start") expect(state.history_run_id).not.toBeNull();
  });

  it.skipIf(!benchmark)(
    "measures baseline and candidate SQL over the full account/backlog matrix",
    async () => {
      const baseline = baselineSql();
      type PlanNode = { [key: string]: unknown; Plans?: PlanNode[] };
      const results = [];
      for (const distribution of [
        "balanced-mixed",
        "hot-history-ceiling",
        "hot-inventory-heavy",
      ])
        for (const accounts of [10, 50, 100])
          for (const identities of [500, 5000, 20000]) {
            const ceiling = distribution === "hot-history-ceiling";
            await seed(
              accounts,
              identities,
              ceiling,
              distribution === "hot-inventory-heavy",
            );
            const samples: Record<string, unknown[]> = {
              before: [],
              after: [],
            };
            for (const [name, query] of [
              ["before", baseline],
              ["after", syncCandidatesSql],
            ]) {
              await boss.getDb().executeSql(query, [[...SYNC_QUEUES], 8]); // Untimed warm-up.
              for (let i = 0; i < 3; i++) {
                const result = await boss
                  .getDb()
                  .executeSql(
                    `explain (analyze,buffers,format json) ${query}`,
                    [[...SYNC_QUEUES], 8],
                  );
                const plan = result.rows[0]["QUERY PLAN"][0];
                const scans: unknown[] = [];
                function walk(node: PlanNode) {
                  if (node["Relation Name"] === "gmail_sync_work")
                    scans.push({
                      node: node["Node Type"],
                      index: node["Index Name"],
                      loops: node["Actual Loops"],
                      rows: node["Actual Rows"],
                      removed: node["Rows Removed by Filter"],
                      hits: node["Shared Hit Blocks"],
                      ms: node["Actual Total Time"],
                    });
                  for (const child of node.Plans ?? []) walk(child);
                }
                walk(plan.Plan);
                samples[name].push({
                  executionMs: plan["Execution Time"],
                  planningMs: plan["Planning Time"],
                  sharedHitBlocks: plan.Plan["Shared Hit Blocks"],
                  sharedReadBlocks: plan.Plan["Shared Read Blocks"],
                  scans,
                  ...(i === 0 ? { plan } : {}),
                });
              }
            }
            results.push({
              accounts,
              identities,
              distribution,
              samples,
            });
            console.info(
              "Gmail review benchmark",
              JSON.stringify({
                accounts,
                identities,
                ceiling,
                before: samples.before.map(
                  (s) => (s as { executionMs: number }).executionMs,
                ),
                after: samples.after.map(
                  (s) => (s as { executionMs: number }).executionMs,
                ),
              }),
            );
          }
      const indexes =
        await database.client`select tablename,indexname,indexdef from pg_indexes where schemaname in ('public','pgboss') and tablename in ('gmail_sync_work','gmail_account_sync_state','mail_accounts','job_common') order by tablename,indexname`;
      const settings =
        await database.client`select name,setting,unit from pg_settings where name in ('jit','jit_above_cost','jit_inline_above_cost','jit_optimize_above_cost','shared_buffers','work_mem','max_connections') order by name`;
      const [version] = await database.client`select version()`;
      await writeFile(
        "docs/validation/sync-priority-phase-3b-review-benchmark.json",
        JSON.stringify(
          {
            version: version.version,
            indexes,
            settings,
            baselineCommit: "73406ff39f821303395af4d8fdd47b1a910b9408",
            accountsAndIdentities:
              "Identity counts are TOTAL per scenario, not per account; hot scenarios concentrate all identities on one account.",
            samplesPerQuery: 3,
            warmupPerQuery: 1,
            capacity: 8,
            results,
          },
          null,
          2,
        ) + "\n",
      );
      expect(results).toHaveLength(27);
    },
    600000,
  );
});
