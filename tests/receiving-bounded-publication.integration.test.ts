import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "@/shared/infrastructure/database/database";
import {
  mailAccounts,
  mailboxes,
} from "@/shared/infrastructure/database/schema";
import { ReceivingExecutor } from "@/shared/infrastructure/database/receiving-executor";
import type { ReceivingOwner } from "@/shared/infrastructure/database/receiving-authority";
import { ReceivingPersistence } from "@/modules/mail/application/receiving-persistence";
import type { PublicationSource } from "@/modules/mail/application/receiving-publication";
import {
  ReceivingBoundedPublication,
  type DataAuthority,
  type TopologyEntry,
  type TopologyEvidence,
} from "@/modules/mail/application/receiving-bounded-publication";
import { MailboxRoleService } from "@/modules/mail/application/mailbox-role-service";
import { receivingResponseRelay } from "./fixtures/receiving-response-relay";

const budget = () => ({ deadline: performance.now() + 5000 });
describe("R04-C bounded authority", () => {
  let container: StartedTestContainer;
  let database: ReturnType<typeof createDatabase>;
  let reader: postgres.Sql;
  let executor: ReceivingExecutor;
  let publication: ReceivingBoundedPublication;
  let owner: ReceivingOwner;
  let source: PublicationSource;
  let account: string, message: string, command: string, destination: string;
  let authority: DataAuthority;
  let url: string;
  beforeAll(async () => {
    container = await new GenericContainer("postgres:17.6-alpine")
      .withEnvironment({
        POSTGRES_USER: "fixture",
        POSTGRES_PASSWORD: "fixture-only",
        POSTGRES_DB: "fixture",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/, 2),
      )
      .start();
    const root = postgres(
      `postgres://fixture:fixture-only@${container.getHost()}:${container.getMappedPort(5432)}/fixture`,
    );
    await root`create role lane login password 'lane-fixture-only'`;
    await root`create database receiving_bounded owner lane`;
    await root.end();
    url = `postgres://lane:lane-fixture-only@${container.getHost()}:${container.getMappedPort(5432)}/receiving_bounded`;
    database = createDatabase({ databaseUrl: url, databasePoolSize: 2 });
    reader = postgres(url, { max: 3 });
    await migrate(database.db, { migrationsFolder: "db/migrations" });
    executor = new ReceivingExecutor(url, 2);
    publication = new ReceivingBoundedPublication(executor);
    await reader.unsafe(`CREATE FUNCTION fixture_bounded_hold() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF current_setting('fixture.bounded_hold',true)='true' THEN PERFORM pg_advisory_xact_lock(917441); END IF; RETURN NULL; END $$;
      CREATE CONSTRAINT TRIGGER zzz_fixture_bounded_after_l AFTER UPDATE ON receiving_mailboxes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fixture_bounded_hold();
      CREATE CONSTRAINT TRIGGER zzz_fixture_terminal_after_l AFTER DELETE ON mail_accounts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fixture_bounded_hold();
      CREATE FUNCTION fixture_bounded_arm() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN PERFORM set_config('fixture.bounded_hold','true',true); RETURN pg_backend_pid(); END $$;
      CREATE FUNCTION fixture_bounded_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF current_setting('fixture.bounded_fail',true)=NEW.mailbox_id::text THEN RAISE EXCEPTION 'Injected second-scope failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER zzz_fixture_bounded_fail BEFORE UPDATE ON receiving_mailboxes FOR EACH ROW EXECUTE FUNCTION fixture_bounded_fail();`);
    await reader.unsafe(`CREATE FUNCTION fixture_bounded_inject(mailbox uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
      PERFORM set_config('fixture.bounded_fail',mailbox::text,true); END $$;`);
  });
  beforeEach(async () => {
    await reader`update receiving_coordinator set expires_at='-infinity'`;
    const actor = randomUUID();
    const [lease] =
      await reader`select maildock_receiving_acquire(${actor}::uuid,60000) as generation`;
    owner = { actor, generation: BigInt(lease.generation) };
    account = randomUUID();
    const mailbox = randomUUID();
    await database.db.insert(mailAccounts).values({
      id: account,
      displayName: "Publication fixture",
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
      name: "INBOX",
      remotePath: "INBOX",
      selectable: true,
      firstDiscoveredAt: new Date(),
      lastDiscoveredAt: new Date(),
    });
    const persistence = new ReceivingPersistence(executor);
    await persistence.initialize(
      owner,
      mailbox,
      { complete: true, epoch: 7n, uidNext: 2n },
      budget(),
    );
    await persistence.persist(
      owner,
      mailbox,
      {
        epoch: 7n,
        revision: 0n,
        freshThrough: 1n,
        historyBefore: 2n,
        reconcileAfter: 0n,
      },
      {
        kind: "history",
        evidence: {
          complete: true,
          epoch: 7n,
          low: 1n,
          high: 1n,
          searched: [1n],
          confirmedAbsent: [],
        },
        metadata: [
          {
            uid: "1",
            internalDate: "2026-01-01T00:00:00Z",
            size: "10",
            flags: [],
            hasAttachments: true,
            envelope: {
              messageId: `<${account}@example.test>`,
              subject: "Fixture",
              from: [],
              sender: [],
              replyTo: [],
              to: [],
              cc: [],
              bcc: [],
            },
            mimeStructure: {
              part: "1",
              type: "application/pdf",
              disposition: "attachment",
              filename: "fixture.pdf",
              encoding: "base64",
              size: "10",
              contentId: null,
              parameters: {},
              dispositionParameters: {},
              children: [],
            },
          },
        ],
      },
      budget(),
    );
    source = {
      mailbox,
      configuration: 1n,
      state: {
        epoch: 7n,
        revision: 1n,
        freshThrough: 1n,
        historyBefore: 1n,
        reconcileAfter: 0n,
      },
    };

    destination = randomUUID();
    await database.db.insert(mailboxes).values({
      id: destination,
      accountId: account,
      name: "Archive",
      remotePath: "Archive",
      selectable: true,
      firstDiscoveredAt: new Date(),
      lastDiscoveredAt: new Date(),
    });
    await persistence.initialize(
      owner,
      destination,
      { complete: true, epoch: 9n, uidNext: 1n },
      budget(),
    );
    await reader`update mail_accounts set imap_capabilities=ARRAY['MOVE'] where id=${account}`;
    await new MailboxRoleService(database.db).setManual(
      account,
      "archive",
      destination,
    );
    const [p] =
      await reader`select * from mailbox_messages where mailbox_id=${mailbox}`;
    message = p.message_id;
    command = randomUUID();
    await reader`insert into message_commands(id,account_id,mailbox_id,placement_id,message_id,action,source_path,source_uid_validity,source_uid,source_configuration_binding,destination_mailbox_id,destination_path)
      values(${command},${account},${mailbox},${p.id},${message},'archive','INBOX',7,1,1,${destination},'Archive')`;
    authority = {
      owner,
      account,
      configuration: 1n,
      lifecycle: 1n,
      scopes: [
        { ...source, path: "INBOX" },
        {
          mailbox: destination,
          path: "Archive",
          configuration: 1n,
          state: {
            epoch: 9n,
            revision: 0n,
            freshThrough: 0n,
            historyBefore: 1n,
            reconcileAfter: 0n,
          },
        },
      ],
    };
  });
  afterAll(async () => {
    await executor?.stop();
    await reader?.end({ timeout: 0 });
    await database?.client.end({ timeout: 0 });
    await container?.stop();
  });
  const advance = () => {
    authority = {
      ...authority,
      scopes: authority.scopes.map((s) => ({
        ...s,
        state: { ...s.state, revision: s.state.revision + 1n },
      })),
    };
  };
  const move = () => ({
    complete: true as const,
    taggedOk: true as const,
    sourceEpoch: 7n,
    sourceUid: 1n,
    destinationEpoch: 9n,
    destinationUid: 1n,
    sourceRemoved: true,
    flags: [] as readonly string[],
    modseq: null,
  });
  const encode = (value: unknown) =>
    JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  const scopes = () =>
    encode(
      authority.scopes.map((s) => ({
        mailbox: s.mailbox,
        path: s.path,
        state: s.state,
      })),
    );
  const moveSql = (attempt: string) =>
    sql`select maildock_receiving_move_result(${owner.actor}::uuid,${owner.generation}::bigint,${account}::uuid,1,1,${scopes()}::jsonb,${command}::uuid,${attempt}::uuid,${encode(move())}::jsonb)`;
  const terminalSql = () =>
    sql`select maildock_receiving_terminal_remove(${account}::uuid,1,1)`;
  for (const capability of ["move", "terminal"] as const)
    it(`${capability}: lost COMMIT reply is recovered under conflicting locks`, async () => {
      let attempt: Record<string, unknown> | undefined;
      if (capability === "move") {
        attempt = await publication.claim(authority, "move", command, budget());
        advance();
      }
      const relay = await receivingResponseRelay(url, (bytes) => {
        if (bytes.includes(Buffer.from("commit\0"))) relay.control.drop = true;
      });
      const lossy = new ReceivingExecutor(relay.url, 1);
      const writes = new ReceivingBoundedPublication(lossy);
      try {
        const opts = { deadline: performance.now() + 700 };
        await expect(
          capability === "move"
            ? writes.moveResult(
                authority,
                command,
                attempt!.id as string,
                move(),
                opts,
              )
            : writes.removeAccount(account, 1n, 1n, opts),
        ).rejects.toThrow();
        if (capability === "move") {
          const observed = await publication.recover(
            authority,
            "move",
            command,
            budget(),
          );
          expect(observed.intent.status).toBe("succeeded");
          advance();
          await expect(
            publication.moveResult(
              authority,
              command,
              attempt!.id as string,
              move(),
              budget(),
            ),
          ).rejects.toThrow();
        } else {
          expect(
            await publication.recoverRemoval(account, 1n, 1n, budget()),
          ).toBe(true);
          expect((await facts()).states).toBeNull();
        }
      } finally {
        await lossy.stop();
        await relay.close();
      }
    });
  const appendEvidence = () => ({
    kind: "append" as const,
    complete: true as const,
    taggedOk: true as const,
    destinationEpoch: 9n,
    destinationUid: 1n,
    message,
    flags: ["\\Seen"],
    modseq: null,
  });
  it("SQL rejects a third scope and an actual other-account mailbox", async () => {
    const before = await facts();
    const third = encode([
      ...authority.scopes.map((s) => ({
        mailbox: s.mailbox,
        path: s.path,
        state: s.state,
      })),
      { mailbox: randomUUID(), path: "Third", state: source.state },
    ]);
    await expect(
      executor.transaction(
        (db) =>
          db.execute(
            sql`select maildock_receiving_move_claim(${owner.actor}::uuid,${owner.generation}::bigint,${account}::uuid,1,1,${third}::jsonb,${command}::uuid,${randomUUID()}::uuid)`,
          ),
        budget(),
      ),
    ).rejects.toThrow();
    const otherAccount = randomUUID(),
      otherMailbox = randomUUID();
    const [original] =
      await reader`select to_jsonb(a) row from mail_accounts a where id=${account}`;
    await reader`insert into mail_accounts select (jsonb_populate_record(NULL::mail_accounts,${reader.json({ ...original.row, id: otherAccount })}::jsonb)).*`;
    await database.db.insert(mailboxes).values({
      id: otherMailbox,
      accountId: otherAccount,
      name: "Other",
      remotePath: "Other",
      selectable: true,
      firstDiscoveredAt: new Date(),
      lastDiscoveredAt: new Date(),
    });
    await new ReceivingPersistence(executor).initialize(
      owner,
      otherMailbox,
      { complete: true, epoch: 9n, uidNext: 1n },
      budget(),
    );
    const mixed = {
      ...authority,
      scopes: authority.scopes.map((s) =>
        s.mailbox === destination
          ? { ...s, mailbox: otherMailbox, path: "Other" }
          : s,
      ),
    };
    await expect(
      publication.claim(mixed, "move", command, budget()),
    ).rejects.toThrow();
    expect(await facts()).toEqual(before);
  });
  it("32-row MOVE oracle rejects a cancelled callback and preserves replacement publication", async () => {
    await executor.transaction(async (db) => {
      await db.execute(
        sql`select maildock_receiving_claim(${owner.actor}::uuid,${owner.generation}::bigint,${source.mailbox}::uuid,7,1,1,1,0)`,
      );
      await db.execute(
        sql`insert into mailbox_messages(id,mailbox_id,message_id,uid_validity,uid,first_synchronized_at,last_synchronized_at) select gen_random_uuid(),${source.mailbox}::uuid,${message}::uuid,7,u,clock_timestamp(),clock_timestamp() from generate_series(2,32) u`,
      );
      await db.execute(
        sql`update receiving_mailboxes set revision=revision+1 where mailbox_id=${source.mailbox}::uuid`,
      );
    }, budget());
    authority = {
      ...authority,
      scopes: authority.scopes.map((s) =>
        s.mailbox === source.mailbox
          ? { ...s, state: { ...s.state, revision: 2n } }
          : s,
      ),
    };
    const attempt = await publication.claim(
      authority,
      "move",
      command,
      budget(),
    );
    advance();
    const ready = gate(),
      resume = gate(),
      done = gate(),
      abort = new AbortController();
    let rejected = false;
    const old = executor
      .transaction(
        async (db) => {
          await db.execute(moveSql(attempt.id as string));
          ready.release();
          await resume.promise;
          try {
            await db.execute(
              sql`delete from mailbox_messages where mailbox_id=${source.mailbox}::uuid`,
            );
          } catch {
            rejected = true;
          }
          done.release();
        },
        { ...budget(), signal: abort.signal },
      )
      .catch((error) => error);
    await ready.promise;
    abort.abort();
    await old;
    const recovered = await publication.recover(
      authority,
      "move",
      command,
      budget(),
    );
    expect(recovered.intent.status).toBe("executing");
    await publication.moveResult(
      authority,
      command,
      attempt.id as string,
      move(),
      budget(),
    );
    const replacement = await facts();
    resume.release();
    await done.promise;
    expect(rejected).toBe(true);
    expect(await facts()).toEqual(replacement);
    expect(replacement.placements).toHaveLength(32);
    expect(
      replacement.placements.filter(
        (p: { mailbox_id: string }) => p.mailbox_id === source.mailbox,
      ),
    ).toHaveLength(31);
  });
  for (const operation of ["move", "append"] as const)
    it(`${operation}: matching uncertainty failure is single-use and preserves canonical facts`, async () => {
      const id = operation === "move" ? command : await outgoing();
      let a = operation === "move" ? authority : appendAuthority();
      const attempt = await publication.claim(a, operation, id, budget());
      a = {
        ...a,
        scopes: a.scopes.map((s) => ({
          ...s,
          state: { ...s.state, revision: s.state.revision + 1n },
        })),
      };
      const before = (await facts()).placements;
      await publication.fail(
        a,
        operation,
        id,
        attempt.id as string,
        "uncertain_remote_execution",
        budget(),
      );
      expect((await facts()).placements).toEqual(before);
      a = {
        ...a,
        scopes: a.scopes.map((s) => ({
          ...s,
          state: { ...s.state, revision: s.state.revision + 1n },
        })),
      };
      await expect(
        publication.fail(
          a,
          operation,
          id,
          attempt.id as string,
          "failed_before_execution",
          budget(),
        ),
      ).rejects.toThrow();
      await expect(
        publication.claim(a, operation, id, budget()),
      ).rejects.toThrow();
    });
  for (const invalid of [
    "unknown-message",
    "epoch",
    "zero-uid",
    "duplicate-flags",
    "attempt",
    "expired-owner",
  ] as const)
    it(`APPEND rejects ${invalid} and preserves saving result`, async () => {
      const id = await outgoing();
      let a = appendAuthority();
      const attempt = await publication.claim(a, "append", id, budget());
      a = {
        ...a,
        scopes: a.scopes.map((s) => ({
          ...s,
          state: { ...s.state, revision: s.state.revision + 1n },
        })),
      };
      let evidence = appendEvidence();
      if (invalid === "unknown-message")
        evidence = { ...evidence, message: randomUUID() };
      if (invalid === "epoch")
        evidence = { ...evidence, destinationEpoch: 10n };
      if (invalid === "zero-uid")
        evidence = { ...evidence, destinationUid: 0n };
      if (invalid === "duplicate-flags")
        evidence = { ...evidence, flags: ["\\Seen", "\\Seen"] };
      if (invalid === "expired-owner")
        await reader`update receiving_coordinator set expires_at='-infinity'`;
      const before = await facts();
      await expect(
        publication.appendResult(
          a,
          id,
          invalid === "attempt" ? randomUUID() : (attempt.id as string),
          evidence,
          budget(),
        ),
      ).rejects.toThrow();
      expect(await facts()).toEqual(before);
      expect(
        (
          await reader`select sent_copy_status from outgoing_messages where id=${id}`
        )[0].sent_copy_status,
      ).toBe("saving");
    });
  for (const invalid of [
    "stale-epoch",
    "partial-mapping",
    "conflicting-placement",
    "attempt",
    "duplicate-flags",
  ] as const)
    it(`MOVE rejects ${invalid} without partial settlement`, async () => {
      const attempt = await publication.claim(
        authority,
        "move",
        command,
        budget(),
      );
      advance();
      let evidence = move();
      if (invalid === "stale-epoch")
        evidence = { ...evidence, destinationEpoch: 10n };
      if (invalid === "duplicate-flags")
        evidence = { ...evidence, flags: ["\\Seen", "\\Seen"] };
      if (invalid === "conflicting-placement") {
        await executor.transaction(async (db) => {
          await db.execute(
            sql`select maildock_receiving_claim(${owner.actor}::uuid,${owner.generation}::bigint,${destination}::uuid,9,1,0,1,0)`,
          );
          await db.execute(
            sql`insert into mailbox_messages(id,mailbox_id,message_id,uid_validity,uid,first_synchronized_at,last_synchronized_at) values(gen_random_uuid(),${destination}::uuid,${message}::uuid,9,1,clock_timestamp(),clock_timestamp())`,
          );
          await db.execute(
            sql`update receiving_mailboxes set revision=revision+1 where mailbox_id=${destination}::uuid`,
          );
        }, budget());
        authority = {
          ...authority,
          scopes: authority.scopes.map((s) =>
            s.mailbox === destination
              ? { ...s, state: { ...s.state, revision: s.state.revision + 1n } }
              : s,
          ),
        };
      }
      const before = await facts();
      await expect(
        publication.moveResult(
          authority,
          command,
          invalid === "attempt" ? randomUUID() : (attempt.id as string),
          invalid === "partial-mapping"
            ? { ...evidence, destinationUid: null }
            : evidence,
          budget(),
        ),
      ).rejects.toThrow();
      expect(await facts()).toEqual(before);
    });
  it("topology supports the 128-identity boundary and autodetected role publication", async () => {
    const snapshot = await publication.captureTopology(
      owner,
      account,
      budget(),
    );
    const sent = randomUUID();
    const entries = [
      topologyEntry(source.mailbox, "INBOX"),
      topologyEntry(destination, "Archive"),
      { ...topologyEntry(sent, "Sent"), specialUse: ["\\Sent"] },
      ...Array.from({ length: 125 }, (_, i) =>
        topologyEntry(randomUUID(), `Folder${i}`),
      ),
    ];
    await publication.topologyResult(
      owner,
      account,
      snapshot,
      topology(entries),
      budget(),
    );
    expect(
      (
        await reader`select count(*) from mailboxes where account_id=${account}`
      )[0].count,
    ).toBe("128");
    expect(
      (
        await reader`select mailbox_id,source from mailbox_roles where account_id=${account} and role='sent'`
      )[0],
    ).toEqual({ mailbox_id: sent, source: "special_use" });
  });
  for (const capability of ["move", "topology"] as const)
    it(`${capability} cannot mutate unrelated message or cache facts in its transaction`, async () => {
      let statement;
      if (capability === "move") {
        const attempt = await publication.claim(
          authority,
          "move",
          command,
          budget(),
        );
        advance();
        statement = moveSql(attempt.id as string);
      } else {
        const snapshot = await publication.captureTopology(
          owner,
          account,
          budget(),
        );
        statement = sql`select maildock_receiving_topology_result(${owner.actor}::uuid,${owner.generation}::bigint,${account}::uuid,${encode(snapshot)}::jsonb,${encode(topology())}::jsonb)`;
      }
      const before = await facts();
      await expect(
        executor.transaction(async (db) => {
          await db.execute(statement);
          await db.execute(
            sql`update messages set subject='forged',search_body='forged' where id=${message}::uuid`,
          );
        }, budget()),
      ).rejects.toThrow();
      expect(await facts()).toEqual(before);
    });
  it("terminal deletion cannot commit with the account identity recreated", async () => {
    const [original] =
      await reader`select to_jsonb(a) row from mail_accounts a where id=${account}`;
    const before = await facts();
    const rejection = await executor
      .transaction(async (db) => {
        await db.execute(terminalSql());
        await db.execute(
          sql`insert into mail_accounts select (jsonb_populate_record(NULL::mail_accounts,${encode(original.row)}::jsonb)).*`,
        );
      }, budget())
      .catch((error) => error);
    expect(rejection.cause.message).toContain(
      "Terminal COMMIT requires complete removed identity",
    );
    expect(await facts()).toEqual(before);
  });
  it("terminal DB-clock transaction budget rejects expiry before L atomically", async () => {
    const before = await facts();
    const rejected = await executor
      .transaction(async (db) => {
        await db.execute(terminalSql());
        const [row] = await db.execute(
          sql`select current_setting('maildock.receiving_bounded_scope')::jsonb->>'deadline' deadline`,
        );
        const until = performance.now() + 3000;
        while (
          !(
            await reader`select clock_timestamp()>=${row.deadline as string}::timestamptz expired`
          )[0].expired
        ) {
          if (performance.now() > until)
            throw Error("Terminal DB-clock deadline did not expire");
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }, budget())
      .catch((error) => error);
    expect(rejected.cause.message).toContain(
      "Terminal COMMIT transaction budget expired",
    );
    expect(await facts()).toEqual(before);
  });
  it("bounded capability cannot acquire a third scope through legacy recovery", async () => {
    const third = randomUUID();
    await database.db.insert(mailboxes).values({
      id: third,
      accountId: account,
      name: "Third",
      remotePath: "Third",
      selectable: true,
      firstDiscoveredAt: new Date(),
      lastDiscoveredAt: new Date(),
    });
    await new ReceivingPersistence(executor).initialize(
      owner,
      third,
      { complete: true, epoch: 11n, uidNext: 1n },
      budget(),
    );
    const before = await facts();
    await expect(
      executor.transaction(async (db) => {
        await db.execute(
          sql`select maildock_receiving_move_claim(${owner.actor}::uuid,${owner.generation}::bigint,${account}::uuid,1,1,${scopes()}::jsonb,${command}::uuid,${randomUUID()}::uuid)`,
        );
        await db.execute(
          sql`select maildock_receiving_recover(${owner.actor}::uuid,${owner.generation}::bigint,${third}::uuid)`,
        );
      }, budget()),
    ).rejects.toMatchObject({
      cause: { message: "Bounded operation cannot acquire a legacy scope" },
    });
    expect(await facts()).toEqual(before);
  });
  it("malformed late topology entry rolls back earlier additions and missing transitions", async () => {
    const snapshot = await publication.captureTopology(
      owner,
      account,
      budget(),
    );
    const before = await facts();
    const ids = [randomUUID(), randomUUID()].sort();
    const entries = [
      topologyEntry(ids[0], "Good"),
      { ...topologyEntry(ids[1], "Bad"), name: 42 } as unknown as TopologyEntry,
    ];
    await expect(
      publication.topologyResult(
        owner,
        account,
        snapshot,
        topology(entries),
        budget(),
      ),
    ).rejects.toThrow();
    expect(await facts()).toEqual(before);
  });
  async function facts() {
    return (
      await reader`select
      (select jsonb_agg(to_jsonb(s) order by s.mailbox_id) from receiving_mailboxes s join mailboxes b on b.id=s.mailbox_id where b.account_id=${account}) states,
      (select jsonb_agg(to_jsonb(p) order by p.id) from mailbox_messages p join mailboxes b on b.id=p.mailbox_id where b.account_id=${account}) placements,
      (select jsonb_agg(to_jsonb(c) order by id) from message_commands c where account_id=${account}) commands,
      (select jsonb_agg(to_jsonb(m) order by id) from messages m where account_id=${account}) messages,
      (select jsonb_agg(to_jsonb(b) order by id) from mailboxes b where account_id=${account}) folders,
      (select jsonb_agg(to_jsonb(r) order by role) from mailbox_roles r where account_id=${account}) roles,
      (select jsonb_agg(to_jsonb(r) order by id) from outgoing_messages r where account_id=${account}) outgoing,
      (select jsonb_agg(to_jsonb(c) order by c.message_id) from message_contents c join messages m on m.id=c.message_id where m.account_id=${account}) contents,
      (select jsonb_agg(to_jsonb(c) order by c.id) from message_attachments c join messages m on m.id=c.message_id where m.account_id=${account}) attachments`
    )[0];
  }
  function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => (release = resolve));
    return { release, promise };
  }
  const topologyEntry = (id: string, remotePath: string): TopologyEntry => ({
    id,
    path: remotePath,
    name: remotePath,
    delimiter: "/",
    attributes: [],
    specialUse: [],
    selectable: true,
    subscribed: null,
    providerMailboxId: null,
  });
  const topology = (
    entries = [
      topologyEntry(source.mailbox, "INBOX"),
      topologyEntry(destination, "Archive"),
    ],
  ): TopologyEvidence => {
    const requestId = randomUUID();
    return {
      complete: true,
      taggedOk: true,
      namespace: "*",
      subscribedOnly: false,
      requestId,
      completedRequestId: requestId,
      entries,
    };
  };
  async function outgoing() {
    const id = randomUUID();
    await reader`insert into outgoing_messages(id,account_id,"from","to",cc,bcc,subject,plain_text,message_id,mime_base64,status,sent_copy_policy,sent_copy_status,sent_copy_mailbox_id,sent_copy_path)
      values(${id},${account},'{}','[{}]','[]','[]','Fixture','Fixture',${`<${account}@example.test>`},'Zml4dHVyZQ==','sent','maildock','pending',${destination},'Archive')`;
    return id;
  }
  const appendAuthority = (): DataAuthority => ({
    ...authority,
    scopes: authority.scopes.filter((s) => s.mailbox === destination),
  });
  it("MOVE atomically removes source, links known destination, settles command and advances each revision once", async () => {
    const before = await facts();
    const attempt = await publication.claim(
      authority,
      "move",
      command,
      budget(),
    );
    advance();
    const captured = attempt.scopes as { mailbox: string }[];
    expect(captured.map((s) => s.mailbox)).toEqual(
      authority.scopes.map((s) => s.mailbox).sort(),
    );
    await publication.moveResult(
      authority,
      command,
      attempt.id as string,
      move(),
      budget(),
    );
    advance();
    const after = await facts();
    expect(after.messages).toEqual(before.messages);
    expect(after.placements).toHaveLength(1);
    expect(after.placements[0].mailbox_id).toBe(destination);
    expect(after.placements[0].uid).toBe(1);
    expect(after.commands[0].status).toBe("succeeded");
    expect(after.commands[0].placement_id).toBeNull();
    for (const s of before.states)
      expect(
        after.states.find(
          (n: { mailbox_id: string }) => n.mailbox_id === s.mailbox_id,
        ),
      ).toEqual({ ...s, revision: s.revision + 2 });
    await expect(
      publication.moveResult(
        authority,
        command,
        attempt.id as string,
        move(),
        budget(),
      ),
    ).rejects.toThrow();
  });
  it("opposite scope order serializes concurrent claims without a deadlock", async () => {
    const results = await Promise.allSettled([
      publication.claim(authority, "move", command, budget()),
      publication.claim(
        { ...authority, scopes: [...authority.scopes].reverse() },
        "move",
        command,
        budget(),
      ),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
  for (const invalid of [
    "third",
    "cross-account",
    "destination-path",
    "destination-revision",
    "destination-epoch",
    "configuration",
    "lifecycle",
    "actor",
  ] as const) {
    it(`rejects ${invalid} data authority with both scopes unchanged`, async () => {
      let bad = authority;
      if (invalid === "third")
        bad = { ...bad, scopes: [...bad.scopes, bad.scopes[0]] };
      if (invalid === "cross-account") bad = { ...bad, account: randomUUID() };
      if (invalid === "configuration")
        bad = {
          ...bad,
          configuration: 2n,
          scopes: bad.scopes.map((s) => ({ ...s, configuration: 2n })),
        };
      if (invalid === "lifecycle") bad = { ...bad, lifecycle: 2n };
      if (invalid === "actor")
        bad = { ...bad, owner: { ...owner, actor: randomUUID() } };
      if (invalid.startsWith("destination"))
        bad = {
          ...bad,
          scopes: bad.scopes.map((s) =>
            s.mailbox === destination
              ? {
                  ...s,
                  path: invalid === "destination-path" ? "wrong" : s.path,
                  state: {
                    ...s.state,
                    revision:
                      invalid === "destination-revision"
                        ? 1n
                        : s.state.revision,
                    epoch:
                      invalid === "destination-epoch" ? 10n : s.state.epoch,
                  },
                }
              : s,
          ),
        };
      const before = await facts();
      await expect(
        Promise.resolve().then(() =>
          publication.claim(bad, "move", command, budget()),
        ),
      ).rejects.toThrow();
      expect(await facts()).toEqual(before);
    });
  }
  it("missing destination UID records uncertainty and repair without inventing placements", async () => {
    const attempt = await publication.claim(
      authority,
      "move",
      command,
      budget(),
    );
    advance();
    const before = await facts();
    await publication.moveResult(
      authority,
      command,
      attempt.id as string,
      {
        ...move(),
        destinationEpoch: null,
        destinationUid: null,
        sourceRemoved: false,
      },
      budget(),
    );
    const after = await facts();
    expect(after.placements).toEqual(before.placements);
    expect(after.commands[0].error).toBe("uncertain_remote_execution");
    const due =
      await reader`select receiving_request_generation from mailboxes where id in (${source.mailbox},${destination})`;
    expect(due.every((r) => BigInt(r.receiving_request_generation) > 0n)).toBe(
      true,
    );
  });
  it("late role replacement rejects the frozen MOVE destination", async () => {
    const attempt = await publication.claim(
      authority,
      "move",
      command,
      budget(),
    );
    advance();
    await new MailboxRoleService(database.db).setManual(
      account,
      "archive",
      source.mailbox,
    );
    const before = await facts();
    await expect(
      publication.moveResult(
        authority,
        command,
        attempt.id as string,
        move(),
        budget(),
      ),
    ).rejects.toThrow();
    expect(await facts()).toEqual(before);
  });
  it("second-scope failure rolls back destination, source and business result together", async () => {
    const attempt = await publication.claim(
      authority,
      "move",
      command,
      budget(),
    );
    advance();
    const before = await facts();
    await expect(
      executor.transaction(async (db) => {
        await db.execute(
          sql`select fixture_bounded_inject(${destination}::uuid)`,
        );
        await db.execute(moveSql(attempt.id as string));
      }, budget()),
    ).rejects.toThrow();
    expect(await facts()).toEqual(before);
  });
  it("APPEND publishes known destination metadata link and sent-copy result together", async () => {
    const id = await outgoing();
    let a = appendAuthority();
    const attempt = await publication.claim(a, "append", id, budget());
    a = {
      ...a,
      scopes: a.scopes.map((s) => ({
        ...s,
        state: { ...s.state, revision: s.state.revision + 1n },
      })),
    };
    await publication.appendResult(
      a,
      id,
      attempt.id as string,
      {
        kind: "append",
        complete: true,
        taggedOk: true,
        destinationEpoch: 9n,
        destinationUid: 1n,
        message,
        flags: ["\\Seen"],
        modseq: null,
      },
      budget(),
    );
    const [r] = await reader`select * from outgoing_messages where id=${id}`;
    expect(r.sent_copy_status).toBe("saved");
    expect(r.sent_copy_sync_pending).toBe(false);
    expect(r.sent_copy_uid).toBe("1");
    expect((await facts()).placements).toHaveLength(2);
    const saved = await facts();
    await expect(
      reader`update outgoing_messages set sent_copy_status='pending',sent_copy_uid=null,sent_copy_uid_validity=null,sent_copy_saved_at=null where id=${id}`,
    ).rejects.toThrow();
    expect(await facts()).toEqual(saved);
  });
  it("APPEND without known UID becomes uncertain and cannot be claimed again", async () => {
    const id = await outgoing();
    let a = appendAuthority();
    const attempt = await publication.claim(a, "append", id, budget());
    a = {
      ...a,
      scopes: a.scopes.map((s) => ({
        ...s,
        state: { ...s.state, revision: s.state.revision + 1n },
      })),
    };
    const before = (await facts()).placements;
    await publication.appendResult(
      a,
      id,
      attempt.id as string,
      {
        kind: "append",
        complete: true,
        taggedOk: true,
        destinationEpoch: null,
        destinationUid: null,
        message: null,
        flags: [],
        modseq: null,
      },
      budget(),
    );
    expect((await facts()).placements).toEqual(before);
    expect(
      (
        await reader`select sent_copy_status from outgoing_messages where id=${id}`
      )[0].sent_copy_status,
    ).toBe("uncertain");
    a = {
      ...a,
      scopes: a.scopes.map((s) => ({
        ...s,
        state: { ...s.state, revision: s.state.revision + 1n },
      })),
    };
    await expect(
      publication.claim(a, "append", id, budget()),
    ).rejects.toThrow();
  });
  it("complete topology adds identity, marks unseen missing and preserves remote facts and manual roles", async () => {
    const before = await facts();
    const snapshot = await publication.captureTopology(
      owner,
      account,
      budget(),
    );
    const added = randomUUID();
    await publication.topologyResult(
      owner,
      account,
      snapshot,
      topology([
        topologyEntry(destination, "Archive"),
        topologyEntry(added, "New"),
      ]),
      budget(),
    );
    const folders =
      await reader`select * from mailboxes where account_id=${account}`;
    expect(folders.find((b) => b.id === source.mailbox)?.lifecycle_status).toBe(
      "missing",
    );
    expect(folders.find((b) => b.id === added)?.uid_validity).toBeNull();
    const after = await facts();
    expect(after.messages).toEqual(before.messages);
    expect(after.placements).toEqual(before.placements);
    for (const s of before.states)
      expect(
        after.states.find(
          (n: { mailbox_id: string }) => n.mailbox_id === s.mailbox_id,
        ),
      ).toEqual({ ...s, revision: s.revision + 1 });
    expect(
      (
        await reader`select source,mailbox_id from mailbox_roles where account_id=${account} and role='archive'`
      )[0],
    ).toEqual({ source: "manual", mailbox_id: destination });
  });
  it("APPEND known UID retains due metadata work until exact targeted lookup publication", async () => {
    const id = await outgoing();
    let a = appendAuthority();
    const attempt = await publication.claim(a, "append", id, budget());
    const nextAppend = () => {
      a = {
        ...a,
        scopes: a.scopes.map((s) => ({
          ...s,
          state: { ...s.state, revision: s.state.revision + 1n },
        })),
      };
    };
    nextAppend();
    const before = (await facts()).placements;
    await publication.appendResult(
      a,
      id,
      attempt.id as string,
      { ...appendEvidence(), message: null },
      budget(),
    );
    nextAppend();
    const [pending] =
      await reader`select * from outgoing_messages where id=${id}`;
    expect(pending.sent_copy_status).toBe("saved");
    expect(pending.sent_copy_sync_pending).toBe(true);
    expect(pending.receiving_attempt.phase).toBe("awaiting_metadata");
    expect((await facts()).placements).toEqual(before);
    await expect(
      publication.appendResult(
        a,
        id,
        attempt.id as string,
        { ...appendEvidence(), kind: "lookup", destinationUid: 2n },
        budget(),
      ),
    ).rejects.toThrow();
    await expect(
      publication.fail(
        a,
        "append",
        id,
        attempt.id as string,
        "uncertain_remote_execution",
        budget(),
      ),
    ).rejects.toThrow();
    await executor.transaction(async (db) => {
      await db.execute(
        sql`select maildock_receiving_claim(${owner.actor}::uuid,${owner.generation}::bigint,${destination}::uuid,9,2,0,1,0)`,
      );
      await db.execute(
        sql`insert into mailbox_messages(id,mailbox_id,message_id,uid_validity,uid,flags,first_synchronized_at,last_synchronized_at) values(gen_random_uuid(),${destination}::uuid,${message}::uuid,9,1,ARRAY[${"\\Seen"}],clock_timestamp(),clock_timestamp())`,
      );
      await db.execute(
        sql`update receiving_mailboxes set revision=revision+1 where mailbox_id=${destination}::uuid`,
      );
    }, budget());
    nextAppend();
    const existingPlacements = (await facts()).placements;
    await publication.appendResult(
      a,
      id,
      attempt.id as string,
      { ...appendEvidence(), kind: "lookup" },
      budget(),
    );
    nextAppend();
    expect(
      (
        await reader`select sent_copy_sync_pending from outgoing_messages where id=${id}`
      )[0].sent_copy_sync_pending,
    ).toBe(false);
    expect((await facts()).placements).toEqual(existingPlacements);
    await expect(
      publication.appendResult(
        a,
        id,
        attempt.id as string,
        { ...appendEvidence(), kind: "lookup" },
        budget(),
      ),
    ).rejects.toThrow();
  });
  for (const invalid of [
    "partial",
    "tagged",
    "namespace",
    "subscribed",
    "correlation",
    "oversized",
    "overflow",
    "union-overflow",
    "duplicate",
    "remote-fact",
  ] as const) {
    it(`topology rejects ${invalid} atomically`, async () => {
      const snapshot = await publication.captureTopology(
        owner,
        account,
        budget(),
      );
      let evidence: unknown = topology();
      if (invalid === "partial") evidence = { ...topology(), complete: false };
      if (invalid === "tagged") evidence = { ...topology(), taggedOk: false };
      if (invalid === "namespace")
        evidence = { ...topology(), namespace: "INBOX" };
      if (invalid === "subscribed")
        evidence = { ...topology(), subscribedOnly: true };
      if (invalid === "correlation")
        evidence = { ...topology(), completedRequestId: randomUUID() };
      if (invalid === "oversized")
        evidence = topology([
          {
            ...topologyEntry(source.mailbox, "INBOX"),
            name: "x".repeat(2097152),
          },
        ]);
      if (invalid === "overflow" || invalid === "union-overflow")
        evidence = topology(
          Array.from({ length: invalid === "overflow" ? 129 : 127 }, (_, i) =>
            topologyEntry(randomUUID(), `New${i}`),
          ),
        );
      if (invalid === "duplicate")
        evidence = topology([
          topologyEntry(source.mailbox, "INBOX"),
          topologyEntry(source.mailbox, "Other"),
        ]);
      if (invalid === "remote-fact")
        evidence = topology([
          {
            ...topologyEntry(source.mailbox, "INBOX"),
            uidValidity: "99",
          } as TopologyEntry,
        ]);
      const before = await facts();
      await expect(
        publication.topologyResult(
          owner,
          account,
          snapshot,
          evidence as TopologyEvidence,
          budget(),
        ),
      ).rejects.toThrow();
      expect(await facts()).toEqual(before);
    });
  }
  it("captured topology rejects concurrent manual mapping replacement", async () => {
    const snapshot = await publication.captureTopology(
      owner,
      account,
      budget(),
    );
    await new MailboxRoleService(database.db).setManual(
      account,
      "archive",
      source.mailbox,
    );
    const before = await facts();
    await expect(
      publication.topologyResult(
        owner,
        account,
        snapshot,
        topology(),
        budget(),
      ),
    ).rejects.toThrow();
    expect(await facts()).toEqual(before);
  });
  it("standalone receiving-state deletion stays forbidden", async () => {
    const before = await facts();
    await expect(
      reader`delete from receiving_mailboxes where mailbox_id=${source.mailbox}`,
    ).rejects.toThrow();
    expect(await facts()).toEqual(before);
  });
  it("terminal whole-account deletion works with no live owner and old callbacks cannot recreate it", async () => {
    await reader`update receiving_coordinator set expires_at='-infinity'`;
    await publication.removeAccount(account, 1n, 1n, budget());
    expect(
      await reader`select * from mail_accounts where id=${account}`,
    ).toHaveLength(0);
    expect((await facts()).states).toBeNull();
    expect((await facts()).messages).toBeNull();
    await expect(
      publication.claim(authority, "move", command, budget()),
    ).rejects.toThrow();
    await expect(
      new ReceivingPersistence(executor).initialize(
        owner,
        source.mailbox,
        { complete: true, epoch: 7n, uidNext: 2n },
        budget(),
      ),
    ).rejects.toThrow();
  });
  for (const dependency of ["draft", "outgoing"] as const)
    it(`terminal preserves RESTRICT for retained ${dependency}`, async () => {
      if (dependency === "draft")
        await reader`insert into drafts(id,account_id,compose_mode) values(${randomUUID()},${account},'new')`;
      else await outgoing();
      const before = await facts();
      await expect(
        publication.removeAccount(account, 1n, 1n, budget()),
      ).rejects.toThrow();
      expect(await facts()).toEqual(before);
      expect(
        await reader`select id from mail_accounts where id=${account}`,
      ).toHaveLength(1);
    });
  it("terminal stale identity and bounded lock timeout leave the entire account intact", async () => {
    const before = await facts();
    await expect(
      publication.removeAccount(account, 2n, 1n, budget()),
    ).rejects.toThrow();
    const held = gate(),
      finish = gate();
    const blocker = reader.begin(async (tx) => {
      await tx`select 1 from mail_accounts where id=${account} for share`;
      held.release();
      await finish.promise;
    });
    await held.promise;
    try {
      await expect(
        publication.removeAccount(account, 1n, 1n, {
          ...budget(),
          lockTimeoutMs: 100,
        }),
      ).rejects.toThrow();
    } finally {
      finish.release();
      await blocker;
    }
    expect(await facts()).toEqual(before);
  });
  for (const capability of ["move", "append", "topology"] as const)
    it(`${capability}: expired before L rolls back all revisions and facts`, async () => {
      let statement;
      if (capability === "move") {
        const attempt = await publication.claim(
          authority,
          "move",
          command,
          budget(),
        );
        advance();
        statement = moveSql(attempt.id as string);
      } else if (capability === "append") {
        const id = await outgoing();
        const a = appendAuthority();
        const attempt = await publication.claim(a, "append", id, budget());
        authority = {
          ...authority,
          scopes: authority.scopes.map((s) =>
            s.mailbox === destination
              ? { ...s, state: { ...s.state, revision: s.state.revision + 1n } }
              : s,
          ),
        };
        statement = sql`select maildock_receiving_append_result(${owner.actor}::uuid,${owner.generation}::bigint,${account}::uuid,1,1,${encode(appendAuthority().scopes.map((s) => ({ mailbox: s.mailbox, path: s.path, state: s.state })))}::jsonb,${id}::uuid,${attempt.id as string}::uuid,${encode(appendEvidence())}::jsonb)`;
      } else {
        const snapshot = await publication.captureTopology(
          owner,
          account,
          budget(),
        );
        statement = sql`select maildock_receiving_topology_result(${owner.actor}::uuid,${owner.generation}::bigint,${account}::uuid,${encode(snapshot)}::jsonb,${encode(topology())}::jsonb)`;
      }
      const before = await facts();
      await expect(
        executor.transaction(async (db) => {
          await db.execute(statement);
          await db.execute(
            sql`update receiving_coordinator set expires_at='-infinity'`,
          );
        }, budget()),
      ).rejects.toThrow();
      expect(await facts()).toEqual(before);
    });
  for (const capability of ["move", "append", "topology", "terminal"] as const)
    it(`${capability}: post-L COMMIT keeps conflicting publication locks`, async () => {
      let statement;
      if (capability === "move") {
        const attempt = await publication.claim(
          authority,
          "move",
          command,
          budget(),
        );
        advance();
        statement = moveSql(attempt.id as string);
      } else if (capability === "append") {
        const id = await outgoing();
        const a = appendAuthority();
        const attempt = await publication.claim(a, "append", id, budget());
        authority = {
          ...authority,
          scopes: authority.scopes.map((s) =>
            s.mailbox === destination
              ? { ...s, state: { ...s.state, revision: s.state.revision + 1n } }
              : s,
          ),
        };
        statement = sql`select maildock_receiving_append_result(${owner.actor}::uuid,${owner.generation}::bigint,${account}::uuid,1,1,${encode(appendAuthority().scopes.map((s) => ({ mailbox: s.mailbox, path: s.path, state: s.state })))}::jsonb,${id}::uuid,${attempt.id as string}::uuid,${encode(appendEvidence())}::jsonb)`;
      } else if (capability === "topology") {
        const snapshot = await publication.captureTopology(
          owner,
          account,
          budget(),
        );
        statement = sql`select maildock_receiving_topology_result(${owner.actor}::uuid,${owner.generation}::bigint,${account}::uuid,${encode(snapshot)}::jsonb,${encode(topology())}::jsonb)`;
      } else statement = terminalSql();
      const holder = await reader.reserve();
      await holder`select pg_advisory_lock(917441)`;
      let pid = 0;
      const old = executor.transaction(async (db) => {
        await db.execute(statement);
        pid = Number(
          (await db.execute(sql`select fixture_bounded_arm() pid`))[0].pid,
        );
      }, budget());
      old.catch(() => undefined);
      try {
        const deadline = performance.now() + 2000;
        while (!(
          pid &&
          (
            await reader`select 1 from pg_stat_activity where pid=${pid} and wait_event='advisory'`
          )[0]
        )) {
          if (performance.now() > deadline)
            throw Error("Missing post-L barrier");
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        await expect(
          reader.begin(async (tx) => {
            await tx`set local lock_timeout='100ms'`;
            await tx`update receiving_coordinator set expires_at='-infinity'`;
          }),
        ).rejects.toThrow();
      } finally {
        await holder`select pg_advisory_unlock(917441)`;
        holder.release();
      }
      await old;
    });
});
