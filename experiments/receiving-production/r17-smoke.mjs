// R17 phases use the same normal compiled worker and isolated R16 deployment.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { getConfig } from "/app/dist-worker/shared/infrastructure/config/config.js";
import { createWorkerDatabase } from "/app/dist-worker/shared/infrastructure/database/database-worker.js";
import { MailboxService } from "/app/dist-worker/modules/mail/application/mailbox-service.js";
import { MailboxRoleService } from "/app/dist-worker/modules/mail/application/mailbox-role-service.js";
import { MessageCommandService } from "/app/dist-worker/modules/mail/application/message-command-service.js";
import { MessageService } from "/app/dist-worker/modules/mail/application/message-service.js";
import { MessageContentService } from "/app/dist-worker/modules/mail/application/message-content-service.js";
import { SearchService } from "/app/dist-worker/modules/mail/application/search-service.js";
import { OutgoingMessageService } from "/app/dist-worker/modules/mail/application/outgoing-message-service.js";
import { PgBossOutgoingScheduler } from "/app/dist-worker/modules/mail/infrastructure/outgoing-jobs.js";
import { LocalBlobStorage } from "/app/dist-worker/shared/infrastructure/storage/local-blob-storage.js";
const config = getConfig(),
  database = createWorkerDatabase(config),
  db = database.db,
  sql = database.client;
const state = JSON.parse(
  await readFile("/r16-evidence/smoke-state.json", "utf8"),
);
const phase = process.argv[2],
  started = performance.now(),
  measurements = {};
const watchdog = setTimeout(() => {
  console.error("R17 absolute phase deadline", phase);
  process.exit(1);
}, 240_000);
async function until(check, ms = 120_000) {
  const end = performance.now() + ms;
  while (!(await check())) {
    if (performance.now() > end)
      throw Error(`R17 ${phase} visibility deadline`);
    await delay(100);
  }
}
async function peer(update) {
  return (
    await fetch(
      "http://127.0.0.1:1995/",
      update ? { method: "POST", body: JSON.stringify(update) } : {},
    )
  ).json();
}
const placements = async (path, id = state.maildock) =>
  sql`select p.*,m.rfc_message_id from receiving_current_placements p join mailboxes b on b.id=p.mailbox_id join messages m on m.id=p.message_id where b.account_id=${id} and b.remote_path=${path} order by p.uid`;
const roles = new MailboxRoleService(db);
try {
  if (phase === "sync") {
    await until(
      async () =>
        Number(
          (
            await sql`select count(*) from receiving_mailboxes s join mailboxes b on b.id=s.mailbox_id where b.selectable and b.lifecycle_status='active' and s.history_before=1`
          )[0].count,
        ) === 24,
    );
    assert.equal(
      (await sql`select count(*) from receiving_current_placements`)[0].count,
      "3124",
    );
    for (const path of ["[Gmail]/All Mail", "[Gmail]/Important", "Projects"])
      assert.equal((await placements(path)).length, 3);
    const overlap = [
      ...(await placements("[Gmail]/All Mail")),
      ...(await placements("[Gmail]/Important")),
    ];
    assert.equal(new Set(overlap.map((r) => r.message_id)).size, 6);
    assert.equal(new Set(overlap.map((r) => r.rfc_message_id)).size, 3);
    assert.equal(
      (
        await sql`select count(*) from receiving_mailboxes s join mailboxes b on b.id=s.mailbox_id where b.remote_path='Container'`
      )[0].count,
      "0",
    );
    const views = await new MailboxService(db).listForAccount(state.maildock);
    assert.equal(
      views.find((m) => m.remotePath === "Container").receiving,
      undefined,
    );
    assert.ok(
      views
        .filter((m) => m.selectable)
        .every((m) => m.receiving.historyComplete),
    );
    const archive = views.find((m) => m.remotePath === "Przechowalnia");
    await roles.setManual(state.maildock, "archive", archive.id);
    state.r17Archive = archive.id;
    state.r17Coverage =
      await sql`select mailbox_id,epoch,fresh_through,history_before from receiving_mailboxes`;
    state.r17Owner = (
      await sql`select owner,generation from receiving_coordinator`
    )[0];
    measurements.placements = 3124;
  } else if (phase === "many") {
    const start = performance.now();
    for (const username of ["maildock", "server"])
      await peer({ action: "create-folders", username });
    await until(
      async () =>
        Number(
          (
            await sql`select count(*) from receiving_mailboxes s join mailboxes b on b.id=s.mailbox_id where b.selectable and b.lifecycle_status='active' and s.history_before=1`
          )[0].count,
        ) === 104,
      180_000,
    );
    measurements.newTopologyVisibilityMs = performance.now() - start;
    measurements.selectableMailboxes = 104;
  } else if (phase === "quiet") {
    const before = await peer(),
      start = performance.now();
    await peer({
      action: "flags",
      username: "maildock",
      folder: "Projects",
      uid: 2,
      flags: ["\\Seen", "\\Flagged"],
    });
    await peer({
      action: "delete",
      username: "maildock",
      folder: "Projects",
      uid: 1,
    });
    await peer({ action: "arrival", username: "maildock", folder: "Projects" });
    await until(async () => {
      const rows = await placements("Projects");
      return (
        rows.length === 3 &&
        rows[0].uid === "2" &&
        rows[0].flags.includes("\\Flagged") &&
        rows[2].uid === "4"
      );
    });
    measurements.quietVisibilityMs = performance.now() - start;
    const after = await peer();
    for (const key of ["move", "append", "smtp", "store"])
      assert.equal(after[key], before[key]);
    const view = (
      await new MailboxService(db).listForAccount(state.maildock)
    ).find((m) => m.remotePath === "Projects");
    assert.equal(view.unseenCount, "2");
  } else if (phase === "moves") {
    const service = new MessageCommandService(
      db,
      async () => {
        throw Error("Legacy mutation executor");
      },
      async () => {},
    );
    const before = await peer();
    for (const [uid, uidplus] of [
      [3, true],
      [4, false],
    ]) {
      await peer({ uidplus });
      const [source] =
        await sql`select p.* from receiving_current_placements p join mailboxes b on b.id=p.mailbox_id where b.account_id=${state.maildock} and b.remote_path='INBOX' and p.uid=${uid}`;
      const command = await service.create(
        state.maildock,
        source.mailbox_id,
        source.message_id,
        "archive",
      );
      await until(
        async () =>
          (
            await sql`select status from message_commands where id=${command.id}`
          )[0].status === "succeeded",
      );
      await until(
        async () =>
          (await placements("Przechowalnia")).filter(
            (p) => p.rfc_message_id === `<r16-${uid}@fixture.test>`,
          ).length === 1,
      );
      assert.equal(
        (
          await sql`select destination_mailbox_id from message_commands where id=${command.id}`
        )[0].destination_mailbox_id,
        state.r17Archive,
      );
      assert.equal(
        (
          await sql`select count(*) from receiving_current_placements where mailbox_id=${source.mailbox_id} and uid=${uid}`
        )[0].count,
        "0",
      );
    }
    await peer({ uidplus: true });
    assert.equal((await peer()).move - before.move, 2);
  } else if (phase === "sent") {
    const custom = (
      await new MailboxService(db).listForAccount(state.maildock)
    ).find((m) => m.remotePath === "Projects");
    await roles.setManual(state.maildock, "sent", custom.id);
    state.r17Sent = custom.id;
    const scheduler = new PgBossOutgoingScheduler(config);
    const outgoing = new OutgoingMessageService(
      db,
      (id) => scheduler.enqueue(id),
      undefined,
      undefined,
      undefined,
      undefined,
      new LocalBlobStorage(config.attachmentsPath),
      config,
    );
    const before = await peer();
    for (const [name, uidplus] of [
      ["maildock", true],
      ["maildock", false],
      ["server", true],
    ]) {
      await peer({ uidplus });
      const result = await outgoing.create({
        accountId: state[name],
        to: "recipient@fixture.test",
        subject: `R17 ${name} ${uidplus} ${randomUUID()}`,
        plainText: "Immutable R17 original MIME",
      });
      await until(
        async () =>
          (
            await sql`select status from outgoing_messages where id=${result.id}`
          )[0].status === "sent",
      );
      const [row] =
        await sql`select message_id from outgoing_messages where id=${result.id}`;
      await until(
        async () =>
          (
            await placements(
              name === "maildock" ? "Projects" : "Sent",
              state[name],
            )
          ).filter((p) => p.rfc_message_id === row.message_id).length === 1,
      );
      if (name === "maildock")
        await until(async () => {
          const [r] =
            await sql`select sent_copy_status,sent_copy_sync_pending from outgoing_messages where id=${result.id}`;
          return r.sent_copy_status === "saved" && !r.sent_copy_sync_pending;
        });
    }
    const after = await peer();
    assert.equal(after.smtp - before.smtp, 3);
    assert.equal(after.append - before.append, 2);
    assert.deepEqual(
      after.appendDigests.slice(-2),
      after.smtpDigests.slice(-3, -1),
    );
  } else if (phase === "reader") {
    const sample = (await placements("Projects")).find((p) => p.uid === "3");
    const content = new MessageContentService(db);
    await content.request(state.maildock, sample.mailbox_id, sample.message_id);
    await until(
      async () =>
        (
          await content.detail(
            state.maildock,
            sample.mailbox_id,
            sample.message_id,
          )
        ).content.status === "ready",
    );
    assert.equal(
      (
        await content.detail(
          state.maildock,
          sample.mailbox_id,
          sample.message_id,
        )
      ).content.plainText,
      "Hello R16\n",
    );
    const hits = await new SearchService(db).search("Hello");
    assert.ok(
      hits.items.some(
        (m) => m.id === sample.message_id && m.mailboxId === sample.mailbox_id,
      ),
    );
    const other = (
      await new MailboxService(db).listForAccount(state.maildock)
    ).find((m) => m.remotePath === "[Gmail]/All Mail");
    await assert.rejects(
      content.detail(state.maildock, other.id, sample.message_id),
    );
    const rendered = await fetch(
      `https://localhost:3443/api/accounts/${state.maildock}/mailboxes/${sample.mailbox_id}/messages/${sample.message_id}/render`,
      {
        method: "POST",
        headers: {
          host: new URL(config.appOrigin).host,
          origin: config.appOrigin,
          cookie: state.ownerCookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({ loadImages: false, trustSender: false }),
      },
    );
    assert.equal(rendered.status, 200);
    assert.equal((await rendered.json()).document, null);
  } else if (phase === "restart") {
    await until(async () => {
      const [r] =
        await sql`select owner,expires_at>clock_timestamp() live from receiving_coordinator`;
      return r.live && r.owner !== state.r17Owner.owner;
    });
    const current =
      await sql`select mailbox_id,epoch,fresh_through,history_before from receiving_mailboxes`;
    for (const previous of state.r17Coverage) {
      const row = current.find((r) => r.mailbox_id === previous.mailbox_id);
      assert.equal(row.epoch, previous.epoch);
      assert.equal(row.history_before, "1");
      assert.ok(BigInt(row.fresh_through) >= BigInt(previous.fresh_through));
    }
    assert.ok(
      (await roles.list(state.maildock)).some(
        (r) =>
          r.role === "archive" &&
          r.mailboxId === state.r17Archive &&
          r.source === "manual" &&
          r.available,
      ),
    );
    if (state.r17Sent)
      assert.ok(
        (await roles.list(state.maildock)).some(
          (r) =>
            r.role === "sent" &&
            r.mailboxId === state.r17Sent &&
            r.source === "manual" &&
            r.available,
        ),
      );
    const messages = new MessageService(db, {}, config);
    const [sample] = await placements("Projects");
    assert.ok(
      (await messages.list(state.maildock, sample.mailbox_id)).items.some(
        (m) => m.id === sample.message_id,
      ),
    );
  } else throw Error("Unknown R17 phase");
  const stats = await peer();
  assert.equal(stats.maxPerAccount, 1);
  assert.ok(stats.maxActive <= 2);
  await writeFile(
    "/r16-evidence/smoke-state.json",
    JSON.stringify(state, null, 2),
  );
  console.log(
    JSON.stringify({
      phase,
      result: "PASS",
      ms: performance.now() - started,
      measurements,
      peer: stats,
    }),
  );
} finally {
  clearTimeout(watchdog);
  await database.client.end({ timeout: 0 });
  setTimeout(() => process.exit(process.exitCode ?? 0), 10).unref();
}
