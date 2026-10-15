import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { PgBoss } from "pg-boss";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createDatabase } from "@/shared/infrastructure/database/database";
import { AccountsService } from "@/modules/accounts/application/accounts-service";
import { AesGcmSecretEncryption } from "@/shared/infrastructure/crypto/aes-gcm-secret-encryption";
import { ReceivingExecutor } from "@/shared/infrastructure/database/receiving-executor";
import { ReceivingPersistence } from "@/modules/mail/application/receiving-persistence";
import { registerAccountRemovalWorker } from "@/modules/accounts/infrastructure/account-removal-jobs";
import {
  recoverReceiving,
  type ReceivingOwner,
} from "@/shared/infrastructure/database/receiving-authority";
import type { CreateAccountInput } from "@/modules/accounts/domain/account";
import type { RemoteMessageMetadata } from "@/modules/accounts/domain/mail-provider";

const bridge = vi.hoisted(() => ({ service: null as unknown }));
vi.mock("@/modules/accounts/infrastructure/accounts", () => ({
  get accountsService() {
    return bridge.service;
  },
}));
vi.mock("@/modules/auth/application/api-access", () => ({
  requireOwnerApiAccess: async () => null,
}));
import { DELETE, GET, PUT } from "@/app/api/accounts/[id]/route";
import { PATCH } from "@/app/api/accounts/[id]/enabled/route";
import { POST } from "@/app/api/accounts/route";

let container: StartedTestContainer;
let database: ReturnType<typeof createDatabase>;
let reader: postgres.Sql;
let accounts: AccountsService;
let executor: ReceivingExecutor;
let persistence: ReceivingPersistence;
let owner: ReceivingOwner;
let url: string;
const budget = () => ({ deadline: performance.now() + 2000 });
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const request = (id: string, method: string, body?: unknown) =>
  new Request(`http://localhost/api/accounts/${id}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
const input = (): CreateAccountInput => ({
  id: randomUUID(),
  displayName: "Lifecycle",
  email: "owner@example.test",
  enabled: true,
  providerType: "imap_smtp",
  imap: {
    host: "imap.example.test",
    port: 993,
    security: "tls",
    username: "owner",
    password: "private-password",
  },
  smtp: {
    host: "smtp.example.test",
    port: 465,
    security: "tls",
    useImapCredentials: true,
  },
});
const row = async (id: string) =>
  (await reader`select * from mail_accounts where id=${id}`)[0];
async function create() {
  const data = input();
  const response = await POST(request(data.id, "POST", data));
  expect(response.status).toBe(201);
  return data;
}
async function edit(data: CreateAccountInput) {
  const result = await PUT(request(data.id, "PUT", data), context(data.id));
  expect(result.status, await result.clone().text()).toBe(200);
}
async function toggle(id: string, enabled: boolean) {
  return PATCH(request(id, "PATCH", { enabled }), context(id));
}
async function enroll(data: CreateAccountInput) {
  const mailbox = randomUUID();
  const a = await row(data.id);
  await persistence.bootstrap(
    owner,
    mailbox,
    {
      account: data.id,
      configuration: BigInt(a.configuration_version),
      lifecycle: BigInt(a.receiving_lifecycle_version),
    },
    { complete: true, epoch: 7n, uidNext: 1n },
    budget(),
  );
  return mailbox;
}
function metadata(uid: number): RemoteMessageMetadata {
  return {
    uid: String(uid),
    internalDate: "2026-01-01T00:00:00Z",
    size: "12",
    flags: [],
    hasAttachments: false,
    envelope: {
      messageId: `<r08-${randomUUID()}@example.test>`,
      subject: "Retained mail",
      from: [],
      sender: [],
      replyTo: [],
      to: [],
      cc: [],
      bcc: [],
    },
  };
}
async function publish(data: CreateAccountInput, mailbox: string, count = 1) {
  const a = await row(data.id);
  let state = await recoverReceiving(executor, owner, mailbox, budget());
  for (let low = Number(state.freshThrough) + 1; low <= count; low += 32) {
    const high = Math.min(low + 31, count);
    const uids = Array.from({ length: high - low + 1 }, (_, i) =>
      BigInt(low + i),
    );
    state = await persistence.persist(
      owner,
      mailbox,
      state,
      {
        kind: "fresh",
        evidence: {
          complete: true,
          epoch: 7n,
          low: BigInt(low),
          high: BigInt(high),
          searched: uids,
          confirmedAbsent: [],
        },
        metadata: uids.map((uid) => metadata(Number(uid))),
      },
      budget(),
      {
        account: data.id,
        configuration: BigInt(a.configuration_version),
        lifecycle: BigInt(a.receiving_lifecycle_version),
      },
    );
  }
  return state;
}
beforeAll(async () => {
  container = await new GenericContainer("postgres:17.6-alpine")
    .withEnvironment({
      POSTGRES_USER: "fixture",
      POSTGRES_PASSWORD: "fixture",
      POSTGRES_DB: "fixture",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(
      Wait.forLogMessage(/database system is ready to accept connections/, 2),
    )
    .start();
  const root = postgres(
    `postgres://fixture:fixture@${container.getHost()}:${container.getMappedPort(5432)}/fixture`,
  );
  await root`create role lane login password 'fixture'`;
  await root`create database lifecycle owner lane`;
  await root.end();
  url = `postgres://lane:fixture@${container.getHost()}:${container.getMappedPort(5432)}/lifecycle`;
  database = createDatabase({ databaseUrl: url, databasePoolSize: 3 });
  reader = postgres(url, { max: 3 });
  await migrate(database.db, { migrationsFolder: "db/migrations" });
  await reader.unsafe(`create table fixture_cleanup_audit(tx bigint, relation text);
    create function fixture_cleanup_audit() returns trigger language plpgsql as $$ begin
      if nullif(current_setting('maildock.account_cleanup_scope',true),'') is not null then
        insert into fixture_cleanup_audit values(txid_current(),TG_TABLE_NAME);
        if current_setting('fixture.cleanup_expire',true)='true' then
          perform set_config('maildock.account_cleanup_scope',jsonb_set(current_setting('maildock.account_cleanup_scope')::jsonb,'{deadline}','"-infinity"')::text,true);
        end if;
      end if; return null; end $$;
    do $$ declare relation text; begin foreach relation in array array['messages','mailboxes','receiving_mailboxes','mailbox_messages','message_contents','message_attachments','message_commands','conversations','conversation_members','conversation_references','notification_events'] loop
      execute format('create trigger zzz_fixture_cleanup_audit after delete on %I for each row execute function fixture_cleanup_audit()',relation);
    end loop; end $$;`);
  const encryption = new AesGcmSecretEncryption("v1", {
    v1: Buffer.alloc(32, 9).toString("base64"),
  });
  accounts = new AccountsService(database.db, encryption, {
    testConnection: vi.fn(),
    listMailboxes: vi.fn(),
    synchronizeRecentMailbox: vi.fn(),
    fetchMessageContent: vi.fn(),
  });
  bridge.service = accounts;
  executor = new ReceivingExecutor(url, 2);
  persistence = new ReceivingPersistence(executor);
  const actor = randomUUID();
  const [lease] =
    await reader`select maildock_receiving_acquire(${actor}::uuid,60000) as generation`;
  owner = { actor, generation: BigInt(lease.generation) };
});
afterAll(async () => {
  await executor?.stop();
  await database?.client.end();
  await reader?.end();
  await container?.stop();
});

it("actual account PUT advances IMAP identity and preserves durable synchronization demand", async () => {
  const data = await create();
  const before = await row(data.id);
  data.imap.host = "replacement.example.test";
  await edit(data);
  expect((await row(data.id)).configuration_version).toBe("2");
  expect(BigInt((await row(data.id)).receiving_request_generation)).toBe(
    BigInt(before.receiving_request_generation) + 1n,
  );
});
it("display, sender, email and SMTP-only edits plus resubmitted unchanged password preserve IMAP identity", async () => {
  const data = await create();
  data.displayName = "Renamed";
  data.email = "sender@example.test";
  data.smtp.host = "new-smtp.example.test";
  await edit(data);
  expect((await row(data.id)).configuration_version).toBe("1");
});
it("password replacement advances identity once", async () => {
  const data = await create();
  data.imap.password = "replacement-password";
  await edit(data);
  expect((await row(data.id)).configuration_version).toBe("2");
});
it("routine OAuth cache rotation and status errors preserve configuration; explicit grant replacement advances it", async () => {
  const data = await create();
  await reader`update mail_accounts set auth_method='oauth2',oauth_provider_id='google',imap_password=null,oauth_cache='{}',oauth_status='connected' where id=${data.id}`;
  const before = await row(data.id);
  await reader`update mail_accounts set oauth_cache='{"cache":"rotated"}',oauth_status='reconnect_required' where id=${data.id}`;
  expect((await row(data.id)).configuration_version).toBe(
    before.configuration_version,
  );
  await reader`update mail_accounts set oauth_status='connected',configuration_version=configuration_version+1 where id=${data.id}`;
  expect(BigInt((await row(data.id)).configuration_version)).toBe(
    BigInt(before.configuration_version) + 1n,
  );
});
it("disable blocks IMAP work and re-enable rejects captured ABA lifecycle while retaining demand", async () => {
  const data = await create();
  const mailbox = await enroll(data);
  const before = await row(data.id);
  expect((await toggle(data.id, false)).status).toBe(200);
  await expect(accounts.getProviderImapAccountForWork(data.id)).rejects.toThrow(
    "Disabled",
  );
  await expect(accounts.testExisting(data.id)).rejects.toThrow("Disabled");
  await expect(
    reader`select maildock_receiving_account_identity(${data.id}::uuid,1,1)`,
  ).rejects.toThrow();
  expect((await toggle(data.id, true)).status).toBe(200);
  await expect(
    reader`select maildock_receiving_account_identity(${data.id}::uuid,1,1)`,
  ).rejects.toThrow();
  const after = await row(data.id);
  expect(BigInt(after.receiving_lifecycle_version)).toBe(
    BigInt(before.receiving_lifecycle_version) + 2n,
  );
  expect(after.configuration_version).toBe("1");
  await publish(data, mailbox);
});
it("same epoch and UID after reconnect cannot expose retained old placements or cache", async () => {
  const data = await create();
  const mailbox = await enroll(data);
  const state = await publish(data, mailbox);
  await reader`update mail_accounts set configuration_version=configuration_version+1 where id=${data.id}`;
  expect(
    (
      await reader`select count(*) from mailbox_messages where mailbox_id=${mailbox}`
    )[0].count,
  ).toBe("1");
  expect(
    (
      await reader`select count(*) from receiving_current_placements where mailbox_id=${mailbox}`
    )[0].count,
  ).toBe("0");
  await expect(
    persistence.persist(
      owner,
      mailbox,
      state,
      { kind: "epoch", complete: true, epoch: 8n, uidNext: 1n },
      budget(),
      { account: data.id, configuration: 1n, lifecycle: 1n },
    ),
  ).rejects.toThrow();
  await persistence.persist(
    owner,
    mailbox,
    state,
    { kind: "epoch", complete: true, epoch: 7n, uidNext: 1n, rebind: true },
    budget(),
    { account: data.id, configuration: 2n, lifecycle: 1n },
  );
  await publish(data, mailbox);
  const placements =
    await reader`select configuration_binding from mailbox_messages where mailbox_id=${mailbox} order by configuration_binding`;
  expect(placements.map((p) => p.configuration_binding)).toEqual(["1", "2"]);
  expect(
    (
      await reader`select count(*) from receiving_current_placements where mailbox_id=${mailbox}`
    )[0].count,
  ).toBe("1");
});
it("ordinary state deletion still fails and enrolled small deletion uses R04 terminal authority", async () => {
  const data = await create();
  const mailbox = await enroll(data);
  await publish(data, mailbox);
  await expect(
    reader`delete from receiving_mailboxes where mailbox_id=${mailbox}`,
  ).rejects.toThrow();
  expect(
    (await DELETE(request(data.id, "DELETE"), context(data.id))).status,
  ).toBe(204);
  expect(await row(data.id)).toBeUndefined();
  expect(
    (
      await reader`select count(*) from receiving_mailboxes where mailbox_id=${mailbox}`
    )[0].count,
  ).toBe("0");
  expect(await accounts.cleanupRemoval(data.id)).toBe(-1);
  await expect(
    persistence.bootstrap(
      owner,
      mailbox,
      { account: data.id, configuration: 1n, lifecycle: 1n },
      { complete: true, epoch: 7n, uidNext: 1n },
      budget(),
    ),
  ).rejects.toThrow();
});
it("R04 negative control rejects a realistic >4096-row enrolled account; bounded cleanup resumes after restart", async () => {
  const data = await create();
  const mailbox = await enroll(data);
  await publish(data, mailbox, 1100);
  expect(
    (await reader`select count(*) from messages where account_id=${data.id}`)[0]
      .count,
  ).toBe("1100");
  const [facts] = await reader`select
    (select count(*) from messages where account_id=${data.id})+
    (select count(*) from mailbox_messages where mailbox_id=${mailbox})+
    (select count(*) from conversations where account_id=${data.id})+
    (select count(*) from conversation_members where account_id=${data.id}) as amount`;
  expect(Number(facts.amount)).toBeGreaterThan(4096);
  await expect(
    reader`select maildock_receiving_terminal_remove(${data.id}::uuid,1,1)`,
  ).rejects.toThrow("bound");
  const response = await DELETE(request(data.id, "DELETE"), context(data.id));
  expect(response.status, await response.clone().text()).toBe(202);
  expect(
    (await (await GET(request(data.id, "GET"), context(data.id))).json())
      .account.removalStatus,
  ).toBe("removing");
  expect((await toggle(data.id, true)).status).toBe(409);
  await expect(
    reader`update mail_accounts set removal_requested_at=null,enabled=true where id=${data.id}`,
  ).rejects.toThrow();
  const first = await accounts.cleanupRemoval(data.id);
  expect(first).toBeGreaterThan(0);
  expect(first).toBeLessThanOrEqual(32);
  // A new application/database client simulates restart: only existing rows carry progress.
  const restarted = createDatabase({ databaseUrl: url, databasePoolSize: 1 });
  let turns = 0;
  try {
    for (;;) {
      const [r] = await restarted.db.execute(
        sql`select maildock_account_remove_batch(${data.id}::uuid) as affected`,
      );
      if (Number(r.affected) < 0) break;
      expect(Number(r.affected)).toBeGreaterThan(0);
      expect(Number(r.affected)).toBeLessThanOrEqual(32);
      expect(++turns).toBeLessThan(300);
    }
  } finally {
    await restarted.client.end();
  }
  expect(turns).toBeGreaterThan(30);
  expect(
    Number(
      (
        await reader`select max(amount) from (select count(*) amount from fixture_cleanup_audit group by tx) b`
      )[0].max,
    ),
  ).toBeLessThanOrEqual(32);
  expect(await row(data.id)).toBeUndefined();
  expect(
    (await reader`select count(*) from messages where account_id=${data.id}`)[0]
      .count,
  ).toBe("0");
}, 60000);
it("draft RESTRICT conflicts are explicit and leave account enabled", async () => {
  const data = await create();
  await reader`insert into drafts(id,account_id,compose_mode,subject,plain_text) values (${randomUUID()},${data.id},'new','User draft','Keep me')`;
  const response = await DELETE(request(data.id, "DELETE"), context(data.id));
  expect(response.status).toBe(409);
  expect(await response.text()).toContain("drafts");
  expect((await row(data.id)).enabled).toBe(true);
});
it("independent account credentials and SMTP stay usable after another account removal", async () => {
  const removed = await create();
  const retained = await create();
  expect(
    (await DELETE(request(removed.id, "DELETE"), context(removed.id))).status,
  ).toBe(204);
  expect(
    (await accounts.getProviderSmtpAccountForWork(retained.id)).accountId,
  ).toBe(retained.id);
});

async function manyFolders() {
  const data = await create();
  await reader`insert into mailboxes(id,account_id,name,remote_path,selectable,first_discovered_at,last_discovered_at)
    select gen_random_uuid(),${data.id},'Folder '||i,'Folder '||i,true,now(),now() from generate_series(1,129) i`;
  return data;
}
it("actual pg-boss startup repair resumes terminal cleanup after worker restart without a new DELETE", async () => {
  const data = await manyFolders();
  await accounts.delete(data.id);
  const count = async () =>
    Number(
      (
        await reader`select count(*) from mailboxes where account_id=${data.id}`
      )[0].count,
    );
  async function progress(before: number) {
    const boss = new PgBoss({
      connectionString: url,
      application_name: "r08-cleanup-fixture",
    });
    boss.on("error", () => {});
    try {
      await boss.start();
      await registerAccountRemovalWorker(boss, accounts);
      const deadline = performance.now() + 10000;
      while ((await count()) >= before) {
        if (performance.now() >= deadline)
          throw Error("Startup repair did not make progress");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      await boss.stop({ graceful: true, timeout: 10000 });
    }
    return count();
  }
  const interrupted = await progress(129);
  expect(interrupted).toBeGreaterThan(0);
  expect(await progress(interrupted)).toBeLessThan(interrupted);
  expect((await row(data.id)).removal_requested_at).not.toBeNull();
});
it("more than 128 folders are removed through bounded complete-folder progress", async () => {
  const data = await manyFolders();
  expect(
    (await DELETE(request(data.id, "DELETE"), context(data.id))).status,
  ).toBe(202);
  for (let i = 0; i < 129; i++)
    expect(await accounts.cleanupRemoval(data.id)).toBe(1);
  expect(await accounts.cleanupRemoval(data.id)).toBe(-1);
  expect(await row(data.id)).toBeUndefined();
});
it("expired cleanup COMMIT rolls back its folder deletion and retains recoverable in-progress state", async () => {
  const data = await manyFolders();
  await accounts.delete(data.id);
  await expect(
    reader.begin(async (tx) => {
      await tx`select set_config('fixture.cleanup_expire','true',true)`;
      await tx`select maildock_account_remove_batch(${data.id}::uuid)`;
    }),
  ).rejects.toThrow("COMMIT fenced");
  expect((await row(data.id)).removal_requested_at).not.toBeNull();
  expect(
    (
      await reader`select count(*) from mailboxes where account_id=${data.id}`
    )[0].count,
  ).toBe("129");
  expect(await accounts.cleanupRemoval(data.id)).toBe(1);
});
it("cleanup refuses mixed transactions and cannot delete another account's state", async () => {
  const data = await manyFolders();
  await accounts.delete(data.id);
  const other = await create();
  const mailbox = await enroll(other);
  await expect(
    reader.begin(async (tx) => {
      await tx`select maildock_account_remove_batch(${data.id}::uuid)`;
      await tx`delete from receiving_mailboxes where mailbox_id=${mailbox}`;
    }),
  ).rejects.toThrow("exact write fenced");
  await expect(
    reader.begin(async (tx) => {
      await tx`select maildock_account_remove_batch(${data.id}::uuid)`;
      await tx`select maildock_account_remove_batch(${data.id}::uuid)`;
    }),
  ).rejects.toThrow("Mixed cleanup");
  expect(
    (
      await reader`select count(*) from receiving_mailboxes where mailbox_id=${mailbox}`
    )[0].count,
  ).toBe("1");
});
it("terminal state rejects stale publications, bootstrap, pending work and new user dependencies", async () => {
  const data = await manyFolders();
  const mailbox = await enroll(data);
  const state = await publish(data, mailbox);
  const before = await row(data.id);
  await accounts.delete(data.id);
  await expect(
    persistence.persist(
      owner,
      mailbox,
      state,
      { kind: "epoch", complete: true, epoch: 8n, uidNext: 1n },
      budget(),
      {
        account: data.id,
        configuration: 1n,
        lifecycle: BigInt(before.receiving_lifecycle_version),
      },
    ),
  ).rejects.toThrow();
  await expect(
    reader`insert into drafts(id,account_id,compose_mode) values (${randomUUID()},${data.id},'new')`,
  ).rejects.toThrow("terminal");
  await expect(
    reader`insert into mailboxes(id,account_id,name,remote_path,selectable,first_discovered_at,last_discovered_at) values (${randomUUID()},${data.id},'Late','Late',true,now(),now())`,
  ).rejects.toThrow("terminal");
  await expect(
    reader`select * from maildock_receiving_request(${data.id}::uuid,${mailbox}::uuid)`,
  ).resolves.toMatchObject([{ accepted: false }]);
});
it("pending command and content intents remain durable across disable, enable and configuration changes", async () => {
  const data = await create();
  const mailbox = await enroll(data);
  await publish(data, mailbox);
  const [p] =
    await reader`select * from mailbox_messages where mailbox_id=${mailbox}`;
  const command = randomUUID();
  await reader`insert into message_commands(id,account_id,mailbox_id,placement_id,message_id,action,source_path,source_uid_validity,source_uid,source_configuration_binding)
    values(${command},${data.id},${mailbox},${p.id},${p.message_id},'mark_read','INBOX',7,1,1)`;
  await reader`select maildock_receiving_content_request(${data.id}::uuid,${mailbox}::uuid,${p.message_id}::uuid)`;
  expect((await toggle(data.id, false)).status).toBe(200);
  expect((await toggle(data.id, true)).status).toBe(200);
  data.imap.host = "replacement.example.test";
  await edit(data);
  expect(
    (await reader`select status from message_commands where id=${command}`)[0]
      .status,
  ).toBe("pending");
  expect(
    (
      await reader`select status,source_configuration_binding from message_contents where message_id=${p.message_id}`
    )[0],
  ).toMatchObject({ status: "pending", source_configuration_binding: "1" });
});
it("outgoing RESTRICT conflicts preserve sent and queued user content", async () => {
  const data = await create();
  await reader`insert into outgoing_messages(id,account_id,"from","to",cc,bcc,subject,plain_text,message_id,mime_base64)
    values(${randomUUID()},${data.id},'{}','[{}]','[]','[]','User mail','Keep me',${`<${randomUUID()}@example.test>`},'Zml4dHVyZQ==')`;
  expect(
    (await DELETE(request(data.id, "DELETE"), context(data.id))).status,
  ).toBe(409);
  expect((await row(data.id)).enabled).toBe(true);
});
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
it("account lock timeout returns retryable failure without marking deletion completed", async () => {
  const data = await create();
  const held = gate(),
    release = gate();
  const lock = reader.begin(async (tx) => {
    await tx`select id from mail_accounts where id=${data.id} for update`;
    held.resolve();
    await release.promise;
  });
  await held.promise;
  try {
    expect(
      (await DELETE(request(data.id, "DELETE"), context(data.id))).status,
    ).toBe(503);
    expect((await row(data.id)).removal_requested_at).toBeNull();
  } finally {
    release.resolve();
    await lock;
  }
});
it("publication holding account SHARE commits before concurrent terminal deletion", async () => {
  const data = await create();
  const mailbox = await enroll(data);
  const state = await recoverReceiving(executor, owner, mailbox, budget());
  const held = gate(),
    release = gate();
  const guarded = new ReceivingPersistence({
    transaction: (work, options) =>
      executor.transaction(async (db) => {
        const result = await work(db);
        held.resolve();
        await release.promise;
        return result;
      }, options),
  });
  const publication = guarded.persist(
    owner,
    mailbox,
    state,
    {
      kind: "fresh",
      evidence: {
        complete: true,
        epoch: 7n,
        low: 1n,
        high: 1n,
        searched: [1n],
        confirmedAbsent: [],
      },
      metadata: [metadata(1)],
    },
    budget(),
    { account: data.id, configuration: 1n, lifecycle: 1n },
  );
  await held.promise;
  const deletion = DELETE(request(data.id, "DELETE"), context(data.id));
  // Observe the real conflicting PostgreSQL lock before releasing the valid publication.
  try {
    const deadline = performance.now() + 800;
    for (;;) {
      const [wait] =
        await reader`select exists(select from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%maildock_account_remove_start%') as blocked`;
      if (wait.blocked) break;
      if (performance.now() >= deadline)
        throw Error("Deletion did not wait behind publication");
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  } finally {
    release.resolve();
  }
  await publication;
  expect((await deletion).status).toBe(204);
  expect(await row(data.id)).toBeUndefined();
});

it("bounded remote-cache cleanup preserves blob registry and independent local attachment snapshots", async () => {
  const data = await manyFolders();
  const message = randomUUID(),
    blob = randomUUID(),
    attachment = randomUUID();
  await reader`insert into blobs(id,storage_key,size,sha256) values (${blob},${randomUUID()},12,${"a".repeat(64)})`;
  await reader`insert into messages(id,account_id,internal_date,size) values (${message},${data.id},now(),12)`;
  await reader`insert into message_attachments(id,message_id,source_uid_validity,source_uid,part_id,content_type,inline,visible,blob_id,status)
    values (${attachment},${message},7,1,'1','application/pdf',false,true,${blob},'ready')`;
  const staged = randomUUID();
  await reader`insert into staged_attachments(id,blob_id,filename,content_type,expires_at) values (${staged},${blob},'local.pdf','application/pdf',now()+interval '1 day')`;
  expect((await accounts.delete(data.id)).status).toBe("removing");
  // Attachment is the first nonempty cleanup leaf; no physical blob deletion is called.
  expect(await accounts.cleanupRemoval(data.id)).toBe(1);
  expect(
    (
      await reader`select count(*) from message_attachments where id=${attachment}`
    )[0].count,
  ).toBe("0");
  expect(
    (await reader`select count(*) from blobs where id=${blob}`)[0].count,
  ).toBe("1");
  expect(
    (await reader`select blob_id from staged_attachments where id=${staged}`)[0]
      .blob_id,
  ).toBe(blob);
});
