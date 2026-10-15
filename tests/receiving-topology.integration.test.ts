import { randomUUID } from "node:crypto";
import { ImapFlow, type ImapFlowOptions } from "imapflow";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { createDatabase } from "@/shared/infrastructure/database/database";
import { mailAccounts } from "@/shared/infrastructure/database/schema";
import { ReceivingExecutor } from "@/shared/infrastructure/database/receiving-executor";
import { ElectedReceivingCoordinator } from "@/modules/mail/application/receiving-election";
import { receivingTopologyHandlers } from "@/modules/mail/application/receiving-topology";
import { MailboxRoleService } from "@/modules/mail/application/mailbox-role-service";
import { fixture } from "../experiments/imap-transport/fixture";
import { receivingResponseRelay } from "./fixtures/receiving-response-relay";
import { setTimeout as delay } from "node:timers/promises";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}
type Entry = {
  path: string;
  flags?: string;
  id?: string;
  delimiter?: string | null;
};
type Wire = Awaited<ReturnType<typeof wire>>;
async function wire(
  options: {
    entries?: Entry[];
    objectId?: boolean;
    inlineStatus?: boolean;
    selectId?: string;
    namespace?: boolean;
    raw?: string;
    end?: "NO" | "BAD" | "disconnect" | "timeout";
    listGate?: {
      entered: ReturnType<typeof barrier>;
      go: ReturnType<typeof barrier>;
    };
    selectGate?: {
      entered: ReturnType<typeof barrier>;
      go: ReturnType<typeof barrier>;
    };
    epoch?: number;
    uidNext?: number;
    selectRaw?: string;
  } = {},
) {
  const entries = options.entries ?? [
    { path: "inbox" },
    { path: "Sent", flags: "\\Sent" },
  ];
  const peer = await fixture(
    (p, c) => {
      if (c.command.startsWith("LOGIN")) {
        p.ok(c);
        return true;
      }
      if (c.command === "NAMESPACE") {
        p.send(
          '* NAMESPACE (("Personal/" "/")) (("Other/" "/")) (("Shared/" "/"))\r\n',
          c,
        );
        p.ok(c);
        return true;
      }
      if (c.command.startsWith('LIST "" "*"')) {
        const send = () => {
          if (options.raw) p.send(options.raw, c);
          else
            for (const e of entries) {
              p.send(
                `* LIST (${e.flags ?? ""}) ${e.delimiter === null ? "NIL" : JSON.stringify(e.delimiter ?? "/")} ${JSON.stringify(e.path)}\r\n`,
                c,
              );
              if (e.id && options.inlineStatus !== false)
                p.send(
                  `* STATUS ${JSON.stringify(e.path)} (MAILBOXID (${e.id}))\r\n`,
                  c,
                );
            }
          if (options.end === "disconnect") p.socket.destroy();
          else if (options.end !== "timeout")
            p.ok(c, `${options.end ?? "OK"} Topology`);
        };
        if (options.listGate) {
          options.listGate.entered.release();
          void options.listGate.go.promise.then(send);
        } else send();
        return true;
      }
      if (c.command.startsWith("STATUS ") && options.objectId) {
        const entry = entries.find((e) =>
          c.command.includes(JSON.stringify(e.path)),
        );
        if (entry?.id) {
          p.send(
            `* STATUS ${JSON.stringify(entry.path)} (MAILBOXID (${entry.id}))\r\n`,
            c,
          );
          p.ok(c);
        } else p.ok(c, "NO Missing stable ID");
        return true;
      }
      if (/^(SELECT|EXAMINE) /.test(c.command)) {
        const send = () => {
          p.send(
            options.selectRaw ??
              `* 0 EXISTS\r\n* FLAGS ()\r\n* OK [UIDVALIDITY ${options.epoch ?? 7}] Epoch\r\n* OK [UIDNEXT ${options.uidNext ?? 11}] Next\r\n`,
            c,
          );
          if (options.selectId)
            p.send(`* OK [MAILBOXID (${options.selectId})] Identity\r\n`, c);
          p.ok(c, "OK [READ-ONLY] Selected");
        };
        if (options.selectGate) {
          options.selectGate.entered.release();
          void options.selectGate.go.promise.then(send);
        } else send();
        return true;
      }
      return false;
    },
    {},
    "OK",
    `IMAP4rev1 AUTH=XOAUTH2 SASL-IR SPECIAL-USE LIST-EXTENDED${options.objectId ? ` OBJECTID${options.inlineStatus === false ? "" : " LIST-STATUS"}` : ""}${options.namespace ? " NAMESPACE" : ""}`,
  );
  const clients: ImapFlow[] = [];
  return {
    ...peer,
    clients,
    createClient(opts: ImapFlowOptions) {
      const client = new ImapFlow({
        ...opts,
        tls: { rejectUnauthorized: false },
      });
      clients.push(client);
      return client;
    },
    connection: {
      host: peer.endpoint.host,
      port: peer.endpoint.port,
      security: "tls" as const,
      username: "fixture",
      credential: { kind: "password" as const, password: "fixture-only" },
    },
  };
}

describe("R07 elected bounded topology, installed IMAP adapter and actual R04 SQL", () => {
  let container: StartedTestContainer;
  let database: ReturnType<typeof createDatabase>;
  let reader: postgres.Sql;
  let url: string;
  let account: string;
  let coordinator: ElectedReceivingCoordinator;
  let currentExecutor: ReceivingExecutor;
  let selectedWire: Wire;
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
    await root`create database r07 owner lane`;
    await root.end();
    url = `postgres://lane:lane-fixture-only@${container.getHost()}:${container.getMappedPort(5432)}/r07`;
    database = createDatabase({ databaseUrl: url, databasePoolSize: 2 });
    reader = postgres(url, { max: 4 });
    await migrate(database.db, { migrationsFolder: "db/migrations" });
  });
  async function peer(options: Parameters<typeof wire>[0] = {}) {
    selectedWire = await wire(options);
    cleanup.push(selectedWire.cleanup);
    return selectedWire;
  }
  async function owner(execUrl = url, turn?: ReturnType<typeof barrier>) {
    const executor = new ReceivingExecutor(execUrl, 2);
    currentExecutor = executor;
    cleanup.push(() => executor.stop());
    coordinator = new ElectedReceivingCoordinator({
      executor,
      leaseMs: 60000,
      tuning: { workers: 2 },
      historyAllowed: () => false,
      loadAccount: async (_db, c) => ({
        ...c,
        connection: selectedWire.connection,
        createClient: selectedWire.createClient,
        timing: { pollMs: 60000 },
        onTurn: () => turn?.release(),
      }),
      loadOperationConnection: async () => selectedWire.connection,
      operationHandlers: receivingTopologyHandlers,
      createOperationClient: (opts) => selectedWire.createClient(opts),
    });
    cleanup.push(() => coordinator.stop());
    expect(await coordinator.elect()).toBe(true);
    return executor;
  }
  beforeEach(async () => {
    await reader`update receiving_coordinator set expires_at='-infinity'`;
    await reader`update mail_accounts set enabled=false`;
    await peer();
    // R03 supports account admission before a mailbox/candidate exists. Elect
    // first to keep automatic INBOX turns out of topology protocol fault oracles.
    await owner();
    account = await addAccount();
  });
  async function addAccount() {
    const id = randomUUID();
    await database.db.insert(mailAccounts).values({
      id,
      displayName: "R07 fixture",
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
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });
  afterAll(async () => {
    await reader?.end({ timeout: 0 });
    await database?.client.end({ timeout: 0 });
    await container?.stop();
  });
  function list(signal?: AbortSignal, ms = 9000, id = account) {
    return coordinator.submit({
      kind: "list",
      requestId: randomUUID(),
      identity: { account: id, configurationVersion: 1n },
      deadline: performance.now() + ms,
      signal,
    });
  }
  function select(mailbox: string, role?: "sent" | "trash" | "archive") {
    return coordinator.submit({
      kind: "select",
      role,
      requestId: randomUUID(),
      identity: { account, mailbox, configurationVersion: 1n },
      deadline: performance.now() + 9000,
    });
  }
  const folders = () =>
    reader`select * from mailboxes where account_id=${account} order by remote_path,id`;
  const states = () =>
    reader`select s.* from receiving_mailboxes s join mailboxes m on m.id=s.mailbox_id where m.account_id=${account} order by s.mailbox_id`;
  const roles = () =>
    reader`select * from mailbox_roles where account_id=${account} order by role`;
  const demand = async () =>
    (
      await reader`select receiving_due_at,receiving_request_generation from mail_accounts where id=${account}`
    )[0];
  const facts = async () => ({
    folders: [...(await folders())],
    states: [...(await states())],
    roles: [...(await roles())],
    demand: await demand(),
  });
  const gate = () => {
    const g = { entered: barrier(), go: barrier() };
    cleanup.push(async () => g.go.release());
    return g;
  };

  it("complete full namespace LIST before INBOX bootstrap publishes canonical INBOX and server roles with one owned socket", async () => {
    await peer({
      namespace: true,
      entries: [
        { path: "inbox" },
        { path: "Other/Sent", flags: "\\sEnT" },
        { path: "Shared/Archive", flags: "\\Archive" },
        { path: "Trash", flags: "\\Trash" },
        { path: "Drafts", flags: "\\Drafts" },
        { path: "Spam", flags: "\\Junk" },
      ],
    });
    const before = await demand();
    await list();
    expect((await folders()).map((m) => m.remote_path)).toEqual([
      "Drafts",
      "INBOX",
      "Other/Sent",
      "Shared/Archive",
      "Spam",
      "Trash",
    ]);
    expect((await roles()).map((r) => r.role)).toEqual([
      "archive",
      "drafts",
      "junk",
      "sent",
      "trash",
    ]);
    expect(await states()).toHaveLength(0);
    expect(await demand()).toEqual(before);
    expect(selectedWire.clients).toHaveLength(1);
    expect(Reflect.get(selectedWire.clients[0], "isClosed")).toBe(true);
    expect(
      selectedWire.commands.filter((c) => c.command.startsWith('LIST "" "*"')),
    ).toHaveLength(1);
    expect(
      selectedWire.commands.some((c) =>
        /^(LSUB|STATUS|UID |SELECT|EXAMINE)/.test(c.command),
      ),
    ).toBe(false);
  });
  it("does not infer roles from names and leaves ambiguous special-use unavailable", async () => {
    await peer({
      entries: [
        { path: "Sent" },
        { path: "A", flags: "\\Trash" },
        { path: "B", flags: "\\Trash" },
      ],
    });
    await list();
    expect(await roles()).toHaveLength(0);
  });
  it("manual mapping wins and missing mapped destinations remain explicit", async () => {
    await list();
    const sent = (await folders()).find((m) => m.remote_path === "Sent")!;
    await new MailboxRoleService(database.db).setManual(
      account,
      "sent",
      sent.id,
    );
    await peer({
      entries: [{ path: "INBOX" }, { path: "Other", flags: "\\Sent" }],
    });
    await list();
    const view = await new MailboxRoleService(database.db).list(account);
    expect(view.find((v) => v.role === "sent")).toMatchObject({
      mailboxId: sent.id,
      source: "manual",
      available: false,
    });
  });
  for (const change of [
    "manual",
    "configuration",
    "lifecycle",
    "takeover",
  ] as const)
    it(`${change} during LIST fences the entire result`, async () => {
      await list();
      const g = gate();
      await peer({ listGate: g, entries: [{ path: "New" }] });
      const pending = list();
      const checked = expect(pending).rejects.toThrow();
      await g.entered.promise;
      if (change === "manual")
        await new MailboxRoleService(database.db).setManual(
          account,
          "sent",
          (await folders())[0].id,
        );
      if (change === "configuration")
        await reader`update mail_accounts set imap_host='changed.test' where id=${account}`;
      if (change === "lifecycle") {
        await reader`update mail_accounts set enabled=false where id=${account}`;
        await reader`update mail_accounts set enabled=true where id=${account}`;
      }
      if (change === "takeover") {
        await reader`update receiving_coordinator set expires_at='-infinity'`;
        await reader`select maildock_receiving_takeover(${randomUUID()},60000)`;
      }
      const before = await facts();
      g.go.release();
      await checked;
      expect(await facts()).toEqual(before);
    });
  for (const end of ["NO", "BAD", "disconnect", "timeout"] as const)
    it(`partial LIST with ${end} preserves all prior topology and demand`, async () => {
      await list();
      const before = await facts();
      await peer({ entries: [{ path: "Partial" }], end });
      await expect(
        list(undefined, end === "timeout" ? 800 : 9000),
      ).rejects.toThrow();
      expect(await facts()).toEqual(before);
    });
  it("cancellation during LIST retires its socket before freeing admission and publishes nothing", async () => {
    await list();
    const before = await facts();
    const g = gate();
    await peer({ listGate: g });
    const abort = new AbortController();
    const pending = list(abort.signal);
    const checked = expect(pending).rejects.toThrow();
    await g.entered.promise;
    abort.abort();
    await checked;
    expect(Reflect.get(selectedWire.clients[0], "isClosed")).toBe(true);
    expect(await facts()).toEqual(before);
  });
  for (const raw of [
    '* LIST () "/" "inbox"\r\n* LIST () "/" "INBOX"\r\n',
    '* LIST NIL "/" "Bad"\r\n',
    '* LIST () "/" NIL\r\n',
    '* LIST () "//" "Bad"\r\n',
    '* LIST (\\Sent \\sent) "/" "Bad"\r\n',
    '* LIST () "/" "&broken"\r\n',
    '* LIST () "/" "Bad" (unexpected extension)\r\n',
    `* LIST () "/" "${"x".repeat(65536)}"\r\n`,
  ])
    it(`rejects malformed/duplicate/oversized raw LIST (${raw.slice(0, 35).trim()})`, async () => {
      await list();
      const before = await facts();
      await peer({ raw });
      await expect(list()).rejects.toThrow();
      expect(await facts()).toEqual(before);
    });
  it("129 observed identities reject rather than truncate", async () => {
    await list();
    const before = await facts();
    await peer({
      entries: Array.from({ length: 129 }, (_, i) => ({ path: `Folder${i}` })),
    });
    await expect(list()).rejects.toThrow();
    expect(await facts()).toEqual(before);
  });
  it("union bound includes retained missing identities; 128 is accepted", async () => {
    await peer({
      entries: Array.from({ length: 128 }, (_, i) => ({ path: `Folder${i}` })),
    });
    await list();
    expect(await folders()).toHaveLength(128);
    const before = await facts();
    await peer({ entries: [{ path: "New" }] });
    await expect(list()).rejects.toThrow(/128/);
    expect(await facts()).toEqual(before);
  });
  it("reliable MAILBOXID rename retains UUID while path-only rename creates a new identity", async () => {
    await peer({
      objectId: true,
      entries: [
        { path: "Stable", id: "F-stable" },
        { path: "Old", id: "F-other" },
      ],
    });
    await list();
    const before = await folders();
    await peer({
      objectId: true,
      entries: [
        { path: "Renamed", id: "F-stable" },
        { path: "Old", id: "F-other" },
      ],
    });
    await list();
    expect((await folders()).find((m) => m.remote_path === "Renamed")?.id).toBe(
      before.find((m) => m.remote_path === "Stable")!.id,
    );
    await peer({ entries: [{ path: "PathOnly" }] });
    await list();
    const old = (await folders()).find((m) => m.remote_path === "PathOnly")!;
    await peer({ entries: [{ path: "OtherPath" }] });
    await list();
    expect(
      (await folders()).find((m) => m.remote_path === "OtherPath")?.id,
    ).not.toBe(old.id);
    expect(
      (await folders()).find((m) => m.id === old.id)?.lifecycle_status,
    ).toBe("missing");
  });
  it("duplicate stable IDs and incomplete MAILBOXID evidence reject atomically", async () => {
    await list();
    const before = await facts();
    for (const entries of [
      [
        { path: "A", id: "F-duplicate" },
        { path: "B", id: "F-duplicate" },
      ],
      [{ path: "A" }],
    ]) {
      await peer({ objectId: true, entries });
      await expect(list()).rejects.toThrow();
      expect(await facts()).toEqual(before);
    }
  });
  it("withdrawn stable identity at a known path cannot invent deletion/recreation", async () => {
    await peer({
      objectId: true,
      entries: [{ path: "Sent", id: "F-sent", flags: "\\Sent" }],
    });
    await list();
    const before = await facts();
    await peer({ entries: [{ path: "Sent", flags: "\\Sent" }] });
    await expect(list()).rejects.toThrow(/stable mailbox identity/);
    expect(await facts()).toEqual(before);
  });
  it("OBJECTID without LIST-STATUS uses bounded same-socket identity STATUS commands", async () => {
    await peer({
      objectId: true,
      inlineStatus: false,
      entries: [
        { path: "INBOX", id: "F-inbox" },
        { path: "Sent", id: "F-sent", flags: "\\Sent" },
        { path: "Parent", flags: "\\Noselect" },
      ],
    });
    await list();
    expect(
      (await folders()).find((m) => m.remote_path === "Sent")
        ?.provider_mailbox_id,
    ).toBe("F-sent");
    expect(selectedWire.clients).toHaveLength(1);
    expect(
      selectedWire.commands.filter((c) => c.command.startsWith("STATUS ")),
    ).toHaveLength(2);
    expect(
      selectedWire.commands
        .filter((c) => c.command.startsWith("STATUS "))
        .every((c) => c.command.endsWith("(MAILBOXID)")),
    ).toBe(true);
  });
  it("selected destination outside personal namespace uses exact decoded path and no implicit LIST", async () => {
    await peer({
      namespace: true,
      entries: [{ path: "Shared/&AUI-&-Sent", flags: "\\Sent" }],
    });
    await list();
    const sent = (await folders())[0];
    expect(sent.remote_path).toBe("Shared/ł&Sent");
    const previous = selectedWire.commands.length;
    await select(sent.id, "sent");
    const commands = selectedWire.commands.slice(previous);
    expect(
      commands
        .filter((c) => /^(SELECT|EXAMINE)/.test(c.command))
        .map((c) => c.command),
    ).toEqual(['EXAMINE "Shared/&AUI-&-Sent"']);
    expect(
      commands.some(
        (c) => c.command.startsWith("LIST ") && c.command !== 'LIST "" ""',
      ),
    ).toBe(false);
  });
  it("enrolled stable-ID rename preserves epoch coverage and selected MAILBOXID must still match", async () => {
    await peer({
      objectId: true,
      entries: [{ path: "Sent", id: "F-stable", flags: "\\Sent" }],
      selectId: "F-stable",
    });
    await list();
    const sent = (await folders())[0];
    await select(sent.id, "sent");
    const before = (await states())[0];
    await peer({
      objectId: true,
      entries: [{ path: "Renamed", id: "F-stable", flags: "\\Sent" }],
      selectId: "F-wrong",
    });
    await list();
    expect((await folders())[0].id).toBe(sent.id);
    expect((await states())[0]).toEqual({
      ...before,
      revision: String(BigInt(before.revision) + 1n),
    });
    const factsBefore = await facts();
    await expect(select(sent.id, "sent")).rejects.toThrow();
    expect(await facts()).toEqual(factsBefore);
  });
  it("selected same-path epoch replacement resets coverage without ordinary secondary sync", async () => {
    await list();
    const sent = (await folders()).find((m) => m.remote_path === "Sent")!;
    await select(sent.id, "sent");
    await peer({ epoch: 8, uidNext: 1 });
    await select(sent.id, "sent");
    expect((await states())[0]).toMatchObject({
      epoch: "8",
      revision: "1",
      fresh_through: "0",
      history_before: "1",
      reconcile_after: "0",
    });
    expect(
      selectedWire.commands.some((c) => /^UID (SEARCH|FETCH)/.test(c.command)),
    ).toBe(false);
  });
  it("same-epoch UIDNEXT regression cannot validate an existing destination", async () => {
    await list();
    const sent = (await folders()).find((m) => m.remote_path === "Sent")!;
    await select(sent.id, "sent");
    const before = await facts();
    await peer({ uidNext: 1 });
    await expect(select(sent.id, "sent")).rejects.toThrow(/UIDNEXT/);
    expect(await facts()).toEqual(before);
  });
  it("missing and nonselectable transitions preserve enrollment/coverage and increment only topology revision", async () => {
    await list();
    const inbox = (await folders()).find((m) => m.remote_path === "INBOX")!;
    await select(inbox.id);
    const before = await states();
    await peer({ entries: [{ path: "INBOX", flags: "\\Noselect" }] });
    await list();
    expect((await states())[0]).toEqual({
      ...before[0],
      revision: String(BigInt(before[0].revision) + 1n),
    });
    expect((await folders()).find((m) => m.id === inbox.id)?.selectable).toBe(
      false,
    );
    expect(
      (await folders()).find((m) => m.remote_path === "Sent")?.lifecycle_status,
    ).toBe("missing");
    await expect(select(inbox.id)).rejects.toThrow();
  });
  it("selected secondary destination enrolls identity without SEARCH/FETCH or synchronized UI state", async () => {
    await list();
    const sent = (await folders()).find((m) => m.remote_path === "Sent")!;
    await select(sent.id, "sent");
    expect((await states())[0]).toMatchObject({
      mailbox_id: sent.id,
      epoch: "7",
      revision: "0",
      fresh_through: "10",
      history_before: "11",
      reconcile_after: "0",
    });
    expect((await folders()).find((m) => m.id === sent.id)).toMatchObject({
      recent_sync_status: "not_started",
      backfill_status: "not_started",
      delta_sync_status: "not_started",
    });
    expect(
      selectedWire.commands.some((c) => /^UID (SEARCH|FETCH)/.test(c.command)),
    ).toBe(false);
  });
  for (const change of ["role", "configuration", "path"] as const)
    it(`secondary SELECT fences concurrent ${change} change`, async () => {
      await list();
      const sent = (await folders()).find((m) => m.remote_path === "Sent")!;
      const g = gate();
      await peer({ selectGate: g });
      const pending = select(sent.id, "sent");
      const checked = expect(pending).rejects.toThrow();
      await g.entered.promise;
      if (change === "role")
        await new MailboxRoleService(database.db).setManual(
          account,
          "sent",
          (await folders()).find((m) => m.remote_path === "INBOX")!.id,
        );
      if (change === "configuration")
        await reader`update mail_accounts set imap_host='changed.test' where id=${account}`;
      if (change === "path")
        await reader`update mailboxes set remote_path='Changed' where id=${sent.id}`;
      const before = await facts();
      g.go.release();
      await checked;
      expect(await facts()).toEqual(before);
    });
  it("delete/recreate under a path replaces epoch without transferring old UID coverage", async () => {
    await list();
    const sent = (await folders()).find((m) => m.remote_path === "Sent")!;
    await select(sent.id, "sent");
    await peer({ entries: [{ path: "INBOX" }] });
    await list();
    await peer({
      entries: [{ path: "INBOX" }, { path: "Sent", flags: "\\Sent" }],
      epoch: 8,
      uidNext: 3,
    });
    await list();
    const recreated = (await folders()).find(
      (m) => m.remote_path === "Sent" && m.lifecycle_status === "active",
    )!;
    expect(recreated.id).not.toBe(sent.id);
    await select(recreated.id, "sent");
    expect(
      (await states()).find((s) => s.mailbox_id === recreated.id),
    ).toMatchObject({
      epoch: "8",
      fresh_through: "2",
      history_before: "3",
      revision: "0",
    });
    expect((await states()).find((s) => s.mailbox_id === sent.id)?.epoch).toBe(
      "7",
    );
  });
  it("failed account does not block another account", async () => {
    const g = gate();
    await peer({ listGate: g, end: "NO" });
    const second = await addAccount();
    const first = list();
    const checked = expect(first).rejects.toThrow();
    await g.entered.promise;
    // A second provider can finish while the first is still blocked on its wire.
    await peer();
    await list(undefined, 9000, second);
    expect(
      await reader`select * from mailboxes where account_id=${second}`,
    ).toHaveLength(2);
    g.go.release();
    await checked;
  });
  async function observed(check: () => Promise<boolean>) {
    const end = performance.now() + 5000;
    while (!(await check())) {
      if (performance.now() > end)
        throw new Error("R07 PostgreSQL barrier timed out");
      await delay(5);
    }
  }
  async function commitGate() {
    const blocker = await reader.reserve();
    await blocker`select pg_advisory_lock(883707)`;
    await reader.unsafe(`CREATE FUNCTION r07_hold() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.account_id='${account}'::uuid THEN PERFORM pg_advisory_xact_lock(883707); END IF; RETURN NULL; END $$;
      CREATE CONSTRAINT TRIGGER zzz_r07_hold AFTER INSERT OR UPDATE ON mailboxes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION r07_hold();`);
    cleanup.push(async () => {
      await blocker`select pg_advisory_unlock_all()`;
      blocker.release();
      await reader.unsafe(
        "DROP TRIGGER zzz_r07_hold ON mailboxes; DROP FUNCTION r07_hold();",
      );
    });
    return blocker;
  }
  it("backend crash before topology COMMIT rolls back all folders and roles", async () => {
    await list();
    const before = await facts();
    const blocker = await commitGate();
    await peer({ entries: [{ path: "New", flags: "\\Trash" }] });
    const pending = list();
    const checked = expect(pending).rejects.toThrow();
    let pid = 0;
    await observed(async () => {
      const waiting =
        await reader`select pid from pg_stat_activity where application_name='maildock-receiving-stage1' and wait_event='advisory'`;
      pid = waiting[0]?.pid;
      return !!pid;
    });
    expect(await facts()).toEqual(before);
    await reader`select pg_terminate_backend(${pid})`;
    await checked;
    expect(await facts()).toEqual(before);
    await blocker`select pg_advisory_unlock_all()`;
  });
  it("lost topology COMMIT reply uses locked recovery without duplicate identity or revision publication", async () => {
    await list();
    const inbox = (await folders()).find((m) => m.remote_path === "INBOX")!;
    await select(inbox.id);
    const before = await states();
    const blocker = await commitGate();
    const relay = await receivingResponseRelay(url);
    cleanup.push(relay.close);
    const lossy = new ReceivingExecutor(relay.url, 1);
    cleanup.push(() => lossy.stop());
    const g = gate();
    await peer({ listGate: g });
    const pending = list();
    await g.entered.promise;
    // Capture has completed. Route exactly the next (result) transaction through
    // the real reply-dropping relay; recovery uses the normal executor transport.
    const original = currentExecutor.transaction.bind(currentExecutor);
    currentExecutor.transaction = (work, options) => {
      currentExecutor.transaction = original;
      return lossy.transaction(work, options);
    };
    g.go.release();
    await observed(
      async () =>
        (
          await reader`select pid from pg_stat_activity where application_name='maildock-receiving-stage1' and wait_event='advisory'`
        ).length > 0,
    );
    relay.control.drop = true;
    await blocker`select pg_advisory_unlock_all()`;
    await pending;
    expect(await folders()).toHaveLength(2);
    expect((await states())[0]).toEqual({
      ...before[0],
      revision: String(BigInt(before[0].revision) + 1n),
    });
    expect(selectedWire.clients).toHaveLength(1);
  });
  it("restart uses persisted identities and the R06 INBOX bootstrap before another explicit LIST", async () => {
    await list();
    const before = await folders();
    await coordinator.stop();
    const firstTurn = barrier();
    await owner(url, firstTurn);
    await firstTurn.promise;
    await list();
    expect((await folders()).map((m) => m.id)).toEqual(before.map((m) => m.id));
    expect(await states()).toHaveLength(1);
  });
  it("lost secondary enrollment COMMIT reply recovers exact identity without replay", async () => {
    await list();
    const sent = (await folders()).find((m) => m.remote_path === "Sent")!;
    const beforeDemand = await demand();
    const blocker = await commitGate();
    const relay = await receivingResponseRelay(url);
    cleanup.push(relay.close);
    const lossy = new ReceivingExecutor(relay.url, 1);
    cleanup.push(() => lossy.stop());
    const g = gate();
    await peer({ selectGate: g });
    const pending = select(sent.id, "sent");
    await g.entered.promise;
    const original = currentExecutor.transaction.bind(currentExecutor);
    currentExecutor.transaction = (work, options) => {
      currentExecutor.transaction = original;
      return lossy.transaction(work, options);
    };
    g.go.release();
    await observed(
      async () =>
        (
          await reader`select pid from pg_stat_activity where application_name='maildock-receiving-stage1' and wait_event='advisory'`
        ).length > 0,
    );
    relay.control.drop = true;
    await blocker`select pg_advisory_unlock_all()`;
    await pending;
    expect(await states()).toHaveLength(1);
    expect((await states())[0]).toMatchObject({
      mailbox_id: sent.id,
      epoch: "7",
      revision: "0",
      fresh_through: "10",
      history_before: "11",
      reconcile_after: "0",
      configuration_binding: "1",
    });
    expect(selectedWire.clients).toHaveLength(1);
    expect(await demand()).toEqual(beforeDemand);
  });
  it("aggregate wire evidence above 2 MiB is rejected atomically", async () => {
    await list();
    const before = await facts();
    const attributes = Array.from(
      { length: 128 },
      (_, i) => `\\X${i}${"x".repeat(240)}`,
    ).join(" ");
    await peer({
      entries: Array.from({ length: 80 }, (_, i) => ({
        path: `Folder${i}`,
        flags: attributes,
      })),
    });
    await expect(list()).rejects.toThrow();
    expect(await facts()).toEqual(before);
  });
  for (const selectRaw of [
    "* 0 EXISTS\r\n* OK [UIDVALIDITY 7] Epoch\r\n",
    "* 0 EXISTS\r\n* OK [UIDVALIDITY 7] Epoch\r\n* OK [UIDNEXT 0] Next\r\n",
    "* 0 EXISTS\r\n* OK [UIDVALIDITY 7] Epoch\r\n* OK [UIDVALIDITY 7] Duplicate\r\n* OK [UIDNEXT 1] Next\r\n",
  ])
    it("incomplete/invalid selected destination evidence cannot enroll", async () => {
      await list();
      const sent = (await folders()).find((m) => m.remote_path === "Sent")!;
      const before = await facts();
      await peer({ selectRaw });
      await expect(select(sent.id, "sent")).rejects.toThrow();
      expect(await facts()).toEqual(before);
    });
});
