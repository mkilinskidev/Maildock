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
  mailboxMessages,
} from "@/shared/infrastructure/database/schema";
import { ReceivingExecutor } from "@/shared/infrastructure/database/receiving-executor";
import type { ReceivingOwner } from "@/shared/infrastructure/database/receiving-authority";
import { ReceivingPersistence } from "@/modules/mail/application/receiving-persistence";
import {
  ReceivingPublication,
  type PublicationSource,
} from "@/modules/mail/application/receiving-publication";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalBlobStorage } from "@/shared/infrastructure/storage/local-blob-storage";
import type { CompletedRead } from "@/modules/mail/application/receiving-publication";
import { AttachmentService } from "@/modules/mail/application/attachment-service";
import { DEFAULT_ATTACHMENT_LIMITS } from "@/shared/application/attachment-limits";

const budget = () => ({ deadline: performance.now() + 5000 });
describe("R04-B fenced cache publication", () => {
  let container: StartedTestContainer;
  let database: ReturnType<typeof createDatabase>;
  let reader: postgres.Sql;
  let executor: ReceivingExecutor;
  let publication: ReceivingPublication;
  let owner: ReceivingOwner;
  let source: PublicationSource;
  let account: string, message: string, command: string, attachment: string;
  let url: string;
  let storageRoot: string;
  let storage: LocalBlobStorage;
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
    await root`create database receiving_cache owner lane`;
    await root.end();
    url = `postgres://lane:lane-fixture-only@${container.getHost()}:${container.getMappedPort(5432)}/receiving_cache`;
    database = createDatabase({ databaseUrl: url, databasePoolSize: 2 });
    reader = postgres(url, { max: 3 });
    await migrate(database.db, { migrationsFolder: "db/migrations" });
    await reader.unsafe(`CREATE FUNCTION fixture_cache_hold() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF current_setting('fixture.cache_hold',true)='true' THEN PERFORM pg_advisory_xact_lock(917440); END IF; RETURN NULL; END $$;
      CREATE CONSTRAINT TRIGGER zzz_fixture_cache_after_l AFTER UPDATE ON receiving_mailboxes DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION fixture_cache_hold();
      CREATE FUNCTION fixture_cache_arm() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN
      PERFORM set_config('fixture.cache_hold','true',true); RETURN pg_backend_pid(); END $$;`);
    executor = new ReceivingExecutor(url, 2);
    storageRoot = await mkdtemp(path.join(tmpdir(), "maildock-r04-b-"));
    storage = new LocalBlobStorage(storageRoot);
    publication = new ReceivingPublication(executor, storage);
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
    const [placement] =
      await reader`select * from mailbox_messages where mailbox_id=${mailbox}`;
    message = placement.message_id;
    command = randomUUID();
    await reader`insert into message_commands(id,account_id,mailbox_id,placement_id,message_id,action,source_path,source_uid_validity,source_uid,source_configuration_binding)
      values(${command},${account},${mailbox},${placement.id},${message},'mark_read','INBOX',7,1,1)`;
    await reader`select maildock_receiving_content_request(${account}::uuid,${mailbox}::uuid,${message}::uuid)`;
    const [descriptor] =
      await reader`select id from message_attachments where message_id=${message}`;
    attachment = descriptor.id;
    await reader`select maildock_receiving_attachment_request(${account}::uuid,${attachment}::uuid)`;
  });
  afterAll(async () => {
    await executor?.stop();
    await reader?.end({ timeout: 0 });
    await database?.client.end({ timeout: 0 });
    await container?.stop();
    if (storageRoot) {
      const target = path.resolve(storageRoot);
      if (
        !target.startsWith(path.resolve(tmpdir()) + path.sep) ||
        !path.basename(target).startsWith("maildock-r04-b-")
      )
        throw Error("Unsafe blob fixture cleanup path");
      await rm(target, { recursive: true, force: true });
    }
  });
  const next = () => ({
    ...source,
    state: { ...source.state, revision: source.state.revision + 1n },
  });
  async function facts() {
    const [row] = await reader`select to_jsonb(s) as state,
      (select jsonb_agg(to_jsonb(p) order by id) from mailbox_messages p where mailbox_id=${source.mailbox}) as placements,
      (select to_jsonb(m) from messages m where id=${message}) as message
      from receiving_mailboxes s where mailbox_id=${source.mailbox}`;
    return row;
  }

  const readEvidence = (part = "TEXT"): CompletedRead => ({
    complete: true,
    taggedOk: true,
    streamComplete: true,
    decoded: true,
    eof: true,
    method: "BODY.PEEK",
    origin: 0,
    encodedBytes: 10n,
    part,
    epoch: 7n,
    uid: 1n,
  });
  const content = () => ({
    ...readEvidence(),
    plainText: "complete body",
    html: "<p>Hello</p><script>alert(1)</script>",
    searchText: "complete body",
  });
  const completedContent = () =>
    JSON.stringify(
      {
        ...readEvidence(),
        plainText: "complete body",
        sanitizedHtml: "<p>Hello</p>",
        searchText: "complete body",
        sanitized: true,
        policyVersion: "email-html-v2",
        remoteContentBlocked: false,
      },
      (_, v) => (typeof v === "bigint" ? v.toString() : v),
    );
  const contentSql = (attempt: string) =>
    sql`select maildock_receiving_content_result(${owner.actor}::uuid,${owner.generation}::bigint,${source.mailbox}::uuid,${JSON.stringify(source.state, (_, v) => (typeof v === "bigint" ? v.toString() : v))}::jsonb,1,${message}::uuid,${attempt}::uuid,${completedContent()}::jsonb)`;
  function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => (release = resolve));
    return { release, promise };
  }
  it("late old failure cannot replace a newer ready result", async () => {
    const old = await publication.claim(
      owner,
      source,
      "content",
      message,
      budget(),
    );
    source = next();
    await publication.fail(
      owner,
      source,
      "content",
      message,
      old.id,
      "failed_remote_read",
      budget(),
    );
    source = next();
    await reader`select maildock_receiving_content_request(${account}::uuid,${source.mailbox}::uuid,${message}::uuid)`;
    const fresh = await publication.claim(
      owner,
      source,
      "content",
      message,
      budget(),
    );
    source = next();
    await publication.contentResult(
      owner,
      source,
      message,
      fresh.id,
      content(),
      budget(),
    );
    source = next();
    const ready = await facts();
    await expect(
      publication.fail(
        owner,
        source,
        "content",
        message,
        old.id,
        "failed_remote_read",
        budget(),
      ),
    ).rejects.toThrow();
    expect(await facts()).toEqual(ready);
    expect(
      (
        await reader`select status from message_contents where message_id=${message}`
      )[0].status,
    ).toBe("ready");
  });
  it("local draft uploads remain independent of remote attachment authority", async () => {
    const local = new AttachmentService(
      database.db,
      storage,
      DEFAULT_ATTACHMENT_LIMITS,
      async () => {},
    );
    const uploaded = await local.upload(
      (async function* () {
        yield Buffer.from("local");
      })(),
      "local.txt",
      "text/plain",
    );
    expect(uploaded.status).toBe("ready");
    const [row] =
      await reader`select blob_id from staged_attachments where id=${uploaded.id}`;
    expect(row.blob_id).toBeTruthy();
    await expect(
      reader`update message_attachments set status='ready',blob_id=${row.blob_id} where id=${attachment}`,
    ).rejects.toThrow();
  });
  it("cancellation during blob verification prevents registration and ready publication", async () => {
    const blob = await storage.put(
      (async function* () {
        yield Buffer.from("fixture");
      })(),
      100,
    );
    const attempt = await publication.claim(
      owner,
      source,
      "attachment",
      attachment,
      budget(),
    );
    source = next();
    const entered = gate(),
      finish = gate(),
      abort = new AbortController();
    const gated = new ReceivingPublication(executor, {
      put: storage.put.bind(storage),
      open: storage.open.bind(storage),
      delete: storage.delete.bind(storage),
      exists: async (key) => {
        entered.release();
        await finish.promise;
        return storage.exists(key);
      },
    });
    const pending = gated.attachmentResult(
      owner,
      source,
      attachment,
      attempt.id,
      { ...readEvidence("1"), blob },
      { ...budget(), signal: abort.signal },
    );
    pending.catch(() => undefined);
    await entered.promise;
    abort.abort();
    finish.release();
    await expect(pending).rejects.toThrow();
    expect(
      (
        await reader`select status from message_attachments where id=${attachment}`
      )[0].status,
    ).toBe("fetching");
    expect(
      await reader`select * from blobs where storage_key=${blob.key}`,
    ).toHaveLength(0);
  });
  it("cancelled late cache callback cannot touch the replacement publication", async () => {
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
    source = next();
    const attempt = await publication.claim(
      owner,
      source,
      "content",
      message,
      budget(),
    );
    source = next();
    const ready = gate(),
      resume = gate(),
      done = gate(),
      abort = new AbortController();
    let rejected = false;
    const old = executor
      .transaction(
        async (db) => {
          await db.execute(contentSql(attempt.id));
          const lateDelete = db
            .delete(mailboxMessages)
            .where(sql`mailbox_id=${source.mailbox}::uuid`)
            .prepare("cache_obsolete_delete");
          ready.release();
          await resume.promise;
          try {
            await lateDelete.execute();
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
      owner,
      source,
      "content",
      message,
      budget(),
    );
    expect(recovered.state.revision).toBe(3n);
    source = { ...source, state: recovered.state };
    await publication.contentResult(
      owner,
      source,
      message,
      attempt.id,
      content(),
      budget(),
    );
    const replacement = await facts();
    resume.release();
    await done.promise;
    expect(rejected).toBe(true);
    expect(await facts()).toEqual(replacement);
    expect(replacement.placements).toHaveLength(32);
  });
  it("content expires before L and rolls back payload, search and revision", async () => {
    const attempt = await publication.claim(
      owner,
      source,
      "content",
      message,
      budget(),
    );
    source = next();
    const before = await facts();
    await expect(
      executor.transaction(async (db) => {
        await db.execute(contentSql(attempt.id));
        await db.execute(
          sql`update receiving_coordinator set expires_at='-infinity'`,
        );
      }, budget()),
    ).rejects.toThrow();
    expect(await facts()).toEqual(before);
  });
  it("valid content L retains conflicting coordinator lock through COMMIT", async () => {
    const attempt = await publication.claim(
      owner,
      source,
      "content",
      message,
      budget(),
    );
    source = next();
    const holder = await reader.reserve();
    await holder`select pg_advisory_lock(917440)`;
    let pid = 0;
    const old = executor.transaction(async (db) => {
      await db.execute(contentSql(attempt.id));
      pid = Number(
        (await db.execute(sql`select fixture_cache_arm() pid`))[0].pid,
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
          throw Error("COMMIT did not reach post-L barrier");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await expect(
        reader.begin(async (tx) => {
          await tx`set local lock_timeout='100ms'`;
          await tx`update receiving_coordinator set expires_at='-infinity'`;
        }),
      ).rejects.toThrow();
    } finally {
      await holder`select pg_advisory_unlock(917440)`;
      holder.release();
    }
    await old;
    expect(
      (
        await reader`select status from message_contents where message_id=${message}`
      )[0].status,
    ).toBe("ready");
  });
  for (const timing of ["before", "after"] as const)
    it(`attachment ${timing} L validates registry, ready linkage and revision atomically`, async () => {
      const blob = await storage.put(
        (async function* () {
          yield Buffer.from("fixture");
        })(),
        100,
      );
      const attempt = await publication.claim(
        owner,
        source,
        "attachment",
        attachment,
        budget(),
      );
      source = next();
      const evidence = JSON.stringify(
        {
          ...readEvidence("1"),
          stored: true,
          storageKey: blob.key,
          size: blob.size,
          sha256: blob.sha256,
        },
        (_, v) => (typeof v === "bigint" ? v.toString() : v),
      );
      const statement = sql`select maildock_receiving_attachment_result(${owner.actor}::uuid,${owner.generation}::bigint,${source.mailbox}::uuid,${JSON.stringify(source.state, (_, v) => (typeof v === "bigint" ? v.toString() : v))}::jsonb,1,${attachment}::uuid,${attempt.id}::uuid,${evidence}::jsonb)`;
      if (timing === "before") {
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
        expect(
          await reader`select * from blobs where storage_key=${blob.key}`,
        ).toHaveLength(0);
        expect(
          (
            await reader`select status from message_attachments where id=${attachment}`
          )[0].status,
        ).toBe("fetching");
      } else {
        const holder = await reader.reserve();
        await holder`select pg_advisory_lock(917440)`;
        let pid = 0;
        const old = executor.transaction(async (db) => {
          await db.execute(statement);
          pid = Number(
            (await db.execute(sql`select fixture_cache_arm() pid`))[0].pid,
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
              throw Error("Attachment COMMIT did not reach post-L barrier");
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          await expect(
            reader.begin(async (tx) => {
              await tx`set local lock_timeout='100ms'`;
              await tx`update receiving_coordinator set expires_at='-infinity'`;
            }),
          ).rejects.toThrow();
        } finally {
          await holder`select pg_advisory_unlock(917440)`;
          holder.release();
        }
        await old;
        expect(
          (
            await reader`select status from message_attachments where id=${attachment}`
          )[0].status,
        ).toBe("ready");
        expect(
          await reader`select * from blobs where storage_key=${blob.key}`,
        ).toHaveLength(1);
      }
    });
  it("publishes sanitized content and only derived search, once, with unchanged F/E/R", async () => {
    // A second enrolled placement must not turn derived-only publication into metadata authority.
    const shared = randomUUID();
    await database.db.insert(mailboxes).values({
      id: shared,
      accountId: account,
      name: "Shared",
      remotePath: "Shared",
      selectable: true,
      firstDiscoveredAt: new Date(),
      lastDiscoveredAt: new Date(),
    });
    await new ReceivingPersistence(executor).initialize(
      owner,
      shared,
      { complete: true, epoch: 7n, uidNext: 2n },
      budget(),
    );
    await executor.transaction(async (db) => {
      await db.execute(
        sql`select maildock_receiving_claim(${owner.actor}::uuid,${owner.generation}::bigint,${shared}::uuid,7,0,1,2,0)`,
      );
      await db.execute(
        sql`insert into mailbox_messages(id,mailbox_id,message_id,uid_validity,uid,first_synchronized_at,last_synchronized_at) values(gen_random_uuid(),${shared}::uuid,${message}::uuid,7,1,clock_timestamp(),clock_timestamp())`,
      );
      await db.execute(
        sql`update receiving_mailboxes set revision=revision+1 where mailbox_id=${shared}::uuid`,
      );
    }, budget());
    const [sharedBefore] =
      await reader`select * from receiving_mailboxes where mailbox_id=${shared}`;
    const before = await facts();
    const [conversation] =
      await reader`select * from conversation_members where message_id=${message}`;
    const attempt = await publication.claim(
      owner,
      source,
      "content",
      message,
      budget(),
    );
    source = next();
    await publication.contentResult(
      owner,
      source,
      message,
      attempt.id,
      content(),
      budget(),
    );
    source = next();
    const after = await facts();
    expect(after.state).toEqual({ ...before.state, revision: 3 });
    expect(after.placements).toEqual(before.placements);
    expect(after.message).toEqual({
      ...before.message,
      search_body: "complete body",
      search_vector: after.message.search_vector,
    });
    const [cache] =
      await reader`select * from message_contents where message_id=${message}`;
    expect(cache.status).toBe("ready");
    expect(cache.sanitized_html).not.toContain("script");
    expect(cache.policy_version).toBe("email-html-v2");
    expect(
      (
        await reader`select * from conversation_members where message_id=${message}`
      )[0],
    ).toEqual(conversation);
    await expect(
      publication.fail(
        owner,
        source,
        "content",
        message,
        attempt.id,
        "failed_remote_read",
        budget(),
      ),
    ).rejects.toThrow();
    await expect(
      publication.contentResult(
        owner,
        source,
        message,
        attempt.id,
        content(),
        budget(),
      ),
    ).rejects.toThrow();
    expect((await facts()).state).toEqual(after.state);
    expect(
      (
        await reader`select * from receiving_mailboxes where mailbox_id=${shared}`
      )[0],
    ).toEqual(sharedBefore);
  });
  for (const invalid of [
    "complete",
    "taggedOk",
    "streamComplete",
    "decoded",
    "eof",
    "epoch",
    "uid",
    "origin",
    "part",
    "encodedBytes",
  ] as const) {
    it(`rejects incomplete/malformed content ${invalid} atomically`, async () => {
      const attempt = await publication.claim(
        owner,
        source,
        "content",
        message,
        budget(),
      );
      source = next();
      const before = await facts();
      const evidence = {
        ...content(),
        [invalid]: ["epoch", "uid", "origin"].includes(invalid)
          ? 9
          : invalid === "part"
            ? "1"
            : invalid === "encodedBytes"
              ? -1
              : false,
      };
      await expect(
        publication.contentResult(
          owner,
          source,
          message,
          attempt.id,
          evidence as ReturnType<typeof content>,
          budget(),
        ),
      ).rejects.toThrow();
      expect(await facts()).toEqual(before);
      expect(
        (
          await reader`select status from message_contents where message_id=${message}`
        )[0].status,
      ).toBe("fetching");
    });
  }
  for (const changed of [
    "epoch",
    "configuration",
    "lifecycle",
    "revision",
    "actor",
    "attempt",
  ] as const) {
    it(`rejects stale content ${changed}`, async () => {
      const attempt = await publication.claim(
        owner,
        source,
        "content",
        message,
        budget(),
      );
      source = next();
      if (changed === "configuration")
        await reader`update mail_accounts set imap_host='changed.test' where id=${account}`;
      if (changed === "lifecycle") {
        await reader`update mail_accounts set enabled=false where id=${account}`;
        await reader`update mail_accounts set enabled=true where id=${account}`;
      }
      const captured =
        changed === "epoch"
          ? { ...source, state: { ...source.state, epoch: 8n } }
          : changed === "revision"
            ? next()
            : source;
      await expect(
        publication.contentResult(
          changed === "actor" ? { ...owner, actor: randomUUID() } : owner,
          captured,
          message,
          changed === "attempt" ? randomUUID() : attempt.id,
          content(),
          budget(),
        ),
      ).rejects.toThrow();
      expect(
        (
          await reader`select status from message_contents where message_id=${message}`
        )[0].status,
      ).toBe("fetching");
    });
  }
  for (const mutation of [
    "subject",
    "mime_structure",
    "search_body",
    "updated_at",
    "account_id",
  ] as const) {
    it(`derived exception cannot authorize ${mutation} or mixed placement writes`, async () => {
      const attempt = await publication.claim(
        owner,
        source,
        "content",
        message,
        budget(),
      );
      source = next();
      const before = await facts();
      await expect(
        executor.transaction(async (db) => {
          await db.execute(
            sql`select maildock_receiving_content_result(${owner.actor}::uuid,${owner.generation}::bigint,${source.mailbox}::uuid,${JSON.stringify(source.state, (_, v) => (typeof v === "bigint" ? v.toString() : v))}::jsonb,1,${message}::uuid,${attempt.id}::uuid,${JSON.stringify({ ...content(), html: undefined, sanitizedHtml: "<p>Hello</p>", sanitized: true, policyVersion: "email-html-v2", remoteContentBlocked: false }, (_, v) => (typeof v === "bigint" ? v.toString() : v))}::jsonb)`,
          );
          const assignment =
            mutation === "subject"
              ? "subject='forged'"
              : mutation === "mime_structure"
                ? "mime_structure='{}'::jsonb"
                : mutation === "search_body"
                  ? "search_body='forged'"
                  : mutation === "updated_at"
                    ? "updated_at=clock_timestamp()"
                    : "account_id=gen_random_uuid()";
          await db.execute(
            sql.raw(`update messages set ${assignment} where id='${message}'`),
          );
        }, budget()),
      ).rejects.toThrow();
      expect(await facts()).toEqual(before);
    });
  }
  it("verified physical blob, registration, attachment and existing incoming references commit together", async () => {
    const draft = randomUUID();
    await reader`insert into drafts(id,account_id,compose_mode) values(${draft},${account},'new')`;
    await reader`insert into draft_attachments(draft_id,id,kind,filename,content_type,position) values(${draft},${attachment},'incoming','fixture.pdf','application/pdf',0)`;
    const blob = await storage.put(
      (async function* () {
        yield Buffer.from("fixture");
      })(),
      100,
    );
    const attempt = await publication.claim(
      owner,
      source,
      "attachment",
      attachment,
      budget(),
    );
    source = next();
    const before = await facts();
    await publication.attachmentResult(
      owner,
      source,
      attachment,
      attempt.id,
      { ...readEvidence("1"), blob },
      budget(),
    );
    const [result] =
      await reader`select a.status,b.size,b.sha256,b.storage_key from message_attachments a join blobs b on b.id=a.blob_id where a.id=${attachment}`;
    expect(result).toEqual({
      status: "ready",
      size: "7",
      sha256: blob.sha256,
      storage_key: blob.key,
    });
    expect((await facts()).state).toEqual({ ...before.state, revision: 3 });
    const [reference] =
      await reader`select d.blob_id from draft_attachments d join message_attachments a on a.id=d.id and a.blob_id=d.blob_id where d.draft_id=${draft}`;
    expect(reference.blob_id).toBeTruthy();
    source = next();
    await expect(
      publication.fail(
        owner,
        source,
        "attachment",
        attachment,
        attempt.id,
        "failed_remote_read",
        budget(),
      ),
    ).rejects.toThrow();
  });
  for (const problem of [
    "missing",
    "size",
    "digest",
    "part",
    "incomplete",
  ] as const) {
    it(`attachment rejects ${problem} with no ready row or blob registration`, async () => {
      const blob = await storage.put(
        (async function* () {
          yield Buffer.from("fixture");
        })(),
        100,
      );
      const attempt = await publication.claim(
        owner,
        source,
        "attachment",
        attachment,
        budget(),
      );
      source = next();
      if (problem === "missing") await storage.delete(blob.key);
      const evidence = {
        ...readEvidence(problem === "part" ? "2" : "1"),
        blob: {
          ...blob,
          size: problem === "size" ? 8 : 7,
          sha256: problem === "digest" ? "0".repeat(64) : blob.sha256,
        },
        complete: problem !== "incomplete",
      };
      const before = await facts();
      await expect(
        publication.attachmentResult(
          owner,
          source,
          attachment,
          attempt.id,
          evidence as Parameters<ReceivingPublication["attachmentResult"]>[4],
          budget(),
        ),
      ).rejects.toThrow();
      expect(await facts()).toEqual(before);
      expect(
        await reader`select * from blobs where storage_key=${blob.key}`,
      ).toHaveLength(0);
    });
  }
});
