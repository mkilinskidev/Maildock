import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import {
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  describe,
  it,
  expect,
} from "vitest";
import { createDatabase } from "@/shared/infrastructure/database/database";
import { mailAccounts } from "@/shared/infrastructure/database/schema";
import { ReceivingExecutor } from "@/shared/infrastructure/database/receiving-executor";
import { ElectedReceivingCoordinator } from "@/modules/mail/application/receiving-election";
import { receivingTopologyHandlers } from "@/modules/mail/application/receiving-topology";
import { MailboxRoleService } from "@/modules/mail/application/mailbox-role-service";
import { MailboxService } from "@/modules/mail/application/mailbox-service";
import { ReceivingDemand } from "@/modules/mail/application/receiving-demand";
import {
  metadataPeer,
  type WindowPeerOptions,
} from "./fixtures/imap-metadata-peer";

type Folder = {
  uids: number[];
  next: number;
  epoch?: number;
  flags?: string[];
  attributes?: string;
  selectable?: boolean;
};
async function until(predicate: () => Promise<boolean>, ms = 15_000) {
  const end = performance.now() + ms;
  while (!(await predicate())) {
    if (performance.now() >= end)
      throw Error("R17 independent database visibility deadline");
    await delay(10);
  }
}

describe("R17 selectable mailbox synchronization through the elected production selector", () => {
  let container: StartedTestContainer;
  let database: ReturnType<typeof createDatabase>;
  let reader: postgres.Sql;
  let url: string;
  let account: string;
  const cleanup: (() => Promise<unknown>)[] = [];
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
    await root`create database r17 owner lane`;
    await root.end();
    url = `postgres://lane:lane-fixture-only@${container.getHost()}:${container.getMappedPort(5432)}/r17`;
    database = createDatabase({ databaseUrl: url, databasePoolSize: 2 });
    reader = postgres(url, { max: 3 });
    await migrate(database.db, { migrationsFolder: "db/migrations" });
  });
  async function addAccount() {
    const id = randomUUID();
    await database.db.insert(mailAccounts).values({
      id,
      displayName: "R17 fixture",
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
    return id;
  }
  beforeEach(async () => {
    await reader`update receiving_coordinator set expires_at='-infinity'`;
    await reader`update mail_accounts set enabled=false`;
    account = await addAccount();
  });
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });
  afterAll(async () => {
    await reader?.end({ timeout: 0 });
    await database?.client.end({ timeout: 0 });
    await container?.stop();
  });

  async function peer(
    folders: Record<string, Folder>,
    namespace = false,
    taggedDelay = 0,
  ) {
    const uids: number[] = [];
    const options: WindowPeerOptions = {
      boundedMailbox: true,
      uids,
      uidNext: 1,
      taggedDelay,
      ...(namespace ? { capabilities: "IMAP4rev1 NAMESPACE" } : {}),
    };
    const wirePath = (path: string) =>
      path.replace(/&|[^\x20-\x7e]+/gu, (part) =>
        part === "&"
          ? "&-"
          : `&${Buffer.from(part, "utf16le").swap16().toString("base64").replace(/=+$/, "").replaceAll("/", ",")}-`,
      );
    const selected: string[] = [];
    const paths = new Map<number, string>();
    options.onCommand = (p, c) => {
      if (c.command === "NAMESPACE") {
        p.send('* NAMESPACE (("Personal/" "/")) NIL (("Shared/" "/"))\r\n', c);
        p.ok(c);
        return true;
      }
      if (c.command.startsWith('LIST "" "*"')) {
        for (const [path, f] of Object.entries(folders))
          p.send(
            `* LIST (${f.selectable === false ? "\\Noselect" : (f.attributes ?? "")}) "/" ${JSON.stringify(wirePath(path))}\r\n`,
            c,
          );
        p.ok(c);
        return true;
      }
      if (/^(SELECT|EXAMINE) /.test(c.command)) {
        const raw = c.command.slice(c.command.indexOf(" ") + 1);
        const encoded = raw.startsWith('"') ? JSON.parse(raw) : raw;
        const path =
          Object.keys(folders).find((key) => wirePath(key) === encoded) ??
          encoded;
        selected.push(path);
        paths.set(p.id, path);
        const f = folders[path];
        if (!f || f.selectable === false) {
          p.ok(c, "NO Mailbox absent");
          return true;
        }
        uids.splice(0, uids.length, ...f.uids);
        options.uidNext = f.next;
        options.epoch = f.epoch ?? 7;
        options.flags = f.flags ?? [];
      }
      if (c.command.startsWith("UID ")) {
        const f = folders[paths.get(p.id)!];
        if (!f) {
          p.ok(c, "NO Mailbox absent");
          return true;
        }
        uids.splice(0, uids.length, ...f.uids);
        options.uidNext = f.next;
        options.epoch = f.epoch ?? 7;
        options.flags = f.flags ?? [];
      }
    };
    const wire = await metadataPeer(options);
    cleanup.push(wire.cleanup);
    return { ...wire, selected };
  }
  type Wire = Awaited<ReturnType<typeof peer>>;
  async function start(wire: Wire, accounts = [account]) {
    const exec = new ReceivingExecutor(url, 2);
    cleanup.push(() => exec.stop());
    const errors: unknown[] = [];
    const admissions: { account: string; kind: string }[] = [];
    const owner = new ElectedReceivingCoordinator({
      executor: exec,
      leaseMs: 6000,
      tuning: { historyWaitMs: 100 },
      onControlError: (e) => {
        errors.push(e);
        console.error("R17 control failure", e);
      },
      operationHandlers: {
        ...receivingTopologyHandlers,
        list: { topology: "list", discover: true },
      },
      loadOperationConnection: async () => wire.connection,
      createOperationClient: wire.createClient,
      loadAccount: async (_db, c) => {
        if (!accounts.includes(c.account))
          throw Error("Unexpected enabled account");
        return {
          ...c,
          connection: wire.connection,
          createClient: wire.createClient,
          timing: { pollMs: 1000, retryMs: 100, maxRetryMs: 1000 },
          onError: (e) => {
            errors.push(e);
            console.error("R17 turn failure", e);
          },
        };
      },
      onAdmission: (a) => admissions.push({ account: a.account, kind: a.kind }),
    });
    cleanup.push(() => owner.stop());
    expect(await owner.elect()).toBe(true);
    await owner.dispatchTopology();
    await until(
      async () =>
        (await reader`select id from mailboxes where account_id=${account}`)
          .length > 0,
    );
    await owner.refreshMembership();
    return { owner, exec, errors, admissions };
  }
  async function complete(
    path: string,
    count: number,
    id = account,
    ms = 15_000,
  ) {
    await until(async () => {
      const [r] =
        await reader`select s.history_before,(select count(*) from receiving_current_placements p where p.mailbox_id=b.id)::integer as count
        from mailboxes b join receiving_mailboxes s on s.mailbox_id=b.id where b.account_id=${id} and b.remote_path=${path} and b.lifecycle_status='active'`;
      return r?.history_before === "1" && r.count === count;
    }, ms);
  }
  async function rediscover(owner: ElectedReceivingCoordinator) {
    await owner.submit({
      kind: "list",
      requestId: randomUUID(),
      identity: { account, configurationVersion: 1n },
      deadline: performance.now() + 10_000,
    });
    await owner.refreshMembership();
  }

  it("synchronizes all five roles, an unclassified custom folder and Gmail-like overlapping labels with independent UID/Message-ID placements", async () => {
    const folders: Record<string, Folder> = {
      INBOX: { uids: [1], next: 2 },
      Projects: { uids: [1], next: 2 },
      Container: { uids: [], next: 1, selectable: false },
    };
    for (const role of ["Sent", "Archive", "Trash", "Drafts", "Junk"])
      folders[role] = { uids: [1], next: 2, attributes: `\\${role}` };
    folders["[Gmail]/All Mail"] = { uids: [1], next: 2 };
    folders["[Gmail]/Important"] = { uids: [1], next: 2 };
    const wire = await peer(folders);
    const { errors } = await start(wire);
    for (const path of Object.keys(folders).filter((p) => p !== "Container"))
      await complete(path, 1);
    const rows =
      await reader`select p.message_id,m.rfc_message_id,p.uid from receiving_current_placements p join mailboxes b on b.id=p.mailbox_id join messages m on m.id=p.message_id where b.account_id=${account}`;
    expect(rows).toHaveLength(9);
    expect(new Set(rows.map((r) => r.message_id)).size).toBe(9);
    expect(new Set(rows.map((r) => r.rfc_message_id)).size).toBe(1);
    expect(wire.selected).not.toContain("Container");
    expect(errors).toEqual([]);
    const roles = await new MailboxRoleService(database.db).list(account);
    expect(roles.every((r) => r.available && r.source === "special_use")).toBe(
      true,
    );
    const view = await new MailboxService(database.db).listForAccount(account);
    expect(
      view.find((m) => m.remotePath === "Container")?.receiving,
    ).toBeUndefined();
    expect(
      view.find((m) => m.remotePath === "Projects")?.receiving,
    ).toMatchObject({ mode: "mailbox", historyComplete: true });
    expect(view.find((m) => m.remotePath === "Projects")?.unseenCount).toBe(
      "1",
    );
  });

  it("keeps manual Archive above SPECIAL-USE through LIST and elected restart without resetting coverage", async () => {
    const wire = await peer({
      INBOX: { uids: [], next: 1 },
      Archive: { uids: [1], next: 2, attributes: "\\Archive" },
      Przechowalnia: { uids: [1, 2], next: 3 },
    });
    const { owner } = await start(wire);
    await complete("Przechowalnia", 2);
    const [b] =
      await reader`select id from mailboxes where account_id=${account} and remote_path='Przechowalnia'`;
    const roles = new MailboxRoleService(database.db);
    const [before] =
      await reader`select * from receiving_mailboxes where mailbox_id=${b.id}`;
    await roles.setManual(account, "archive", b.id);
    await rediscover(owner);
    const [after] =
      await reader`select * from receiving_mailboxes where mailbox_id=${b.id}`;
    expect(after.epoch).toBe(before.epoch);
    expect(after.history_before).toBe(before.history_before);
    expect(
      (await roles.list(account)).find((r) => r.role === "archive"),
    ).toMatchObject({ mailboxId: b.id, source: "manual", available: true });
    await owner.stop();
    await start(wire);
    await complete("Przechowalnia", 2);
    expect(
      (await roles.list(account)).find((r) => r.role === "archive"),
    ).toMatchObject({ mailboxId: b.id, source: "manual", available: true });
  });

  it("synchronizes the exact Unicode shared path outside the personal namespace", async () => {
    const wire = await peer(
      { INBOX: { uids: [], next: 1 }, "Shared/Próby": { uids: [1], next: 2 } },
      true,
    );
    const { errors } = await start(wire);
    await complete("Shared/Próby", 1);
    expect(
      wire.commands.some(
        (c) =>
          c.command.includes("EXAMINE") &&
          c.command.includes("Shared/Pr&APM-by"),
      ),
    ).toBe(true);
    expect(
      wire.commands.some((c) => c.command.includes("Personal/Shared")),
    ).toBe(false);
    expect(errors).toEqual([]);
  });

  it("discovers quiet secondary arrival, flag change and disappearance without any wake or INBOX arrival", async () => {
    const folders = {
      INBOX: { uids: [], next: 1 },
      Custom: { uids: [1, 2], next: 3, flags: [] as string[] },
    };
    const wire = await peer(folders);
    const { errors } = await start(wire);
    await complete("Custom", 2);
    const started = performance.now();
    folders.Custom.flags = ["\\Seen"];
    folders.Custom.uids.splice(0, 1);
    folders.Custom.uids.push(3);
    folders.Custom.next = 4;
    await until(async () => {
      const rows =
        await reader`select p.uid,p.flags from receiving_current_placements p join mailboxes b on b.id=p.mailbox_id where b.account_id=${account} and b.remote_path='Custom' order by p.uid`;
      return (
        rows.length === 2 &&
        rows[0].uid === "2" &&
        rows[1].uid === "3" &&
        rows.every((r) => r.flags.includes("\\Seen"))
      );
    });
    console.info(
      "R17 quiet secondary visibility ms",
      performance.now() - started,
    );
    expect(errors).toEqual([]);
  });

  it("handles empty secondary mailboxes without creating messages or spinning revisions", async () => {
    const wire = await peer({
      INBOX: { uids: [], next: 1 },
      Empty: { uids: [], next: 1 },
    });
    const { errors } = await start(wire);
    await complete("Empty", 0);
    const [before] =
      await reader`select s.* from receiving_mailboxes s join mailboxes b on b.id=s.mailbox_id where b.account_id=${account} and b.remote_path='Empty'`;
    await delay(350);
    const [after] =
      await reader`select s.* from receiving_mailboxes s join mailboxes b on b.id=s.mailbox_id where b.account_id=${account} and b.remote_path='Empty'`;
    expect(after.revision).toBe(before.revision);
    expect(errors).toEqual([]);
  });

  it("replaces secondary UIDVALIDITY without exposing old placements or merging repeated UID/Message-ID", async () => {
    const folders = {
      INBOX: { uids: [], next: 1 },
      Custom: { uids: [1], next: 2, epoch: 7 },
    };
    const wire = await peer(folders);
    await start(wire);
    await complete("Custom", 1);
    const [old] =
      await reader`select p.* from receiving_current_placements p join mailboxes b on b.id=p.mailbox_id where b.account_id=${account} and b.remote_path='Custom'`;
    folders.Custom.epoch = 8;
    await until(
      async () =>
        (
          await reader`select p.message_id from receiving_current_placements p join mailboxes b on b.id=p.mailbox_id where b.account_id=${account} and b.remote_path='Custom' and p.uid_validity=8`
        ).length === 1,
    );
    const rows =
      await reader`select p.* from receiving_current_placements p join mailboxes b on b.id=p.mailbox_id where b.account_id=${account} and b.remote_path='Custom'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].message_id).not.toBe(old.message_id);
    expect(
      (await reader`select id from mailbox_messages where id=${old.id}`).length,
    ).toBe(1);
  });

  it("marks deleted/manual destinations unavailable, discovers new folders and gives a path-only rename a new identity", async () => {
    const folders: Record<string, Folder> = {
      INBOX: { uids: [], next: 1 },
      Old: { uids: [1], next: 2 },
    };
    const wire = await peer(folders);
    const { owner } = await start(wire);
    await complete("Old", 1);
    const [old] =
      await reader`select id from mailboxes where account_id=${account} and remote_path='Old'`;
    await new MailboxRoleService(database.db).setManual(
      account,
      "archive",
      old.id,
    );
    delete folders.Old;
    folders.New = { uids: [1], next: 2 };
    await rediscover(owner);
    await complete("New", 1);
    expect(
      (await new MailboxRoleService(database.db).list(account)).find(
        (r) => r.role === "archive",
      ),
    ).toMatchObject({ source: "manual", available: false, mailboxId: old.id });
    expect(
      await reader`select p.id from receiving_current_placements p where p.mailbox_id=${old.id}`,
    ).toHaveLength(0);
    folders.Old = { uids: [1], next: 2 };
    await rediscover(owner);
    await complete("Old", 1);
    const [recreated] =
      await reader`select id from mailboxes where account_id=${account} and remote_path='Old' and lifecycle_status='active'`;
    expect(recreated.id).not.toBe(old.id);
  });

  it("completes bounded secondary history across multiple large folders and accounts with no per-account socket overlap", async () => {
    const folders: Record<string, Folder> = { INBOX: { uids: [1], next: 2 } };
    for (const path of ["LargeA", "LargeB", "LargeC"])
      folders[path] = {
        uids: Array.from({ length: 260 }, (_, i) => i + 1),
        next: 261,
      };
    const second = await addAccount();
    const wire = await peer(folders);
    const { errors, owner } = await start(wire, [account, second]);
    await until(
      async () =>
        (await reader`select id from mailboxes where account_id=${second}`)
          .length === 4,
    );
    await owner.refreshMembership();
    for (const id of [account, second])
      for (const path of ["LargeA", "LargeB", "LargeC"])
        await complete(path, 260, id, 60_000);
    const searches = wire.commands.filter((c) =>
      c.command.startsWith("UID SEARCH"),
    );
    expect(searches.length).toBeGreaterThan(18);
    expect(searches.every((c) => !c.command.includes("*"))).toBe(true);
    expect(errors).toEqual([]);
  });

  it("keeps receiving INBOX arrivals while secondary history makes bounded progress", async () => {
    const folders = {
      INBOX: { uids: [1], next: 2 },
      Large: { uids: Array.from({ length: 260 }, (_, i) => i + 1), next: 261 },
    };
    const wire = await peer(folders);
    const { errors, owner, exec } = await start(wire);
    const arrivals = setInterval(
      () => folders.INBOX.uids.push(folders.INBOX.next++),
      100,
    );
    try {
      await complete("Large", 260, account, 60_000);
      await until(
        async () =>
          Number(
            (
              await reader`select count(*) from receiving_current_placements p join mailboxes b on b.id=p.mailbox_id where b.account_id=${account} and b.remote_path='INBOX'`
            )[0].count,
          ) > 1,
      );
    } finally {
      clearInterval(arrivals);
    }
    expect(errors).toEqual([]);
    await owner.stop();
    expect(exec.snapshot).toMatchObject({ executing: 0, waiting: 0 });
    expect(
      wire.observed.every((client) => {
        const socket = Reflect.get(client, "socket") as
          { closed: boolean } | undefined;
        return !socket || socket.closed;
      }),
    ).toBe(true);
  });

  it("serves new INBOX mail before initializing every secondary folder at startup", async () => {
    const folders: Record<string, Folder> = { INBOX: { uids: [], next: 1 } };
    for (let i = 0; i < 20; i++)
      folders[`Startup-${i}`] = { uids: [1], next: 2 };
    const wire = await peer(folders, false, 100);
    const { errors } = await start(wire);
    await until(async () =>
      wire.selected.some((path) => path.startsWith("Startup-")),
    );
    folders.INBOX.uids.push(1);
    folders.INBOX.next = 2;
    await until(
      async () =>
        (
          await reader`select p.uid from receiving_current_placements p join mailboxes b on b.id=p.mailbox_id where b.account_id=${account} and b.remote_path='INBOX' and p.uid=1`
        ).length === 1,
    );
    const [covered] =
      await reader`select count(*)::integer as count from receiving_mailboxes s join mailboxes b on b.id=s.mailbox_id where b.account_id=${account} and b.remote_path like 'Startup-%'`;
    expect(covered.count).toBeLessThan(20);
    expect(errors).toEqual([]);
  });

  it("retains secondary demand across a lost wake and disable/re-enable without resetting its epoch/history", async () => {
    const folders = {
      INBOX: { uids: [], next: 1 },
      Custom: { uids: [1], next: 2 },
    };
    const wire = await peer(folders);
    const { owner } = await start(wire);
    await complete("Custom", 1);
    const [b] =
      await reader`select id from mailboxes where account_id=${account} and remote_path='Custom'`;
    await reader`update mail_accounts set enabled=false where id=${account}`;
    await owner.refreshMembership();
    await until(async () => owner.snapshot.scheduler?.accounts === 0);
    folders.Custom.uids.push(2);
    folders.Custom.next = 3;
    await reader`update mail_accounts set enabled=true where id=${account}`;
    const demand = new ReceivingDemand(database.db, async () => {
      throw Error("Lost notification");
    });
    expect(await demand.request(account, b.id)).toBe(true);
    await complete("Custom", 2);
    const [s] =
      await reader`select epoch,history_before from receiving_mailboxes where mailbox_id=${b.id}`;
    expect(s).toMatchObject({ epoch: "7", history_before: "1" });
  });

  it("uses periodic LIST to find a new folder and retire a nonselectable manual destination without a wake", async () => {
    const folders: Record<string, Folder> = {
      INBOX: { uids: [], next: 1 },
      Target: { uids: [1], next: 2 },
    };
    const wire = await peer(folders);
    await start(wire);
    await complete("Target", 1);
    const [b] =
      await reader`select id from mailboxes where account_id=${account} and remote_path='Target'`;
    await new MailboxRoleService(database.db).setManual(
      account,
      "archive",
      b.id,
    );
    folders.Target.selectable = false;
    folders.Created = { uids: [1], next: 2 };
    await reader`update mail_accounts set last_successful_mailbox_discovery_at=clock_timestamp()-interval '61 seconds' where id=${account}`;
    await complete("Created", 1);
    expect(
      (await new MailboxRoleService(database.db).list(account)).find(
        (r) => r.role === "archive",
      ),
    ).toMatchObject({ source: "manual", available: false });
    expect(
      await reader`select id from receiving_current_placements where mailbox_id=${b.id}`,
    ).toHaveLength(0);
  });
});
