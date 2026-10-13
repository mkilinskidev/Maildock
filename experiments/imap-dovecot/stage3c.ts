/** Standalone real-server smoke; never imported by worker composition. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
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
const watchdog = setTimeout(() => {
  console.error("BLOCKED: five-minute watchdog expired");
  process.exit(2);
}, 300_000);
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
try {
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
  await db.unsafe(`CREATE TABLE stage3c_audit (mailbox uuid, epoch bigint, revision bigint, old_f bigint, new_f bigint, old_e bigint, new_e bigint, uids bigint[]);
    CREATE FUNCTION stage3c_audit_progress() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    INSERT INTO stage3c_audit SELECT NEW.mailbox_id, NEW.epoch, NEW.revision, OLD.fresh_through, NEW.fresh_through, OLD.history_before, NEW.history_before,
    ARRAY(SELECT uid FROM mailbox_messages WHERE mailbox_id=NEW.mailbox_id AND uid_validity=NEW.epoch AND ((uid>OLD.fresh_through AND uid<=NEW.fresh_through) OR (uid>=NEW.history_before AND uid<OLD.history_before)) ORDER BY uid);
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
    inventories: Object.fromEntries(inventories),
  };
  outcomes.fixture = "PASS";
  console.log(`Fixture ready in ${Math.round(performance.now() - started)}ms`);
  for (const workers of [2, 4]) {
    const run: Record<string, unknown> = {
      workers,
      admissions: [],
      errors: [],
      injections: [],
      phases: {},
    };
    (evidence.runs as unknown[]).push(run);
    outcomes[`W${workers}`] = "FAIL: run started but not completed";
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
    const injections = run.injections as {
      user: string;
      uid: number;
      id: string;
      ack: string;
      visible?: string;
      latencyMs?: number;
    }[];
    const actor = randomUUID();
    await db`update receiving_coordinator set expires_at='-infinity'`;
    const [lease] =
      await db`select maildock_receiving_takeover(${actor},60000) as generation`;
    const owner = { actor, generation: BigInt(lease.generation) };
    executor = new ReceivingExecutor(url, 2);
    let history = true;
    // Test-only observation gate prevents quiet accounts draining their archive
    // while the independent oracle waits for a slower account. Not authority.
    const observedHistory = new Map<string, number>();
    let maxSockets = 0;
    let overlap = false;
    let disabled = false;
    const sockets = new Map<string, ImapFlow[]>();
    const accounts: Omit<ReceivingCoordinatorConfig, "executor">[] = [];
    for (const user of users) {
      const id = randomUUID(),
        mailbox = randomUUID();
      await database.db.insert(mailAccounts).values({
        id,
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
        accountId: id,
        remotePath: "INBOX",
        name: "INBOX",
        selectable: true,
        firstDiscoveredAt: new Date(),
        lastDiscoveredAt: new Date(),
      });
      sockets.set(user, []);
      accounts.push({
        account: id,
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
          pollMs: 250,
          operationMs: 4000,
          retryMs: 200,
          maxRetryMs: 800,
        },
        createClient: (options) => {
          overlap ||= sockets.get(user)!.some((c) => !c.isClosed);
          const client = new ImapFlow({
            ...options,
            tls: { ...options.tls, ca, servername: "localhost" },
            ...(disabled && user === users[0]
              ? { auth: { user, pass: "disabled-fixture-password" } }
              : {}),
          });
          sockets.get(user)!.push(client);
          maxSockets = Math.max(
            maxSockets,
            [...sockets.values()].flat().filter((c) => !c.isClosed).length,
          );
          return client;
        },
        onError: (error, retry) =>
          errors.push({
            user,
            retry,
            at: performance.now(),
            error: String(error),
          }),
        onTurn: (kind) => {
          if (kind !== "history") return;
          const count = (observedHistory.get(user) ?? 0) + 1;
          observedHistory.set(user, count);
          if (count >= 3) history = false;
        },
      });
    }
    const states = async () =>
      db`select mailbox_id,epoch,fresh_through,history_before,revision from receiving_mailboxes where mailbox_id in ${db(accounts.map((a) => a.mailbox))} order by mailbox_id`;
    const historyCounts = async () =>
      db`select mailbox,count(*)::int as n from stage3c_audit where mailbox in ${db(accounts.map((a) => a.mailbox))} and new_e<old_e group by mailbox`;
    run.accounts = accounts.map((a) => ({
      user: a.connection.username,
      account: a.account,
      mailbox: a.mailbox,
    }));
    captureFailure = async () => {
      await scheduler?.stop();
      run.failureStates = await states();
      run.failureAudit =
        await db`select * from stage3c_audit where mailbox in ${db(accounts.map((a) => a.mailbox))} order by mailbox,revision`;
      run.resources = {
        maxSockets,
        overlap,
        retired: [...sockets.values()].flat().every((c) => c.isClosed),
        activeSlots: scheduler?.snapshot.active,
      };
      outcomes[`W${workers}`] = String(evidence.result);
    };
    const startScheduler = () => {
      scheduler = new ReceivingScheduler({
        accounts,
        executor: executor!,
        historyAllowed: () => history,
        tuning: { workers },
        onAdmission: (a) => admissions.push(a),
      });
      scheduler.start();
    };
    const stopScheduler = async () => {
      const at = performance.now();
      await scheduler!.stop();
      assert.equal(scheduler!.snapshot.active, 0);
      assert([...sockets.values()].flat().every((c) => c.isClosed));
      return performance.now() - at;
    };
    startScheduler();
    await until(async () => {
      const s = await states();
      return (
        s.length === 5 &&
        s.every(
          (r) => Number(r.history_before) > 1 && Number(r.fresh_through) > 0,
        )
      );
    }, "initial durable fresh");
    run.initial = await states();
    assert.equal(new Set(admissions.slice(0, 5).map((a) => a.account)).size, 5);
    assert(admissions.slice(0, 5).every((a) => a.kind === "fresh"));
    await until(async () => {
      const rows =
        await db`select p.mailbox_id,count(*)::int as n from mailbox_messages p where p.mailbox_id in ${db(accounts.map((a) => a.mailbox))} group by p.mailbox_id`;
      const s = await states();
      return (
        rows.length === 5 &&
        rows.every((r) => r.n > 0) &&
        s.every((r) => Number(r.history_before) > 1)
      );
    }, "recent metadata durable before history completion");
    await until(async () => {
      const counts = await historyCounts();
      return counts.length === 5 && counts.every((r) => r.n >= 2);
    }, "two historical windows per account");
    history = false;
    run.beforeInjection = await states();
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
          const ack = new Date().toISOString();
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
          });
        }
        await client.logout();
      }
    }
    async function visible() {
      for (const sample of injections.filter((s) => !s.visible)) {
        const a = accounts[users.indexOf(sample.user)];
        const rows =
          await db`select p.uid from mailbox_messages p join messages m on m.id=p.message_id where p.mailbox_id=${a.mailbox} and p.uid=${sample.uid} and m.account_id=${a.account} and m.rfc_message_id=${sample.id}`;
        if (rows.length) {
          sample.visible = new Date().toISOString();
          sample.latencyMs =
            Date.parse(sample.visible) - Date.parse(sample.ack);
        }
      }
      return injections.every((s) => s.visible);
    }
    await inject();
    await until(visible, "fresh injection visibility");
    run.afterInjection = await states();
    history = true;
    await until(async () => {
      const counts = await historyCounts();
      return counts.length === 5 && counts.every((r) => r.n >= 3);
    }, "history after fresh");
    history = false;
    run.stopMs = await stopScheduler();
    const beforeRestart = await states();
    run.beforeRestart = beforeRestart;
    const restartIndex = admissions.length;
    startScheduler();
    await until(
      async () =>
        admissions.length >= restartIndex + 5 &&
        scheduler!.snapshot.active === 0,
      "restart discovery",
    );
    assert(
      admissions
        .slice(restartIndex, restartIndex + 5)
        .every((a) => a.kind === "fresh"),
    );
    assert.deepEqual(await states(), beforeRestart);
    run.restart = "PASS: fresh first; persisted F/E/epoch/revision unchanged";
    disabled = true;
    const errorIndex = errors.length;
    await until(
      async () => errors.length >= errorIndex + 3,
      "account retry/backoff",
      15_000,
    );
    assert(errors.slice(errorIndex).every((e) => e.user === users[0]));
    assert.deepEqual(
      errors.slice(errorIndex, errorIndex + 3).map((e) => e.retry),
      [200, 400, 800],
    );
    const failedBefore = (await states()).find(
      (r) => r.mailbox_id === accounts[0].mailbox,
    );
    await inject(users.slice(1), 1);
    await until(visible, "healthy progress during failure");
    assert.deepEqual(
      (await states()).find((r) => r.mailbox_id === accounts[0].mailbox),
      failedBefore,
    );
    disabled = false;
    await inject([users[0]], 1);
    await until(visible, "restored account recovery");
    run.failureIsolation = "PASS";
    run.finalStopMs = await stopScheduler();
    run.final = await states();
    const audit =
      await db`select * from stage3c_audit where mailbox in ${db(accounts.map((a) => a.mailbox))} order by mailbox,revision`;
    for (const a of accounts) {
      const inventory = inventories.get(a.connection.username)!;
      const rows = audit.filter((r) => r.mailbox === a.mailbox);
      let previous: (typeof rows)[number] | undefined;
      for (const r of rows) {
        assert.equal(String(r.epoch), inventory.epoch);
        if (previous) {
          assert.equal(r.old_f, previous.new_f);
          assert.equal(r.old_e, previous.new_e);
          assert.equal(BigInt(r.revision), BigInt(previous.revision) + 1n);
        }
        assert(
          Number(r.new_f) >= Number(r.old_f) &&
            Number(r.new_e) <= Number(r.old_e),
        );
        assert(Number(r.old_e) - Number(r.new_e) <= 128);
        if (r.new_f !== r.old_f) assert.equal(r.new_e, r.old_e);
        const expected = inventory.items
          .filter(
            (v) =>
              (v.uid > Number(r.old_f) && v.uid <= Number(r.new_f)) ||
              (v.uid >= Number(r.new_e) && v.uid < Number(r.old_e)),
          )
          .map((v) => v.uid)
          .sort((a, b) => a - b);
        assert.deepEqual(r.uids.map(Number), expected);
        previous = r;
      }
      const placements =
        await db`select p.uid,p.uid_validity,m.account_id,m.rfc_message_id from mailbox_messages p join messages m on m.id=p.message_id where p.mailbox_id=${a.mailbox}`;
      const state = (await states()).find((r) => r.mailbox_id === a.mailbox)!;
      const expected = inventory.items.filter(
        (v) =>
          v.uid >= Number(state.history_before) &&
          v.uid <= Number(state.fresh_through),
      );
      assert.equal(placements.length, expected.length);
      assert.equal(
        new Set(placements.map((r) => r.uid)).size,
        placements.length,
      );
      for (const p of placements) {
        assert.equal(p.account_id, a.account);
        assert.equal(String(p.uid_validity), inventory.epoch);
        assert.equal(
          p.rfc_message_id,
          expected.find((v) => v.uid === Number(p.uid))!.id,
        );
      }
    }
    assert(!overlap);
    assert(maxSockets <= workers);
    assert(admissions.every((a) => a.active <= workers));
    run.resources = {
      maxSockets,
      overlap,
      retired: true,
      activeSlots: scheduler!.snapshot.active,
      rssBytes: process.memoryUsage().rss,
    };
    run.audit = audit;
    run.maxLatencyMs = Math.max(...injections.map((s) => s.latencyMs!));
    await executor.stop();
    executor = undefined;
    outcomes[`W${workers}`] = "PASS";
    captureFailure = undefined;
    console.log(
      `W=${workers} PASS; maximum observed visibility latency ${run.maxLatencyMs}ms`,
    );
  }
  evidence.result = "PASS";
} catch (error) {
  evidence.result = String(error).includes("PARTIAL") ? "PARTIAL" : "FAIL";
  evidence.error =
    error instanceof Error
      ? { message: error.message, stack: error.stack }
      : String(error);
  console.error(error);
  try {
    await captureFailure?.();
  } catch (captureError) {
    evidence.captureError = String(captureError);
  }
  process.exitCode = 1;
} finally {
  for (const key of ["fixture", "W2", "W4"]) outcomes[key] ??= "NOT RUN";
  await scheduler?.stop();
  for (const client of clients) client.close();
  await executor?.stop();
  await reader?.end({ timeout: 0 });
  await database?.client.end({ timeout: 0 });
  for (const container of containers.reverse()) await container.stop();
  evidence.elapsedMs = performance.now() - started;
  evidence.cleanup = "PASS: owned containers stopped";
  clearTimeout(watchdog);
  await writeFile(
    new URL("stage3c-evidence.json", import.meta.url),
    JSON.stringify(
      evidence,
      (_, v) => (typeof v === "bigint" ? String(v) : v),
      2,
    ) + "\n",
  );
}
