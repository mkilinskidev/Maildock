/** Standalone real-server smoke; never imported by worker composition. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import {
  checkOracle,
  historyCandidates,
  verifySnapshot,
  type Snapshot,
  type Placement,
  type Identity,
} from "./stage3c-oracle";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { ImapFlow } from "imapflow";
import { createDatabase } from "../../src/shared/infrastructure/database/database";
import {
  mailAccounts,
  mailboxes,
} from "../../src/shared/infrastructure/database/schema";
import { ReceivingExecutor } from "../../src/shared/infrastructure/database/receiving-executor";
import { ReceivingScheduler } from "../../src/modules/mail/application/receiving-scheduler";
import type { ReceivingCoordinatorConfig } from "../../src/modules/mail/application/receiving-coordinator";
import { generate, message } from "./fixture";

const image =
  "dovecot/dovecot:2.4.3-dev@sha256:d0db02b4aa9c16bc50c96faad68fcf5724c1453a98a39ada685409227e967898";
if (process.argv.includes("--check")) {
  checkOracle();
  process.exit(0);
}
const started = performance.now();
const deadline = started + 300_000;
const evidence: Record<string, unknown> = {
  started: new Date().toISOString(),
  image,
  outcomes: {},
  runs: [],
};
const outcomes = evidence.outcomes as Record<string, string>;
const containers: StartedTestContainer[] = [];
const clients: ImapFlow[] = [];
let scheduler: ReceivingScheduler | undefined;
let executor: ReceivingExecutor | undefined;
let reader: postgres.Sql | undefined;
let database: ReturnType<typeof createDatabase> | undefined;
let captureFailure: (() => Promise<void>) | undefined;
const save = () =>
  writeFileSync(
    new URL("stage3c-evidence.json", import.meta.url),
    JSON.stringify(
      evidence,
      (_, v) => (typeof v === "bigint" ? String(v) : v),
      2,
    ) + "\n",
  );
let expire!: ReturnType<typeof setTimeout>;
const expired = new Promise<never>((_, reject) => {
  expire = setTimeout(
    () =>
      reject(
        new Error("PARTIAL: 280-second execution cutoff reserves cleanup time"),
      ),
    280_000,
  );
});
const hardStop = setTimeout(() => {
  evidence.hardStop =
    "PARTIAL: 295-second emergency exit; launcher owns remaining container cleanup";
  save();
  process.exit(2);
}, 295_000);
async function until(work: () => Promise<boolean>, name: string, ms = 20_000) {
  const end = Math.min(deadline - 15_000, performance.now() + ms);
  while (performance.now() < end) {
    if (await work()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`PARTIAL: ${name} exceeded ${ms}ms scenario deadline`);
}
async function command(container: StartedTestContainer, args: string[]) {
  const result = await container.exec(args);
  assert.equal(result.exitCode, 0, result.output);
  return result.output.trim();
}
async function smoke() {
  console.log(
    "Preparing disposable real Dovecot/PostgreSQL (budget includes setup)",
  );
  const root = fileURLToPath(new URL("./", import.meta.url));
  const ca = await readFile(new URL(".runtime/tls/tls.crt", import.meta.url));
  const dovecot = await new GenericContainer(image)
    .withLabels({ "maildock.stage3c": "disposable" })
    .withCommand(["dovecot", "-F"])
    .withAddedCapabilities("SYS_CHROOT")
    .withBindMounts([
      {
        source: `${root}dovecot.conf`,
        target: "/etc/dovecot/dovecot.conf",
        mode: "ro",
      },
      { source: `${root}.runtime/tls`, target: "/etc/dovecot/ssl", mode: "ro" },
    ])
    .withExposedPorts(31993)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();
  containers.push(dovecot);
  const pg = await new GenericContainer("postgres:17.6-alpine")
    .withLabels({ "maildock.stage3c": "disposable" })
    .withEnvironment({
      POSTGRES_USER: "fixture",
      POSTGRES_PASSWORD: "fixture-only",
      POSTGRES_DB: "stage3c",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(
      Wait.forLogMessage(/database system is ready to accept connections/, 2),
    )
    .start();
  containers.push(pg);
  const url = `postgres://fixture:fixture-only@${pg.getHost()}:${pg.getMappedPort(5432)}/stage3c`;
  database = createDatabase({ databaseUrl: url, databasePoolSize: 2 });
  reader = postgres(url, { max: 3 });
  const db = reader;
  await migrate(database.db, { migrationsFolder: "db/migrations" });
  evidence.versions = {
    dovecot: await command(dovecot, ["dovecot", "--version"]),
    postgres: (await db`select version()`)[0].version,
    node: process.version,
  };
  await db.unsafe(`CREATE TABLE stage3c_audit (mailbox uuid, epoch bigint, revision bigint, old_f bigint, new_f bigint, old_e bigint, new_e bigint, metadata jsonb);
    CREATE FUNCTION stage3c_audit_progress() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    INSERT INTO stage3c_audit SELECT NEW.mailbox_id,NEW.epoch,NEW.revision,OLD.fresh_through,NEW.fresh_through,OLD.history_before,NEW.history_before,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('uid',p.uid,'epoch',p.uid_validity::text,'account',m.account_id::text,'id',m.rfc_message_id) ORDER BY p.uid)
    FROM mailbox_messages p JOIN messages m ON m.id=p.message_id WHERE p.mailbox_id=NEW.mailbox_id AND p.uid_validity=NEW.epoch
    AND ((p.uid>OLD.fresh_through AND p.uid<=NEW.fresh_through) OR (p.uid>=NEW.history_before AND p.uid<OLD.history_before))), '[]'::jsonb);
    RETURN NEW; END $$;
    CREATE TRIGGER stage3c_audit AFTER UPDATE ON receiving_mailboxes FOR EACH ROW EXECUTE FUNCTION stage3c_audit_progress();`);
  await generate(1000);
  await dovecot.copyFilesToContainer([
    { source: `${root}fixtures/1000/mailbox.tar`, target: "/tmp/fixture.tar" },
  ]);
  await command(dovecot, [
    "sh",
    "-c",
    "mkdir -p /tmp/fixture && tar -xf /tmp/fixture.tar -C /tmp/fixture",
  ]);
  const users = Array.from({ length: 5 }, (_, i) => `stage3c-${i + 1}`);
  const inventories = new Map<
    string,
    { epoch: string; next: number; items: { uid: number; id: string }[] }
  >();
  async function open(user: string) {
    const client = new ImapFlow({
      host: dovecot.getHost(),
      port: dovecot.getMappedPort(31993),
      secure: true,
      auth: { user, pass: "maildock-disposable-only" },
      tls: { ca, servername: "localhost" },
      logger: false,
      disableAutoIdle: true,
      disableCompression: true,
      connectionTimeout: 3000,
      greetingTimeout: 3000,
      socketTimeout: 5000,
    });
    clients.push(client);
    client.on("error", () => {});
    await client.connect();
    await client.mailboxOpen("INBOX");
    return client;
  }
  for (const user of users) {
    await command(dovecot, [
      "doveadm",
      "import",
      "-u",
      user,
      "maildir:/tmp/fixture",
      "",
      "all",
    ]);
    const client = await open(user);
    await client.messageDelete("100,500", { uid: true });
    await client.mailboxOpen("INBOX");
    assert(client.mailbox);
    const items = [];
    for await (const row of client.fetch(
      "1:*",
      { uid: true, envelope: true },
      { uid: true },
    ))
      items.push({ uid: row.uid, id: row.envelope!.messageId! });
    assert.equal(items.length, 998);
    assert.equal(new Set(items.map((v) => v.id)).size, 998);
    for (const item of items)
      assert.match(item.id, /^<initial-2403-\d{6}@maildock.invalid>$/);
    inventories.set(user, {
      epoch: String(client.mailbox.uidValidity),
      next: client.mailbox.uidNext,
      items,
    });
    await client.logout();
  }
  evidence.fixture = {
    accounts: 5,
    imported: 5000,
    retained: 4990,
    setupMs: performance.now() - started,
    inventories: structuredClone(Object.fromEntries(inventories)),
  };
  outcomes.fixture = "PASS";
  evidence.serverInventory = Object.fromEntries(inventories);
  console.log(`Fixture ready in ${Math.round(performance.now() - started)}ms`);
  save();
  for (const workers of [2, 4]) {
    const run: Record<string, unknown> = {
      workers,
      admissions: [],
      completedEvidence: [],
      turns: [],
      errors: [],
      injections: [],
      boundaries: [],
      retirements: [],
    };
    (evidence.runs as unknown[]).push(run);
    outcomes[`W${workers}`] = "PARTIAL: started";
    const admissions = run.admissions as {
      account: string;
      kind: string;
      active: number;
      at: number;
    }[];
    const errors = run.errors as {
      user: string;
      retry: number;
      at: number;
      error: string;
    }[];
    const turns = run.turns as {
      user: string;
      kind: string;
      f: string;
      e: string;
      revision: string;
      at: number;
    }[];
    const injections = run.injections as {
      user: string;
      uid: number;
      id: string;
      ack: string;
      ackMs: number;
      visible?: string;
      latencyMs?: number;
    }[];
    const records: { user: string; client: ImapFlow; retired: boolean }[] = [];
    const identities: Identity[] = [];
    run.accounts = identities;
    const accounts: Omit<ReceivingCoordinatorConfig, "executor">[] = [];
    let history = false,
      wave = false,
      waveSettled = false,
      disabled = false;
    let maxSockets = 0,
      overlap = false;
    const actor = randomUUID();
    await db`update receiving_coordinator set expires_at='-infinity'`;
    const [lease] =
      await db`select maildock_receiving_takeover(${actor},60000) as generation`;
    const owner = { actor, generation: BigInt(lease.generation) };
    executor = new ReceivingExecutor(url, 2);
    run.timing = {
      pollMs: 5000,
      operationMs: 4000,
      retryMs: 200,
      maxRetryMs: 800,
      historyWaitMs: 30000,
    };
    const resourceSnapshot = () => ({
      maxSockets,
      overlap,
      liveOwned: records.filter((r) => !r.retired).length,
      activeSlots: scheduler?.snapshot.active,
      rssBytes: process.memoryUsage().rss,
    });
    for (const user of users) {
      const fixtureClient = await open(user);
      assert(fixtureClient.mailbox);
      const baselineNext = fixtureClient.mailbox.uidNext;
      inventories.get(user)!.next = baselineNext;
      await fixtureClient.logout();
      const account = randomUUID(),
        mailbox = randomUUID();
      identities.push({ user, account, mailbox, baselineNext });
      await database.db.insert(mailAccounts).values({
        id: account,
        displayName: `Stage3C W${workers} ${user}`,
        email: `${user}@example.invalid`,
        imapHost: "fixture.invalid",
        imapPort: 993,
        imapSecurity: "tls",
        imapUsername: user,
        imapPassword: {
          version: 1,
          algorithm: "AES-256-GCM",
          keyId: "fixture",
          iv: "fixture",
          ciphertext: "fixture",
          authTag: "fixture",
        },
        smtpHost: "fixture.invalid",
        smtpPort: 465,
        smtpSecurity: "tls",
      });
      await database.db.insert(mailboxes).values({
        id: mailbox,
        accountId: account,
        remotePath: "INBOX",
        name: "INBOX",
        selectable: true,
        firstDiscoveredAt: new Date(),
        lastDiscoveredAt: new Date(),
      });
      accounts.push({
        account,
        mailbox,
        owner,
        connection: {
          host: dovecot.getHost(),
          port: dovecot.getMappedPort(31993),
          security: "tls",
          username: user,
          credential: {
            kind: "password",
            password: "maildock-disposable-only",
          },
        },
        authority: {
          assertCurrent: () => {},
          renew: async (tx) => {
            const [current] = await tx.execute(
              sql`select owner,generation,expires_at>clock_timestamp() as live from receiving_coordinator where singleton for update`,
            );
            assert(
              current.live &&
                current.owner === actor &&
                BigInt(current.generation as string) === owner.generation,
            );
            await tx.execute(
              sql`update receiving_coordinator set expires_at=clock_timestamp()+interval '60 seconds' where singleton`,
            );
          },
        },
        timing: {
          pollMs: 5000,
          operationMs: 4000,
          retryMs: 200,
          maxRetryMs: 800,
        },
        createClient: (options) => {
          overlap ||= records.some((r) => r.user === user && !r.retired);
          const client = new ImapFlow({
            ...options,
            tls: { ...options.tls, ca, servername: "localhost" },
            ...(disabled && user === users[0]
              ? { auth: { user, pass: "disabled-fixture-password" } }
              : {}),
            receivingResponse: (response, request) => {
              if (request?.sent && response.tag === request.tag)
                (run.completedEvidence as unknown[]).push({
                  user,
                  command: request.command,
                  status: response.command,
                  at: performance.now(),
                });
              return options.receivingResponse?.(response, request);
            },
          });
          const record = { user, client, retired: false };
          records.push(record);
          const retire = client.retireReceiving.bind(client);
          client.retireReceiving = async () => {
            await retire();
            record.retired = true;
            (run.retirements as unknown[]).push({
              user,
              at: performance.now(),
            });
          };
          maxSockets = Math.max(
            maxSockets,
            records.filter((r) => !r.retired).length,
          );
          run.resources = resourceSnapshot();
          return client;
        },
        onError: (error, retry) => {
          errors.push({
            user,
            retry,
            at: performance.now(),
            error: String(error),
          });
        },
        onTurn: (kind, turn) => {
          turns.push({
            user,
            kind,
            f: String(turn.state.freshThrough),
            e: String(turn.state.historyBefore),
            revision: String(turn.state.revision),
            at: performance.now(),
          });
          // Global gate closes before another selection. Each account can have
          // at most one history turn in this wave; authority remains in SQL.
          if (wave && kind === "history") {
            history = false;
            waveSettled = true;
          }
        },
      });
    }
    run.accounts = identities;
    const capture = async (): Promise<Snapshot> =>
      db.begin("isolation level repeatable read read only", async (tx) => {
        const rows =
          await tx`select * from receiving_mailboxes where mailbox_id in ${tx(identities.map((a) => a.mailbox))} order by mailbox_id`;
        const audit =
          await tx`select * from stage3c_audit where mailbox in ${tx(identities.map((a) => a.mailbox))} order by mailbox,revision`;
        const placements =
          await tx`select p.mailbox_id,p.uid,p.uid_validity,m.account_id,m.rfc_message_id from mailbox_messages p join messages m on m.id=p.message_id where p.mailbox_id in ${tx(identities.map((a) => a.mailbox))} order by p.mailbox_id,p.uid`;
        return {
          at: new Date().toISOString(),
          states: rows.map((r) => ({
            mailbox: r.mailbox_id,
            epoch: String(r.epoch),
            f: Number(r.fresh_through),
            e: Number(r.history_before),
            revision: Number(r.revision),
            history: audit.filter(
              (p) =>
                p.mailbox === r.mailbox_id && Number(p.new_e) < Number(p.old_e),
            ).length,
            placements: placements
              .filter((p) => p.mailbox_id === r.mailbox_id)
              .map((p) => ({
                uid: Number(p.uid),
                epoch: String(p.uid_validity),
                account: p.account_id,
                id: p.rfc_message_id,
              })),
          })),
          audit: audit.map((p) => ({
            mailbox: p.mailbox,
            epoch: String(p.epoch),
            revision: Number(p.revision),
            oldF: Number(p.old_f),
            f: Number(p.new_f),
            oldE: Number(p.old_e),
            e: Number(p.new_e),
            metadata: p.metadata as Placement[],
          })),
        };
      });
    const boundary = async (name: string) => {
      const snapshot = await capture();
      const result = {
        name,
        snapshot,
        resources: resourceSnapshot(),
        oracle: "PENDING",
      };
      (run.boundaries as unknown[]).push(result);
      save();
      verifySnapshot(snapshot, identities, inventories);
      assert(!overlap);
      assert(maxSockets <= workers);
      assert(admissions.every((a) => a.active <= workers));
      result.oracle = "PASS";
      save();
      return snapshot;
    };
    captureFailure = async () => {
      await boundary("failure-finally");
    };
    const stop = async () => {
      const at = performance.now();
      await scheduler?.stop();
      run.resources = resourceSnapshot();
      assert.equal(scheduler?.snapshot.active, 0);
      assert(records.every((r) => r.retired));
      (run.retirements as unknown[]).push({
        schedulerStopMs: performance.now() - at,
        active: 0,
        liveOwned: 0,
      });
      save();
    };
    const start = (selected = accounts) => {
      scheduler = new ReceivingScheduler({
        accounts: selected,
        executor: executor!,
        tuning: { workers },
        historyAllowed: () => history,
        onAdmission: (a) => admissions.push(a),
      });
      scheduler.start();
    };
    const phaseEnd = () =>
      Math.min(performance.now() + 25_000, deadline - 20_000);
    const runHistory = async (target: number) => {
      const end = phaseEnd();
      while (true) {
        const current = await capture();
        verifySnapshot(current, identities, inventories);
        const candidates = historyCandidates(current, identities, target);
        const selected = accounts.filter((a) =>
          candidates.some((c) => c.mailbox === a.mailbox),
        );
        if (!selected.length) {
          assert(current.states.every((s) => s.history === target));
          return;
        }
        if (performance.now() >= end)
          throw new Error(
            `PARTIAL: durable history target ${target} exceeded fixed 25-second phase deadline`,
          );
        history = true;
        wave = true;
        waveSettled = false;
        start(selected);
        await until(
          async () => waveSettled,
          `history wave target ${target}`,
          Math.max(1, Math.floor(end - performance.now())),
        );
        // Gate has closed: allow every already-admitted turn to settle, never
        // cancel acknowledged work just to make the count fit.
        await until(
          async () => scheduler!.snapshot.active === 0,
          "history wave settlement",
          Math.max(1, Math.floor(end - performance.now())),
        );
        await stop();
        wave = false;
        await boundary(`history-${target}-wave`);
      }
    };
    start();
    await until(
      async () => {
        const s = await capture();
        return (
          s.states.length === 5 &&
          turns.filter((t) => t.kind === "fresh").length >= 5 &&
          scheduler!.snapshot.active === 0
        );
      },
      "initial five fresh completions",
      20_000,
    );
    await stop();
    assert.equal(new Set(admissions.slice(0, 5).map((a) => a.account)).size, 5);
    assert(admissions.slice(0, 5).every((a) => a.kind === "fresh"));
    await boundary("initial-fresh");
    await runHistory(1);
    const recent = await boundary("recent-metadata");
    assert.equal(recent.states.length, 5);
    assert(recent.states.every((s) => s.e > 1 && s.placements.length > 0));
    await runHistory(2);
    const initialHistory = await boundary("initial-history-two");
    assert(initialHistory.states.every((s) => s.history === 2 && s.e > 1));
    assert.equal(
      errors.length,
      0,
      "No unexpected errors during initial receiving",
    );
    history = false;
    start();
    async function inject(targets = users, count = 3) {
      for (const user of targets) {
        const client = await open(user);
        for (let n = 1; n <= count; n++) {
          const fixture = message(
            n,
            `w${workers}-${injections.length}-${user}`,
          );
          const result = await client.append(
            "INBOX",
            fixture.data,
            [],
            new Date(fixture.date),
          );
          const ackMs = performance.now(),
            ack = new Date().toISOString();
          assert(result && result.uid && result.uidValidity);
          assert.equal(
            String(result.uidValidity),
            inventories.get(user)!.epoch,
          );
          inventories
            .get(user)!
            .items.push({ uid: result.uid, id: fixture.messageId });
          injections.push({
            user,
            uid: result.uid,
            id: fixture.messageId,
            ack,
            ackMs,
          });
          save();
        }
        await client.logout();
      }
    }
    async function visible() {
      for (const sample of injections.filter((s) => !s.visible)) {
        const a = identities.find((a) => a.user === sample.user)!;
        const rows =
          await db`select p.uid from mailbox_messages p join messages m on m.id=p.message_id where p.mailbox_id=${a.mailbox} and p.uid_validity=${inventories.get(sample.user)!.epoch} and p.uid=${sample.uid} and m.account_id=${a.account} and m.rfc_message_id=${sample.id}`;
        if (rows.length) {
          assert.equal(rows.length, 1);
          sample.visible = new Date().toISOString();
          sample.latencyMs = performance.now() - sample.ackMs;
          save();
        }
      }
      return injections.every((s) => s.visible);
    }
    // Observer runs during APPENDs, not only after the entire delivery batch.
    let polling = true;
    const observer = (async () => {
      while (polling) {
        await visible();
        await new Promise((r) => setTimeout(r, 25));
      }
    })();
    try {
      await inject();
      await until(visible, "fresh PostgreSQL visibility", 20_000);
    } finally {
      polling = false;
      await observer;
    }
    await stop();
    const fresh = await boundary("fresh-injections-visible");
    assert(
      fresh.states.every(
        (s) =>
          s.e > 1 &&
          s.e === initialHistory.states.find((p) => p.mailbox === s.mailbox)!.e,
      ),
    );
    await runHistory(3);
    const saved = await boundary("history-after-fresh-three");
    assert(saved.states.every((s) => s.history === 3 && s.e > 1));
    const beforeRestart = admissions.length,
      turnIndex = turns.length;
    history = false;
    start();
    await until(
      async () =>
        turns.length >= turnIndex + 5 && scheduler!.snapshot.active === 0,
      "restart current discovery",
      20_000,
    );
    await stop();
    assert(
      admissions
        .slice(beforeRestart, beforeRestart + 5)
        .every((a) => a.kind === "fresh"),
    );
    const restarted = await boundary("restart");
    assert.deepEqual(restarted.states, saved.states);
    run.restart = "PASS";
    disabled = true;
    const errorIndex = errors.length;
    start();
    await until(
      async () => errors.length >= errorIndex + 3,
      "account bounded backoff",
      20_000,
    );
    assert(errors.slice(errorIndex).every((e) => e.user === users[0]));
    assert.deepEqual(
      errors.slice(errorIndex, errorIndex + 3).map((e) => e.retry),
      [200, 400, 800],
    );
    const failed = await boundary("account-unavailable");
    await inject(users.slice(1), 1);
    await until(visible, "healthy progress during account failure", 20_000);
    const healthy = await boundary("healthy-progress");
    assert.deepEqual(
      healthy.states.find((s) => s.mailbox === identities[0].mailbox),
      failed.states.find((s) => s.mailbox === identities[0].mailbox),
    );
    for (const a of identities.slice(1))
      assert(
        healthy.states.find((s) => s.mailbox === a.mailbox)!.f >
          failed.states.find((s) => s.mailbox === a.mailbox)!.f,
      );
    disabled = false;
    await inject([users[0]], 1);
    await until(visible, "restored account recovery", 20_000);
    await stop();
    const recovered = await boundary("recovery-final");
    assert(
      recovered.states.find((s) => s.mailbox === identities[0].mailbox)!.f >
        failed.states.find((s) => s.mailbox === identities[0].mailbox)!.f,
    );
    run.failureIsolation = "PASS";
    run.maxLatencyMs = Math.max(...injections.map((s) => s.latencyMs!));
    run.final = recovered;
    await executor.stop();
    executor = undefined;
    outcomes[`W${workers}`] = "PASS";
    captureFailure = undefined;
    save();
    console.log(
      `W=${workers} PASS; final E ${recovered.states.map((s) => s.e)}; maximum observed visibility latency ${run.maxLatencyMs}ms`,
    );
  }
  evidence.result = "PASS";
}
try {
  await Promise.race([smoke(), expired]);
} catch (error) {
  evidence.result = "PARTIAL";
  evidence.error =
    error instanceof Error
      ? { message: error.message, stack: error.stack }
      : String(error);
  console.error(error);
  process.exitCode = 1;
} finally {
  // Persist before every potentially failing cleanup. Even cleanup exceptions
  // cannot skip the final evidence write. Launcher owns forced-exit cleanup.
  save();
  for (const key of ["fixture", "W2", "W4"]) outcomes[key] ??= "NOT RUN";
  const cleanupErrors: string[] = [];
  const cleanup = async (name: string, work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (error) {
      cleanupErrors.push(`${name}: ${String(error)}`);
    } finally {
      evidence.cleanupErrors = cleanupErrors;
      save();
    }
  };
  await cleanup("scheduler-stop", async () => {
    await scheduler?.stop();
  });
  await cleanup("final-independent-evidence", async () => {
    await captureFailure?.();
  });
  for (const client of clients) client.close();
  await cleanup("executor-stop", async () => {
    await executor?.stop();
  });
  await cleanup("reader-close", async () => {
    await reader?.end({ timeout: 0 });
  });
  await cleanup("database-close", async () => {
    await database?.client.end({ timeout: 0 });
  });
  for (const container of containers.reverse())
    await cleanup("container-stop", () => container.stop());
  evidence.elapsedMs = performance.now() - started;
  evidence.cleanup = cleanupErrors.length ? "PARTIAL" : "PASS";
  if (cleanupErrors.length) {
    evidence.result = "PARTIAL";
    process.exitCode = 1;
  }
  save();
  clearTimeout(expire);
  clearTimeout(hardStop);
}
