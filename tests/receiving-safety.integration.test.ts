import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { createServer, connect, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import postgres from "postgres";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "@/shared/infrastructure/database/database";
import {
  ReceivingExecutor,
  ReceivingUnresolvedError,
  type ReceivingDatabase,
} from "@/shared/infrastructure/database/receiving-executor";
import { recoverReceiving } from "@/shared/infrastructure/database/receiving-authority";
import { ReceivingPersistence } from "@/modules/mail/application/receiving-persistence";
import { persistMessageMetadata } from "@/modules/mail/application/message-metadata-persistence";
import type { RemoteMessageMetadata } from "@/modules/accounts/domain/mail-provider";
import {
  mailAccounts,
  mailboxes,
  mailboxMessages,
} from "@/shared/infrastructure/database/schema";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}
const budget = (ms = 5000) => ({ deadline: performance.now() + ms });
function metadata(uid: number): RemoteMessageMetadata {
  return {
    uid: String(uid),
    modseq: "2",
    internalDate: "2026-01-01T00:00:00Z",
    size: "10",
    flags: [],
    hasAttachments: false,
    envelope: {
      messageId: `<fixture-${uid}@example.test>`,
      subject: `Fixture ${uid}`,
      from: [],
      sender: [],
      replyTo: [],
      to: [],
      cc: [],
      bcc: [],
    },
  };
}
const batch32 = () => Array.from({ length: 32 }, (_, i) => metadata(i + 1));
const initial = () => ({
  epoch: 1n,
  revision: 0n,
  freshThrough: 32n,
  historyBefore: 33n,
  reconcileAfter: 0n,
});
async function until(predicate: () => Promise<boolean>, message: string) {
  const end = performance.now() + 5000;
  while (performance.now() < end) {
    if (await predicate()) return;
    await delay(10);
  }
  throw new Error(message);
}

// Raw duplex relay: no PostgreSQL frame inspection, backend keys or private APIs.
export async function responseRelay(url: string) {
  const target = new URL(url);
  const upstreamPort = Number(target.port),
    upstreamHost = target.hostname;
  const sockets = new Set<Socket>();
  const control = { drop: false };
  const server = createServer((client) => {
    const upstream = connect(upstreamPort, upstreamHost);
    sockets.add(client);
    sockets.add(upstream);
    client.on("data", (bytes) => upstream.write(bytes));
    upstream.on("data", (bytes) => {
      if (!control.drop) client.write(bytes);
    });
    client.on("end", () => upstream.end());
    upstream.on("end", () => client.end());
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => {
      sockets.delete(client);
      upstream.destroy();
    });
    upstream.on("close", () => {
      sockets.delete(upstream);
      client.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing relay port");
  target.hostname = "127.0.0.1";
  target.port = String(address.port);
  return {
    control,
    url: target.toString(),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("production receiving retirement and PostgreSQL authority gate", () => {
  let container: StartedTestContainer;
  let tlsDirectory: string;
  let url: string;
  let database: ReturnType<typeof createDatabase>;
  let reader: postgres.Sql;
  let mailbox: string;
  let actor: string;
  let term: bigint;
  let accountId: string;
  beforeAll(async () => {
    tlsDirectory = await mkdtemp(join(tmpdir(), "maildock-receiving-tls-"));
    execFileSync(
      process.platform === "win32"
        ? "C:\\Program Files\\Git\\usr\\bin\\openssl.exe"
        : "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(tlsDirectory, "key.pem"),
        "-out",
        join(tlsDirectory, "cert.pem"),
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
        "-days",
        "1",
      ],
      { stdio: "ignore" },
    );
    container = await new GenericContainer("postgres:17.6-alpine")
      .withEnvironment({
        POSTGRES_USER: "fixture",
        POSTGRES_PASSWORD: "fixture-only",
        POSTGRES_DB: "fixture",
      })
      .withCopyFilesToContainer([
        {
          source: join(tlsDirectory, "key.pem"),
          target: "/tmp/receiving-key.pem",
        },
        {
          source: join(tlsDirectory, "cert.pem"),
          target: "/tmp/receiving-cert.pem",
        },
      ])
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/, 2),
      )
      .start();
    const sslSetup = await container.exec([
      "sh",
      "-c",
      `chown postgres:postgres /tmp/receiving-key.pem && chmod 600 /tmp/receiving-key.pem && printf "\\nssl=on\\nssl_cert_file='/tmp/receiving-cert.pem'\\nssl_key_file='/tmp/receiving-key.pem'\\n" >> "$PGDATA/postgresql.conf" && kill -HUP "$(head -n1 "$PGDATA/postmaster.pid")"`,
    ]);
    if (sslSetup.exitCode)
      throw new Error("Disposable PostgreSQL TLS setup failed");
    const rootUrl = `postgres://fixture:fixture-only@${container.getHost()}:${container.getMappedPort(5432)}/fixture`;
    const root = postgres(rootUrl);
    await root`create role lane login password 'lane-fixture-only'`;
    await root`create database receiving_safety owner lane`;
    await root.end();
    url = `postgres://lane:lane-fixture-only@${container.getHost()}:${container.getMappedPort(5432)}/receiving_safety`;
    database = createDatabase({ databaseUrl: url, databasePoolSize: 2 });
    reader = postgres(url, { max: 2 });
    await migrate(database.db, { migrationsFolder: "db/migrations" });
    await reader.unsafe(`
      CREATE FUNCTION fixture_arm_hold() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN
        PERFORM set_config('fixture.hold','true',true); RETURN pg_backend_pid(); END $$;
      CREATE FUNCTION fixture_hold_after_l() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF current_setting('fixture.hold',true)='true' THEN PERFORM pg_advisory_xact_lock(917355); END IF;
        RETURN NULL; END $$;
      CREATE CONSTRAINT TRIGGER zzz_fixture_after_l AFTER UPDATE ON receiving_mailboxes
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fixture_hold_after_l();
      CREATE FUNCTION fixture_fail_frontier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.history_before=13 THEN RAISE EXCEPTION 'Injected frontier failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER zzz_fixture_fail_frontier BEFORE UPDATE ON receiving_mailboxes FOR EACH ROW EXECUTE FUNCTION fixture_fail_frontier();
      CREATE FUNCTION fixture_fail_side_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.subject IN ('fail-conversation','fail-notification') THEN RAISE EXCEPTION 'Injected side effect failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER zzz_fixture_fail_conversation AFTER INSERT ON messages FOR EACH ROW
        WHEN (NEW.subject='fail-conversation') EXECUTE FUNCTION fixture_fail_side_effect();
      CREATE TRIGGER zzz_fixture_fail_notification AFTER INSERT ON notification_events FOR EACH ROW
        WHEN (NEW.subject='fail-notification') EXECUTE FUNCTION fixture_fail_side_effect();
    `);
  });
  beforeEach(async () => {
    await reader`update receiving_coordinator set expires_at='-infinity'`;
    actor = randomUUID();
    [{ term }] = await reader<
      { term: bigint }[]
    >`select maildock_receiving_takeover(${actor},60000) as term`;
    term = BigInt(term);
    const account = randomUUID();
    accountId = account;
    mailbox = randomUUID();
    await database.db.insert(mailAccounts).values({
      id: account,
      displayName: "fixture",
      email: "fixture@example.test",
      imapHost: "invalid.test",
      imapPort: 993,
      imapSecurity: "tls",
      imapUsername: "fixture",
      imapPassword: {
        version: 1,
        algorithm: "AES-256-GCM",
        keyId: "fixture",
        iv: "fixture",
        ciphertext: "fixture",
        authTag: "fixture",
      },
      smtpHost: "invalid.test",
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
    const exec = new ReceivingExecutor(url, 1);
    await exec.transaction(
      (db) =>
        db
          .execute(
            sql`select maildock_receiving_initialize(${actor}::uuid,${term}::bigint,${mailbox}::uuid,1,33)`,
          )
          .then(() => undefined),
      budget(),
    );
    await exec.stop();
  });
  afterAll(async () => {
    await reader?.end({ timeout: 0 });
    await database?.client.end({ timeout: 0 });
    await container?.stop();
    if (tlsDirectory) {
      const target = resolve(tlsDirectory);
      if (
        !target.startsWith(resolve(tmpdir()) + sep) ||
        !basename(target).startsWith("maildock-receiving-tls-")
      )
        throw new Error("Unsafe TLS fixture cleanup path");
      await rm(target, { recursive: true, force: true });
    }
  });

  const claim = (db: ReceivingDatabase, revision = 0, f = 32, e = 33, r = 0) =>
    db.execute(
      sql`select maildock_receiving_claim(${actor}::uuid,${term}::bigint,${mailbox}::uuid,1,${revision},${f},${e},${r})`,
    );
  const advance = (db: ReceivingDatabase) =>
    db.execute(
      sql`update receiving_mailboxes set history_before=1,revision=revision+1 where mailbox_id=${mailbox}::uuid`,
    );
  const recover = (db: ReceivingDatabase) =>
    db.execute(
      sql`select * from maildock_receiving_recover(${actor}::uuid,${term}::bigint,${mailbox}::uuid)`,
    );
  const state = async () =>
    (
      await reader`select * from receiving_mailboxes where mailbox_id=${mailbox}`
    )[0];

  it.each([1, 2])(
    "old callback and prepared DELETE cannot touch a replacement (capacity %i)",
    async (capacity) => {
      const exec = new ReceivingExecutor(url, capacity),
        ready = barrier(),
        resume = barrier(),
        finished = barrier(),
        replacementReady = barrier(),
        finishReplacement = barrier();
      const abort = new AbortController();
      let lazyRejected = false;
      const old = exec
        .transaction(
          async (db) => {
            await claim(db);
            await persistMessageMetadata(
              db,
              accountId,
              mailbox,
              1n,
              batch32(),
              false,
              false,
            );
            await advance(db);
            const lazy = db
              .delete(mailboxMessages)
              .where(eq(mailboxMessages.mailboxId, mailbox))
              .prepare("obsolete_delete");
            ready.release();
            await resume.promise;
            try {
              await lazy.execute();
            } catch {
              lazyRejected = true;
            }
            finished.release();
          },
          { ...budget(), signal: abort.signal },
        )
        .catch((error) => error);
      await ready.promise;
      abort.abort();
      expect(await old).toBeInstanceOf(ReceivingUnresolvedError);
      const replacement = exec.transaction(async (db) => {
        const rows = await recover(db);
        expect(rows[0].revision).toBe("0");
        // Recovery scope and writer claim must be separate transactions.
      }, budget());
      await replacement;
      const write = exec.transaction(async (db) => {
        await claim(db);
        await persistMessageMetadata(
          db,
          accountId,
          mailbox,
          1n,
          batch32(),
          false,
          false,
        );
        await advance(db);
        replacementReady.release();
        await finishReplacement.promise;
      }, budget());
      await replacementReady.promise;
      resume.release();
      await finished.promise;
      finishReplacement.release();
      await write;
      expect(lazyRejected).toBe(true);
      expect((await state()).revision).toBe("1");
      expect(
        (
          await reader`select uid from receiving_current_placements where mailbox_id=${mailbox} order by uid`
        ).map((row) => BigInt(row.uid)),
      ).toEqual(Array.from({ length: 32 }, (_, i) => BigInt(i + 1)));
      await exec.stop();
    },
  );

  it("new takeover before old claim fences obsolete generation", async () => {
    const staleTerm = term;
    const staleActor = actor;
    await reader`update receiving_coordinator set expires_at='-infinity'`;
    actor = randomUUID();
    [{ term }] = await reader<
      { term: bigint }[]
    >`select maildock_receiving_takeover(${actor},60000) term`;
    term = BigInt(term);
    const exec = new ReceivingExecutor(url, 1);
    await expect(
      exec.transaction(
        (db) =>
          db.execute(
            sql`select maildock_receiving_claim(${staleActor}::uuid,${staleTerm}::bigint,${mailbox}::uuid,1,0,32,33,0)`,
          ),
        budget(),
      ),
    ).rejects.toThrow();
    expect((await state()).revision).toBe("0");
    await new ReceivingPersistence(exec).persist(
      { actor, generation: term },
      mailbox,
      initial(),
      history(),
      budget(),
    );
    expect((await state()).revision).toBe("1");
    await exec.stop();
  });

  it("surviving old COMMIT after L orders before takeover; blocked recovery remains unresolved", async () => {
    // A test-only deferred trigger after the production authority trigger models
    // backend suspension after L without changing the production expiry check.
    const holder = await reader.reserve();
    await holder`select pg_advisory_lock(917355)`;
    const exec = new ReceivingExecutor(url, 2),
      abort = new AbortController();
    let oldPid: number | undefined;
    let old: Promise<unknown> | undefined;
    let takeover: Promise<postgres.Row> | undefined;
    try {
      await reader`update receiving_coordinator set expires_at=clock_timestamp()+interval '1500 milliseconds'`;
      old = exec
        .transaction(
          async (db) => {
            await claim(db);
            await advance(db);
            const rows = await db.execute(sql`select fixture_arm_hold() pid`);
            oldPid = Number(rows[0].pid);
          },
          { ...budget(), signal: abort.signal },
        )
        .catch((error) => error);
      await until(
        async () =>
          Boolean(
            oldPid &&
            (
              await reader`select 1 from pg_stat_activity where pid=${oldPid} and wait_event='advisory'`
            )[0],
          ),
        "old COMMIT did not reach post-L barrier",
      );
      abort.abort();
      expect(await old).toBeInstanceOf(ReceivingUnresolvedError);
      expect(
        (
          await reader`select state from pg_stat_activity where pid=${oldPid!}`
        )[0].state,
      ).toBe("active");
      await expect(
        recoverReceiving(exec, { actor, generation: term }, mailbox, {
          ...budget(),
          lockTimeoutMs: 100,
        }),
      ).rejects.toBeInstanceOf(ReceivingUnresolvedError);
      expect((await state()).revision).toBe("0"); // Unlocked old snapshot is not recovery.
      await until(
        async () =>
          Boolean(
            (
              await reader`select 1 from receiving_coordinator where expires_at<=clock_timestamp()`
            )[0],
          ),
        "lease did not cross expiry after L",
      );
      const newcomer = randomUUID();
      takeover =
        reader`select maildock_receiving_takeover(${newcomer},60000) term`.then(
          (rows) => rows[0],
        );
      await until(
        async () =>
          Boolean(
            (
              await holder`select 1 from pg_stat_activity where query like 'select maildock_receiving_takeover%' and wait_event_type='Lock'`
            )[0],
          ),
        "takeover must wait for old authorization",
      );
      await holder`select pg_advisory_unlock(917355)`;
      const next = await takeover;
      actor = newcomer;
      term = BigInt(next.term);
      const confirmed = await recoverReceiving(
        exec,
        { actor, generation: term },
        mailbox,
        budget(),
      );
      expect(confirmed.revision).toBe(1n);
      expect(confirmed.historyBefore).toBe(1n);
      await exec.transaction(async (db) => {
        await claim(db, 1, 32, 1, 0);
        await db.execute(
          sql`update receiving_mailboxes set reconcile_after=32,revision=revision+1 where mailbox_id=${mailbox}::uuid`,
        );
      }, budget());
      expect((await state()).revision).toBe("2");
    } finally {
      await holder`select pg_advisory_unlock(917355)`;
      holder.release();
      abort.abort();
      await old;
      await takeover?.catch(() => undefined);
      await exec.stop();
    }
  });

  it("lease expiry before logical COMMIT rejects while takeover waits", async () => {
    await reader`update receiving_coordinator set expires_at=clock_timestamp()+interval '300 milliseconds'`;
    const exec = new ReceivingExecutor(url, 2),
      ready = barrier(),
      resume = barrier();
    const old = exec
      .transaction(async (db) => {
        await claim(db);
        await advance(db);
        ready.release();
        await resume.promise;
      }, budget())
      .catch((error) => error);
    await ready.promise;
    const newcomer = randomUUID();
    const takeover =
      reader`select maildock_receiving_takeover(${newcomer},60000) term`.then(
        (rows) => rows[0],
      );
    await until(
      async () =>
        Boolean(
          (
            await reader`select 1 from pg_stat_activity where query like 'select maildock_receiving_takeover%' and wait_event_type='Lock'`
          )[0],
        ),
      "takeover did not wait for SHARE lease",
    );
    await until(
      async () =>
        Boolean(
          (
            await reader`select 1 from receiving_coordinator where expires_at<=clock_timestamp()`
          )[0],
        ),
      "lease did not expire",
    );
    resume.release();
    expect(await old).toBeInstanceOf(ReceivingUnresolvedError);
    expect(BigInt((await takeover).term)).toBeGreaterThan(term);
    expect((await state()).revision).toBe("0");
    await exec.stop();
  });

  it("lost actual COMMIT reply reloads committed revision under conflicting locks", async () => {
    const relay = await responseRelay(url),
      exec = new ReceivingExecutor(relay.url, 1),
      abort = new AbortController();
    try {
      const old = exec
        .transaction(
          async (db) => {
            await claim(db);
            await persistMessageMetadata(
              db,
              accountId,
              mailbox,
              1n,
              batch32(),
              false,
              false,
            );
            await advance(db);
            relay.control.drop = true;
          },
          { ...budget(), signal: abort.signal },
        )
        .catch((error) => error);
      try {
        await until(
          async () => (await state()).revision === "1",
          "server did not commit",
        );
      } catch (error) {
        abort.abort();
        const outcome = await old;
        throw new Error(
          `${String(error)}; old outcome: ${String(outcome)}; cause: ${String(outcome?.cause)}`,
        );
      }
      abort.abort();
      expect(await old).toBeInstanceOf(ReceivingUnresolvedError);
      const fresh = new ReceivingExecutor(url, 1);
      await reader`update receiving_coordinator set expires_at='-infinity'`;
      actor = randomUUID();
      [{ term }] = await reader<
        { term: bigint }[]
      >`select maildock_receiving_takeover(${actor},60000) term`;
      term = BigInt(term);
      const rows = await fresh.transaction(recover, budget());
      expect(rows[0].revision).toBe("1");
      expect(rows[0].history_before).toBe("1");
      expect(
        (
          await reader`select uid from receiving_current_placements where mailbox_id=${mailbox}`
        ).length,
      ).toBe(32);
      await expect(
        fresh.transaction((db) => claim(db), budget()),
      ).rejects.toThrow();
      expect((await state()).revision).toBe("1");
      await fresh.stop();
    } finally {
      await exec.stop();
      await relay.close();
    }
  });

  const history = (
    uids: number[] = Array.from({ length: 32 }, (_, i) => i + 1),
    low = 1n,
  ) => ({
    kind: "history" as const,
    evidence: {
      complete: true as const,
      epoch: 1n,
      low,
      high: 32n,
      searched: uids.map(BigInt),
      confirmedAbsent: [],
    },
    metadata: uids.map(metadata),
  });

  it("bounded metadata/frontier and conversation membership commit atomically", async () => {
    const exec = new ReceivingExecutor(url, 1),
      service = new ReceivingPersistence(exec);
    const start = performance.now();
    const published = await service.persist(
      { actor, generation: term },
      mailbox,
      initial(),
      history(),
      budget(),
    );
    console.info(
      `Stage 1 cold-client 32-row metadata transaction: ${(performance.now() - start).toFixed(2)} ms`,
    );
    expect(published.revision).toBe(1n);
    expect(published.historyBefore).toBe(1n);
    expect(
      (
        await reader`select uid from receiving_current_placements where mailbox_id=${mailbox}`
      ).length,
    ).toBe(32);
    expect(
      (
        await reader`select * from conversation_members where account_id=${accountId}`
      ).length,
    ).toBe(32);
    await expect(
      service.persist(
        { actor, generation: term },
        mailbox,
        initial(),
        history(),
        budget(),
      ),
    ).rejects.toThrow();
    expect(
      (await reader`select * from mailbox_messages where mailbox_id=${mailbox}`)
        .length,
    ).toBe(32);
    await exec.stop();
  });

  it("same-owner deletion, cursor wrap and epoch reset fence old FETCH without a ledger", async () => {
    const exec = new ReceivingExecutor(url, 1),
      service = new ReceivingPersistence(exec),
      owner = { actor, generation: term };
    let current = await service.persist(
      owner,
      mailbox,
      initial(),
      history(),
      budget(),
    );
    current = await service.persist(
      owner,
      mailbox,
      current,
      {
        kind: "repair",
        complete: true,
        epoch: 1n,
        known: Array.from({ length: 32 }, (_, i) => BigInt(i + 1)),
        present: Array.from({ length: 31 }, (_, i) => BigInt(i + 2)),
        flags: Array.from({ length: 31 }, (_, i) => ({
          ...metadata(i + 2),
          flags: ["\\Seen"],
          modseq: "3",
        })),
        wrap: false,
      },
      budget(),
    );
    current = await service.persist(
      owner,
      mailbox,
      current,
      {
        kind: "repair",
        complete: true,
        epoch: 1n,
        known: [],
        present: [],
        flags: [],
        wrap: true,
      },
      budget(),
    );
    expect(current.reconcileAfter).toBe(0n);
    expect(current.revision).toBe(3n);
    await expect(
      service.persist(owner, mailbox, initial(), history([1]), budget()),
    ).rejects.toThrow();
    expect(
      (
        await reader`select uid from receiving_current_placements where mailbox_id=${mailbox} and uid=1`
      ).length,
    ).toBe(0);
    current = await service.persist(
      owner,
      mailbox,
      current,
      { kind: "epoch", complete: true, epoch: 2n, uidNext: 2n },
      budget(),
    );
    expect(current.revision).toBe(4n);
    expect(
      (
        await reader`select * from receiving_current_placements where mailbox_id=${mailbox}`
      ).length,
    ).toBe(0);
    await expect(
      service.persist(owner, mailbox, initial(), history([1]), budget()),
    ).rejects.toThrow();
    await service.persist(
      owner,
      mailbox,
      current,
      {
        kind: "history",
        evidence: {
          complete: true,
          epoch: 2n,
          low: 1n,
          high: 1n,
          searched: [1n],
          confirmedAbsent: [],
        },
        metadata: [metadata(1)],
      },
      budget(),
    );
    expect(
      (
        await reader`select uid_validity from receiving_current_placements where mailbox_id=${mailbox}`
      ).map((row) => row.uid_validity),
    ).toEqual(["2"]);
    expect(
      (await reader`select * from mailbox_messages where mailbox_id=${mailbox}`)
        .length,
    ).toBe(32);
    await exec.stop();
  });

  it.each(["insert", "frontier", "conversation", "notification"])(
    "all-or-nothing %s failure",
    async (point) => {
      const exec = new ReceivingExecutor(url, 1),
        service = new ReceivingPersistence(exec);
      let first = metadata(
        point === "notification" ? 33 : point === "frontier" ? 13 : 1,
      );
      const second = { ...metadata(2), size: "9223372036854775808" };
      if (point === "conversation")
        first = {
          ...first,
          envelope: { ...first.envelope, subject: "fail-conversation" },
        };
      if (point === "notification")
        first = {
          ...first,
          envelope: { ...first.envelope, subject: "fail-notification" },
        };
      const mutation =
        point === "notification"
          ? {
              kind: "fresh" as const,
              evidence: {
                complete: true as const,
                epoch: 1n,
                low: 33n,
                high: 33n,
                searched: [33n],
                confirmedAbsent: [],
              },
              metadata: [first],
            }
          : {
              ...history(
                point === "insert" ? [1, 2] : [Number(first.uid)],
                point === "frontier" ? 13n : 1n,
              ),
              metadata: point === "insert" ? [first, second] : [first],
            };
      await expect(
        service.persist(
          { actor, generation: term },
          mailbox,
          initial(),
          mutation,
          budget(),
        ),
      ).rejects.toThrow();
      expect((await state()).revision).toBe("0");
      expect((await state()).history_before).toBe("33");
      expect(
        (await reader`select * from messages where account_id=${accountId}`)
          .length,
      ).toBe(0);
      expect(
        (
          await reader`select * from mailbox_messages where mailbox_id=${mailbox}`
        ).length,
      ).toBe(0);
      expect(
        (
          await reader`select * from notification_events where mailbox_id=${mailbox}`
        ).length,
      ).toBe(0);
      expect(
        (
          await reader`select * from conversation_members where account_id=${accountId}`
        ).length,
      ).toBe(0);
      await exec.stop();
    },
  );

  it("empty complete intervals advance; incomplete evidence cannot move progress", async () => {
    const exec = new ReceivingExecutor(url, 1),
      service = new ReceivingPersistence(exec),
      owner = { actor, generation: term };
    const fresh = await service.persist(
      owner,
      mailbox,
      initial(),
      {
        kind: "fresh",
        evidence: {
          complete: true,
          epoch: 1n,
          low: 33n,
          high: 40n,
          searched: [],
          confirmedAbsent: [],
        },
        metadata: [],
      },
      budget(),
    );
    expect(fresh.freshThrough).toBe(40n);
    const next = await service.persist(
      owner,
      mailbox,
      fresh,
      history([]),
      budget(),
    );
    expect(next.historyBefore).toBe(1n);
    expect(next.revision).toBe(2n);
    expect(
      (await reader`select * from mailbox_messages where mailbox_id=${mailbox}`)
        .length,
    ).toBe(0);
    expect(() =>
      service.persist(
        owner,
        mailbox,
        initial(),
        { ...history([1, 2]), metadata: [metadata(2)] },
        budget(),
      ),
    ).toThrow("Unsupported receiving interval");
    await exec.stop();
  });

  it("fresh arrival uses existing unique notification and threading semantics", async () => {
    const exec = new ReceivingExecutor(url, 1),
      service = new ReceivingPersistence(exec),
      owner = { actor, generation: term };
    const mutation = {
      kind: "fresh" as const,
      evidence: {
        complete: true as const,
        epoch: 1n,
        low: 33n,
        high: 33n,
        searched: [33n],
        confirmedAbsent: [],
      },
      metadata: [metadata(33)],
    };
    await service.persist(owner, mailbox, initial(), mutation, budget());
    await expect(
      service.persist(owner, mailbox, initial(), mutation, budget()),
    ).rejects.toThrow();
    expect(
      (
        await reader`select * from notification_events where mailbox_id=${mailbox}`
      ).length,
    ).toBe(1);
    expect(
      (
        await reader`select * from conversation_members where account_id=${accountId}`
      ).length,
    ).toBe(1);
    await exec.stop();
  });

  it("missing authority, metadata without revision and early transaction control fail closed", async () => {
    await expect(
      reader`update receiving_mailboxes set revision=revision+1 where mailbox_id=${mailbox}`,
    ).rejects.toThrow();
    await expect(
      reader`update mailboxes set selectable=false where id=${mailbox}`,
    ).rejects.toThrow();
    const exec = new ReceivingExecutor(url, 1);
    await expect(
      exec.transaction(async (db) => {
        await claim(db);
        await persistMessageMetadata(
          db,
          accountId,
          mailbox,
          1n,
          [metadata(1)],
          false,
          false,
        );
      }, budget()),
    ).rejects.toThrow();
    await expect(
      exec.transaction(
        (db) => db.execute(sql`set constraints all immediate`),
        budget(),
      ),
    ).rejects.toThrow();
    expect(
      (await reader`select * from mailbox_messages where mailbox_id=${mailbox}`)
        .length,
    ).toBe(0);
    expect((await state()).revision).toBe("0");
    await exec.stop();
  });

  it("authenticated TLS retirement leaves server ordering to conflicting locks", async () => {
    const exec = new ReceivingExecutor(url + "?sslmode=require", 2),
      holder = await reader.reserve(),
      abort = new AbortController();
    let pid: number | undefined;
    await holder`select pg_advisory_lock(917356)`;
    const pending = exec
      .transaction(
        async (db) => {
          await claim(db);
          const rows = await db.execute(sql`select pg_backend_pid() pid`);
          pid = Number(rows[0].pid);
          await db.execute(sql`select pg_advisory_xact_lock(917356)`);
        },
        { ...budget(), signal: abort.signal },
      )
      .catch((error) => error);
    try {
      await until(
        async () =>
          Boolean(
            pid &&
            (
              await reader`select 1 from pg_stat_activity where pid=${pid} and wait_event='advisory'`
            )[0],
          ),
        "TLS query did not reach barrier",
      );
      expect(
        (await reader`select ssl from pg_stat_ssl where pid=${pid!}`)[0].ssl,
      ).toBe(true);
      abort.abort();
      expect(await pending).toBeInstanceOf(ReceivingUnresolvedError);
      await holder`select pg_advisory_unlock(917356)`;
      const reloaded = await recoverReceiving(
        exec,
        { actor, generation: term },
        mailbox,
        budget(),
      );
      expect(reloaded.revision).toBe(0n);
    } finally {
      await holder`select pg_advisory_unlock(917356)`;
      holder.release();
      abort.abort();
      await pending;
      await exec.stop();
    }
  });

  it.each([false, true])(
    "bounded startup retirement closes owned transport (TLS handshake=%s)",
    async (tls) => {
      const accepted = barrier(),
        closed = barrier();
      let socket: Socket | undefined;
      const peer = createServer((connection) => {
        socket = connection;
        connection.once("close", closed.release);
        connection.on("error", () => undefined);
        if (tls)
          connection.once("data", () => {
            connection.write("S");
            connection.on("data", () => undefined);
          });
        else connection.on("data", () => undefined);
        accepted.release();
      });
      await new Promise<void>((resolve) =>
        peer.listen(0, "127.0.0.1", resolve),
      );
      const address = peer.address();
      if (!address || typeof address === "string")
        throw new Error("Missing startup peer port");
      const exec = new ReceivingExecutor(
        `postgres://fixture:fixture@127.0.0.1:${address.port}/fixture${tls ? "?sslmode=require" : ""}`,
        1,
      );
      let entered = false;
      const start = performance.now();
      const pending = exec
        .transaction(async () => {
          entered = true;
        }, budget(200))
        .catch((error) => error);
      try {
        await accepted.promise;
        expect(await pending).toBeInstanceOf(ReceivingUnresolvedError);
        await closed.promise;
        expect(entered).toBe(false);
        expect(performance.now() - start).toBeLessThan(1500);
      } finally {
        socket?.destroy();
        await exec.stop();
        await new Promise<void>((resolve) => peer.close(() => resolve()));
      }
    },
  );

  it.each([1, 2])(
    "bounded admission does not reserve another session (capacity %i)",
    async (capacity) => {
      const exec = new ReceivingExecutor(url, capacity),
        release = barrier(),
        ready = Array.from({ length: capacity }, barrier);
      const held = ready.map((item) =>
        exec.transaction(async (db) => {
          await db.execute(sql`select 1`);
          item.release();
          await release.promise;
        }, budget()),
      );
      try {
        await Promise.all(ready.map((item) => item.promise));
        let entered = false;
        await expect(
          exec.transaction(async () => {
            entered = true;
          }, budget(50)),
        ).rejects.toBeInstanceOf(ReceivingUnresolvedError);
        expect(entered).toBe(false);
      } finally {
        release.release();
        await Promise.all(held);
        await exec.stop();
      }
    },
  );

  it("shutdown revokes a suspended callback and settles its local lifetime", async () => {
    const exec = new ReceivingExecutor(url, 1),
      ready = barrier(),
      resume = barrier(),
      finished = barrier();
    let rejected = false;
    const old = exec
      .transaction(async (db) => {
        await claim(db);
        await advance(db);
        ready.release();
        await resume.promise;
        try {
          await db.execute(sql`select 1`);
        } catch {
          rejected = true;
        }
        finished.release();
      }, budget())
      .catch((error) => error);
    await ready.promise;
    await exec.stop();
    expect(await old).toBeInstanceOf(ReceivingUnresolvedError);
    resume.release();
    await finished.promise;
    expect(rejected).toBe(true);
    expect((await state()).revision).toBe("0");
    await expect(
      exec.transaction(async () => undefined, budget()),
    ).rejects.toBeInstanceOf(ReceivingUnresolvedError);
    expect((await reader`select 32 answer`)[0].answer).toBe(32);
  });

  it("statement deadline keeps progress unchanged until ordered recovery", async () => {
    const exec = new ReceivingExecutor(url, 1);
    await expect(
      exec.transaction(async (db) => {
        await claim(db);
        await advance(db);
        await db.execute(sql`select pg_sleep(2)`);
      }, budget(200)),
    ).rejects.toThrow();
    const current = await recoverReceiving(
      exec,
      { actor, generation: term },
      mailbox,
      budget(),
    );
    expect(current.revision).toBe(0n);
    expect(current.historyBefore).toBe(33n);
    await exec.stop();
  });

  it("moving a placement out of an enrolled mailbox cannot bypass authority", async () => {
    const exec = new ReceivingExecutor(url, 1),
      service = new ReceivingPersistence(exec);
    await service.persist(
      { actor, generation: term },
      mailbox,
      initial(),
      history([1]),
      budget(),
    );
    const other = randomUUID();
    await database.db.insert(mailboxes).values({
      id: other,
      accountId,
      remotePath: "Other",
      name: "Other",
      selectable: true,
      firstDiscoveredAt: new Date(),
      lastDiscoveredAt: new Date(),
    });
    await expect(
      reader`update mailbox_messages set mailbox_id=${other} where mailbox_id=${mailbox}`,
    ).rejects.toThrow();
    expect(
      (
        await reader`select * from receiving_current_placements where mailbox_id=${mailbox}`
      ).length,
    ).toBe(1);
    await exec.stop();
  });

  it("maximum UID boundary and bigint revision overflow fail without reset", async () => {
    const exec = new ReceivingExecutor(url, 1),
      service = new ReceivingPersistence(exec),
      owner = { actor, generation: term };
    const boundary = randomUUID();
    await database.db.insert(mailboxes).values({
      id: boundary,
      accountId,
      remotePath: "Boundary",
      name: "Boundary",
      selectable: true,
      firstDiscoveredAt: new Date(),
      lastDiscoveredAt: new Date(),
    });
    await service.initialize(
      owner,
      boundary,
      { complete: true, epoch: 4294967295n, uidNext: 4294967296n },
      budget(),
    );
    const current = await recoverReceiving(exec, owner, boundary, budget());
    expect(current.historyBefore).toBe(4294967296n);
    expect(current.freshThrough).toBe(4294967295n);
    // Fixture-owner seeding of an otherwise unreachable counter. The scoped
    // production API cannot reset it: DDL is prohibited by its SQL adapter.
    await reader.begin(async (tx) => {
      await tx`alter table receiving_mailboxes disable trigger user`;
      await tx`update receiving_mailboxes set revision=9223372036854775807 where mailbox_id=${mailbox}`;
      await tx`alter table receiving_mailboxes enable trigger user`;
    });
    await expect(
      service.persist(
        owner,
        mailbox,
        { ...initial(), revision: 9223372036854775807n },
        history([1]),
        budget(),
      ),
    ).rejects.toThrow();
    expect((await state()).revision).toBe("9223372036854775807");
    expect(
      (await reader`select * from mailbox_messages where mailbox_id=${mailbox}`)
        .length,
    ).toBe(0);
    await exec.stop();
  });

  it("repair does not overwrite newer per-placement MODSEQ", async () => {
    const exec = new ReceivingExecutor(url, 1),
      service = new ReceivingPersistence(exec),
      owner = { actor, generation: term };
    let current = await service.persist(
      owner,
      mailbox,
      initial(),
      history([1, 2]),
      budget(),
    );
    const repair = (modseq: string, flags: string[]) => ({
      kind: "repair" as const,
      complete: true as const,
      epoch: 1n,
      known: [1n, 2n],
      present: [1n, 2n],
      flags: [1, 2].map((uid) => ({ uid: String(uid), modseq, flags })),
      wrap: false,
    });
    current = await service.persist(
      owner,
      mailbox,
      current,
      repair("3", ["\\Seen"]),
      budget(),
    );
    current = await service.persist(
      owner,
      mailbox,
      current,
      {
        kind: "repair",
        complete: true,
        epoch: 1n,
        known: [],
        present: [],
        flags: [],
        wrap: true,
      },
      budget(),
    );
    await service.persist(
      owner,
      mailbox,
      current,
      repair("2", ["\\Flagged"]),
      budget(),
    );
    expect(
      (
        await reader`select flags,modseq from mailbox_messages where mailbox_id=${mailbox} order by uid`
      ).map((row) => ({ flags: row.flags, modseq: row.modseq })),
    ).toEqual([
      { flags: ["\\Seen"], modseq: "3" },
      { flags: ["\\Seen"], modseq: "3" },
    ]);
    await exec.stop();
  });

  it("account disable is ordered after the transaction holding its lifecycle lock", async () => {
    const exec = new ReceivingExecutor(url, 1),
      ready = barrier(),
      finish = barrier();
    const old = exec.transaction(async (db) => {
      await claim(db);
      await advance(db);
      ready.release();
      await finish.promise;
    }, budget());
    await ready.promise;
    const disable =
      reader`update mail_accounts set enabled=false where id=${accountId}`.then(
        () => undefined,
      );
    await until(
      async () =>
        Boolean(
          (
            await reader`select 1 from pg_stat_activity where query like 'update mail_accounts set enabled=false%' and wait_event_type='Lock'`
          )[0],
        ),
      "disable did not wait for lifecycle lock",
    );
    finish.release();
    await old;
    await disable;
    expect((await state()).revision).toBe("1");
    await expect(
      recoverReceiving(exec, { actor, generation: term }, mailbox, budget()),
    ).rejects.toBeInstanceOf(ReceivingUnresolvedError);
    await exec.stop();
  });
});
