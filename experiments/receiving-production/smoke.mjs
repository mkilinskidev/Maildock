// Run with node inside the *normal* R16 app container in an isolated project.
// These are the same application services used by authenticated HTTP handlers.
// Synthetic owner/MFA provisioning is explicit; no browser enrollment is claimed.
import assert from "node:assert/strict";
import { htmlBoundary } from "./html-boundaries.mjs";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { getConfig } from "/app/dist-worker/shared/infrastructure/config/config.js";
import { createWorkerDatabase } from "/app/dist-worker/shared/infrastructure/database/database-worker.js";
import { initializeOwner } from "/app/dist-worker/modules/auth/application/instance-auth.js";
import { startInitialMfa } from "/app/dist-worker/modules/auth/application/initial-mfa.js";
import { createAuth } from "/app/dist-worker/modules/auth/infrastructure/auth-factory.js";
import { challengeHeaders } from "/app/dist-worker/modules/auth/infrastructure/mfa-cookies.js";
import { AesGcmSecretEncryption } from "/app/dist-worker/shared/infrastructure/crypto/aes-gcm-secret-encryption.js";
import { AccountsService } from "/app/dist-worker/modules/accounts/application/accounts-service.js";
import { PgBossMailboxDiscoveryScheduler } from "/app/dist-worker/modules/mail/infrastructure/mailbox-discovery-jobs.js";
import { MessageService } from "/app/dist-worker/modules/mail/application/message-service.js";
import { MessageContentService } from "/app/dist-worker/modules/mail/application/message-content-service.js";
import { MessageCommandService } from "/app/dist-worker/modules/mail/application/message-command-service.js";
import { AttachmentService } from "/app/dist-worker/modules/mail/application/attachment-service.js";
import { LocalBlobStorage } from "/app/dist-worker/shared/infrastructure/storage/local-blob-storage.js";
import { DraftService } from "/app/dist-worker/modules/mail/application/draft-service.js";
import { OutgoingMessageService } from "/app/dist-worker/modules/mail/application/outgoing-message-service.js";
import { PgBossOutgoingScheduler } from "/app/dist-worker/modules/mail/infrastructure/outgoing-jobs.js";
import { ComposePreparationService } from "/app/dist-worker/modules/mail/application/compose-preparation-service.js";
import { EmailRenderingService } from "/app/dist-worker/modules/mail/application/email-rendering-service.js";
import { MailboxService } from "/app/dist-worker/modules/mail/application/mailbox-service.js";
import { ReceivingDiagnosticClient } from "/app/dist-worker/modules/mail/infrastructure/receiving-diagnostic-rpc.js";
import { ImapSmtpMailProvider } from "/app/dist-worker/modules/accounts/infrastructure/imap-smtp-mail-provider.js";

const { symmetricDecrypt } = await import(
  createRequire("/app/package.json").resolve("better-auth/crypto")
);

const config = getConfig(),
  database = createWorkerDatabase(config),
  db = database.db,
  sql = database.client;
const statePath = "/r16-evidence/smoke-state.json";
const state = await readFile(statePath, "utf8")
  .then(JSON.parse)
  .catch(() => ({}));
const phase = process.argv[2];
const measurements = {};
const watchdog = setTimeout(
  () => {
    console.error(`R16 ${phase} absolute fixture deadline`);
    process.exit(1);
  },
  phase === "quiet" ? 240_000 : 180_000,
);
const started = performance.now();
async function until(check, ms = 60_000) {
  const end = performance.now() + ms;
  while (!(await check())) {
    if (performance.now() > end)
      throw new Error(`R16 ${phase} barrier deadline`);
    await delay(100);
  }
}
async function peer(update) {
  const result = await fetch(
    "http://127.0.0.1:1995/",
    update ? { method: "POST", body: JSON.stringify(update) } : {},
  );
  return result.json();
}
const responseCookies = (response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
async function ownerLogin(auth) {
  return auth.api.signInUsername({
    headers: new Headers({ Origin: config.appOrigin }),
    body: {
      username: "r16-owner",
      password: "R16 isolated fixture password",
    },
    asResponse: true,
  });
}
async function renderThroughWeb(accountId, mailboxId, messageId) {
  return fetch(
    `https://localhost:3443/api/accounts/${accountId}/mailboxes/${mailboxId}/messages/${messageId}/render`,
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
}
const storage = new LocalBlobStorage(config.attachmentsPath);
const content = new MessageContentService(db);
const attachments = new AttachmentService(db, storage, config, async () => {
  throw new Error("Legacy attachment enqueue");
});
const commands = new MessageCommandService(
  db,
  async () => {
    throw new Error("Legacy command enqueue");
  },
  async () => {},
);
const outgoingScheduler = new PgBossOutgoingScheduler(config);
let discovery;
async function source(uid = 1, id = state.maildock) {
  return (
    await sql`select p.message_id,p.mailbox_id from mailbox_messages p join mailboxes b on b.id=p.mailbox_id
    where b.account_id=${id} and b.remote_path='INBOX' and p.uid=${uid}`
  )[0];
}
async function command(uid, action, expected = "succeeded") {
  const s = await source(uid);
  const row = await commands.create(
    state.maildock,
    s.mailbox_id,
    s.message_id,
    action,
  );
  await until(
    async () =>
      (await sql`select status from message_commands where id=${row.id}`)[0]
        .status === expected,
  );
  return row;
}
try {
  if (phase === "setup") {
    const proof = randomUUID(),
      digest = createHash("sha256").update(proof).digest("hex");
    await sql`update instance_state set bootstrap_secret_digest=${digest},bootstrap_expires_at=clock_timestamp()+interval '1 hour' where initialized_at is null`;
    await initializeOwner(db, {
      username: "r16-owner",
      password: "R16 isolated fixture password",
      bootstrapSecret: proof,
    });
    const auth = createAuth(config, db);
    const initialLogin = await ownerLogin(auth);
    assert.equal(initialLogin.status, 200);
    const initialCookie = responseCookies(initialLogin);
    const initialHeaders = new Headers({
      cookie: initialCookie,
      Origin: config.appOrigin,
    });
    await startInitialMfa(db, config, initialHeaders, {
      bootstrapSecret: proof,
      password: "R16 isolated fixture password",
    });
    const factorRow = (await sql`select secret from two_factor`)[0];
    const factorSecret = await symmetricDecrypt({
      key: (await auth.$context).secretConfig,
      data: factorRow.secret,
    });
    const ownerId = (await sql`select owner_user_id from instance_state`)[0]
      .owner_user_id;
    await sql`update two_factor set verified=true where user_id=${ownerId}`;
    await sql`update "user" set two_factor_enabled=true where id=${ownerId}`;
    await sql`delete from "session" where user_id=${ownerId}`;
    await sql`update instance_state set bootstrap_secret_digest=null,bootstrap_expires_at=null`;
    const challenge = await ownerLogin(auth);
    assert.equal(challenge.status, 200);
    const challengeCookie = responseCookies(challenge);
    const suppliedChallengeHeaders = new Headers({
      cookie: challengeCookie,
      Origin: config.appOrigin,
    });
    const loginCode = (
      await auth.api.generateTOTP({
        body: { secret: factorSecret },
      })
    ).code;
    const verifiedLogin = await auth.api.verifyTOTP({
      headers: await challengeHeaders(auth, suppliedChallengeHeaders),
      body: { code: loginCode },
      asResponse: true,
    });
    if (!verifiedLogin.ok) {
      const failure = await verifiedLogin.json().catch(() => ({}));
      throw new Error(
        `Synthetic MFA verification failed (${verifiedLogin.status}; ${failure.code ?? "unknown"}).`,
      );
    }
    state.ownerCookie = responseCookies(verifiedLogin);
    await peer({ largeHtml: true });
    discovery = new PgBossMailboxDiscoveryScheduler(config);
    const accounts = new AccountsService(
      db,
      new AesGcmSecretEncryption(
        config.credentialsEncryption.activeKeyId,
        config.credentialsEncryption.keys,
      ),
      {},
      discovery,
    );
    for (const name of ["maildock", "server"]) {
      const id = randomUUID();
      await accounts.create({
        id,
        displayName: `R16 ${name}`,
        email: `${name}@fixture.test`,
        providerType: "imap_smtp",
        enabled: true,
        sentCopyPolicy: name,
        imap: {
          host: "localhost",
          port: 1993,
          security: "tls",
          username: name,
          password: "fixture-only",
        },
        smtp: {
          host: "localhost",
          port: 1465,
          security: "tls",
          useImapCredentials: true,
        },
      });
      state[name] = id;
    }
  } else if (phase === "ingress") {
    const origin = new URL(config.appOrigin).host;
    const statuses = {};
    for (const route of [
      "/api/health/live",
      "/api/health/ready",
      "/api/accounts",
    ]) {
      const response = await fetch(`https://localhost:3443${route}`, {
        headers: { host: origin },
        redirect: "manual",
      });
      statuses[route] = response.status;
      assert.equal(response.status, route === "/api/accounts" ? 401 : 200);
      await response.arrayBuffer();
    }
    console.log(JSON.stringify({ ingress: statuses }));
  } else if (phase === "rediscover") {
    discovery = new PgBossMailboxDiscoveryScheduler(config);
    const accounts = new AccountsService(
      db,
      new AesGcmSecretEncryption(
        config.credentialsEncryption.activeKeyId,
        config.credentialsEncryption.keys,
      ),
      {},
      discovery,
    );
    for (const name of ["maildock", "server"]) {
      await accounts.requestMailboxDiscovery(state[name]);
      await until(async () =>
        (
          await sql`select imap_capabilities from mail_accounts where id=${state[name]}`
        )[0].imap_capabilities.includes("MOVE"),
      );
    }
  } else if (phase === "prepare-reply") {
    const s = await source(2);
    await content.request(state.maildock, s.mailbox_id, s.message_id);
    await until(
      async () =>
        (await content.detail(state.maildock, s.mailbox_id, s.message_id))
          .content.status === "ready",
    );
  } else if (phase === "diagnose") {
    console.log(
      JSON.stringify({
        outgoing:
          await sql`select id,status,sent_copy_status,sent_copy_error,receiving_attempt from outgoing_messages`,
      }),
    );
    console.log(
      JSON.stringify({
        moves:
          await sql`select c.id,c.account_id,c.source_configuration_binding,c.destination_mailbox_id,c.destination_path,c.receiving_attempt,a.configuration_version,b.remote_path,s.epoch,s.configuration_binding,r.mailbox_id as mapped_destination,maildock_receiving_move_destination(c.account_id,c.action,c.destination_mailbox_id,c.destination_path) as destination_available from message_commands c join mail_accounts a on a.id=c.account_id left join mailboxes b on b.id=c.destination_mailbox_id left join receiving_mailboxes s on s.mailbox_id=b.id left join mailbox_roles r on r.account_id=c.account_id and r.role=c.action where c.action in ('archive','trash')`,
      }),
    );
    console.log(
      JSON.stringify({
        accounts: await sql`select id,imap_capabilities from mail_accounts`,
        roles: await sql`select * from mailbox_roles`,
        mailboxes: await sql`select id,remote_path,special_use from mailboxes`,
        commands: await sql`select action,status,error from message_commands`,
      }),
    );
    console.log(
      JSON.stringify({
        contents:
          await sql`select status,error,receiving_attempt from message_contents`,
        placements: await sql`select count(*) from mailbox_messages`,
        accounts: await sql`select mailbox_discovery_status from mail_accounts`,
        attachments:
          await sql`select status,error from message_attachments where status<>'not_fetched'`,
      }),
    );
  } else if (phase === "dense") {
    const id = randomUUID();
    discovery = new PgBossMailboxDiscoveryScheduler(config);
    const accounts = new AccountsService(
      db,
      new AesGcmSecretEncryption(
        config.credentialsEncryption.activeKeyId,
        config.credentialsEncryption.keys,
      ),
      {},
      discovery,
    );
    const begin = performance.now();
    await accounts.create({
      id,
      displayName: "Dense benchmark",
      email: "benchmark@fixture.test",
      providerType: "imap_smtp",
      enabled: true,
      imap: {
        host: "localhost",
        port: 1993,
        security: "tls",
        username: `benchmark-${id}`,
        password: "fixture-only",
      },
      smtp: {
        host: "localhost",
        port: 1465,
        security: "tls",
        useImapCredentials: true,
      },
    });
    await until(
      async () =>
        Number(
          (
            await sql`select count(*) from receiving_mailboxes s join mailboxes b on b.id=s.mailbox_id where b.account_id=${id} and b.remote_path='INBOX' and s.history_before=1`
          )[0].count,
        ) === 1,
    );
    state.benchmarkMs = performance.now() - begin;
    state.benchmark = id;
    assert.equal(
      Number(
        (
          await sql`select count(*) from mailbox_messages p join mailboxes b on b.id=p.mailbox_id where b.account_id=${id}`
        )[0].count,
      ),
      1024,
    );
    console.log(
      JSON.stringify({
        benchmarkMessages: 1024,
        benchmarkMs: state.benchmarkMs,
      }),
    );
  } else if (phase === "diagnostics") {
    const encryption = new AesGcmSecretEncryption(
      config.credentialsEncryption.activeKeyId,
      config.credentialsEncryption.keys,
    );
    const provider = new ImapSmtpMailProvider();
    const accounts = new AccountsService(
      db,
      encryption,
      provider,
      undefined,
      undefined,
      undefined,
      new ReceivingDiagnosticClient(db, {
        endpoint: config.diagnosticEndpoint,
        authSecret: config.authSecret,
        encryption,
      }),
      provider,
    );
    const result = await accounts.testExisting(state.maildock);
    assert.equal(result.imap.success, true);
    assert.equal(result.smtp.success, true);
  } else if (phase === "receive") {
    await until(
      async () =>
        Number(
          (
            await sql`select count(*) from receiving_mailboxes s join mailboxes b on b.id=s.mailbox_id where b.remote_path='INBOX' and s.history_before=1`
          )[0].count,
        ) === 2 &&
        (
          await sql`select count(*) from mail_accounts where mailbox_discovery_status='success'`
        )[0].count === "2",
      90_000,
    );
    assert.equal(
      Number((await sql`select count(*) from mailbox_messages`)[0].count),
      2048,
    );
    assert.equal(
      (
        await sql`select count(*) from mail_accounts where mailbox_discovery_status='success'`
      )[0].count,
      "2",
    );
    state.initialPeer = await peer();
    assert.equal(state.initialPeer.maxPerAccount, 1);
    assert.ok(state.initialPeer.maxActive <= 2);
    const views = await new MailboxService(db).listForAccount(state.maildock);
    assert.equal(
      views.find((m) => m.remotePath === "Sent").receiving.mode,
      "mailbox",
    );
    assert.equal(
      views.find((m) => m.remotePath === "INBOX").receiving.historyComplete,
      true,
    );
    const s = await source();
    state.source = s;
    const list = await new MessageService(db).list(
      state.maildock,
      s.mailbox_id,
    );
    assert.ok(list.items.length > 0);
  } else if (phase === "commit-loss-restart") {
    assert(state.commitLoss);
    const { source, committed, counters } = state.commitLoss;
    const lossEvidence = JSON.parse(
      await readFile("/r16-evidence/compose-commit-loss.json", "utf8"),
    );
    await until(
      async () =>
        (
          await sql`select expires_at>clock_timestamp() and owner<>${lossEvidence.owner.owner}::uuid and generation>${lossEvidence.owner.generation}::bigint as live from receiving_coordinator where singleton`
        )[0].live,
    );
    const [row] =
      await sql`select status,receiving_attempt from message_contents where message_id=${source.message_id}`;
    assert.deepEqual(row, committed);
    const stats = await peer();
    assert.equal(stats.literalBytes, lossEvidence.peerAfterCommit.literalBytes);
    for (const key of ["store", "move", "append", "smtp"])
      assert.equal(stats[key], counters[key]);
    assert.equal(
      (await sql`select count(*)::int as n from r16_commit_audit`)[0].n,
      1,
    );
    assert.equal(
      (
        await sql`select count(*)::int as n from message_contents where message_id=${source.message_id}`
      )[0].n,
      1,
    );
    measurements.commitLossRestart = {
      originalAttempt: row.receiving_attempt,
      singlePublication: true,
      noRemoteMutation: true,
    };
  } else if (phase === "html-newsletter" || phase === "html-css") {
    const kind = phase.slice(5);
    const fixture = htmlBoundary(kind);
    await peer({ htmlBoundary: kind });
    const s = await source(kind === "newsletter" ? 1 : 101);
    const before = await peer();
    const begin = performance.now();
    await content.request(state.maildock, s.mailbox_id, s.message_id);
    await until(
      async () =>
        (await content.detail(state.maildock, s.mailbox_id, s.message_id))
          .content.status === "ready",
    );
    const [row] =
      await sql`select c.sanitized_html,c.plain_text,m.search_body from message_contents c join messages m on m.id=c.message_id where c.message_id=${s.message_id}`;
    assert(row.sanitized_html);
    assert.equal(
      (row.sanitized_html.match(/<section\b/g) ?? []).length,
      fixture.count,
    );
    assert(
      !/<script|onerror=|<img[^>]+ src="https?:/i.test(row.sanitized_html),
    );
    // MIME plain alternative is authoritative for durable search; independently
    // verify the HTML-only search oracle with the same compiled sanitizer.
    assert.equal(row.search_body, row.plain_text);
    const { sanitizeEmailHtml } =
      await import("/app/dist-worker/modules/mail/infrastructure/sanitize-email-html.js");
    const sanitized = sanitizeEmailHtml(fixture.html);
    assert.equal(sanitized.searchText, fixture.searchText);
    assert(sanitized.remoteContentBlocked);
    const response = await renderThroughWeb(
      state.maildock,
      s.mailbox_id,
      s.message_id,
    );
    assert.equal(response.status, 200);
    const rendered = await response.text();
    assert(!rendered.includes('src=\\"https://remote.invalid'));
    measurements.htmlBoundary = {
      kind,
      inputBytes: Buffer.byteLength(fixture.html),
      sections: fixture.count,
      durationMs: performance.now() - begin,
      literalBytes: (await peer()).literalBytes - before.literalBytes,
      sanitizedCorrect: true,
      searchCorrect: true,
      authenticatedRender: true,
    };
  } else if (phase === "reader") {
    const s = state.source;
    const htmlStarted = performance.now();
    await content.request(state.maildock, s.mailbox_id, s.message_id);
    await until(async () => {
      const detail = await content.detail(
        state.maildock,
        s.mailbox_id,
        s.message_id,
      );
      if (detail.content.status === "failed")
        throw new Error(`R16 content rejected: ${detail.content.error}`);
      return detail.content.status === "ready";
    });
    measurements.pathologicalHtmlRequestToReadyMs =
      performance.now() - htmlStarted;
    const detail = await content.detail(
      state.maildock,
      s.mailbox_id,
      s.message_id,
    );
    assert.equal(detail.content.plainText, "Hello R16\n");
    assert.equal(detail.content.sanitizedHtml, null);
    assert.equal(detail.content.remoteContentBlocked, false);
    const rejectedRoute = await renderThroughWeb(
      state.maildock,
      s.mailbox_id,
      s.message_id,
    );
    assert.equal(rejectedRoute.status, 200);
    assert.equal((await rejectedRoute.json()).document, null);
    const parts =
      await sql`select id,filename from message_attachments where message_id=${s.message_id}`;
    state.large = parts.find((p) => p.filename === "large.bin").id;
    state.inline = parts.find((p) => p.filename === "inline.png").id;
    await attachments.request(state.inline);
    await until(
      async () =>
        (
          await sql`select status from message_attachments where id=${state.inline}`
        )[0].status === "ready",
    );
    const normal = await source(2);
    await content.request(state.maildock, normal.mailbox_id, normal.message_id);
    await until(
      async () =>
        (
          await content.detail(
            state.maildock,
            normal.mailbox_id,
            normal.message_id,
          )
        ).content.status === "ready",
    );
    const normalDetail = await content.detail(
      state.maildock,
      normal.mailbox_id,
      normal.message_id,
    );
    assert.ok(
      normalDetail.content.sanitizedHtml?.includes("Ordinary R16 newsletter."),
    );
    assert.equal(normalDetail.content.remoteContentBlocked, true);
    const normalParts =
      await sql`select id,filename from message_attachments where message_id=${normal.message_id}`;
    const normalInline = normalParts.find((p) => p.filename === "inline.png");
    assert.ok(normalInline);
    await attachments.request(normalInline.id);
    await until(
      async () =>
        (
          await sql`select status from message_attachments where id=${normalInline.id}`
        )[0].status === "ready",
    );
    const rendered = await new EmailRenderingService(
      db,
      content,
      attachments,
    ).render(state.maildock, normal.mailbox_id, normal.message_id, {
      loadImages: false,
      trustSender: false,
    });
    assert.ok(rendered.document);
    assert.equal(rendered.inlineFailures, 0);
    assert.equal(rendered.blocked, true);
    const actualRoute = await renderThroughWeb(
      state.maildock,
      normal.mailbox_id,
      normal.message_id,
    );
    assert.equal(actualRoute.status, 200);
    const routeResult = await actualRoute.json();
    assert.ok(routeResult.document?.includes("Ordinary R16 newsletter."));
    assert.equal(routeResult.blocked, true);
    const count = (await peer()).literalBytes;
    await content.request(state.maildock, normal.mailbox_id, normal.message_id);
    await attachments.request(normalInline.id);
    assert.equal((await peer()).literalBytes, count);
  } else if (phase === "html-repeat") {
    const repeated = await source(101);
    const before = (await peer()).literalBytes;
    const started = performance.now();
    await content.request(
      state.maildock,
      repeated.mailbox_id,
      repeated.message_id,
    );
    await until(async () => {
      const detail = await content.detail(
        state.maildock,
        repeated.mailbox_id,
        repeated.message_id,
      );
      if (detail.content.status === "failed")
        throw new Error(`R16 repeated HTML rejected: ${detail.content.error}`);
      return detail.content.status === "ready";
    });
    const detail = await content.detail(
      state.maildock,
      repeated.mailbox_id,
      repeated.message_id,
    );
    assert.equal(detail.content.plainText, "Hello R16\n");
    assert.equal(detail.content.sanitizedHtml, null);
    measurements.repeatedPathologicalHtmlRequestToReadyMs =
      performance.now() - started;
    const after = (await peer()).literalBytes;
    assert.ok(after > before);
    await content.request(
      state.maildock,
      repeated.mailbox_id,
      repeated.message_id,
    );
    assert.equal((await peer()).literalBytes, after);
  } else if (phase === "attachment") {
    await attachments.request(state.large);
    await until(
      async () =>
        (
          await sql`select status from message_attachments where id=${state.large}`
        )[0].status === "ready",
      120_000,
    );
    const count = (await peer()).literalBytes;
    const download = await attachments.downloadStream(state.large);
    const actual = createHash("sha256"),
      expected = createHash("sha256"),
      chunk = Buffer.alloc(32768, 97);
    let total = 0;
    for await (const bytes of download.stream) {
      actual.update(bytes);
      total += bytes.length;
    }
    for (let i = 0; i < 3200; i++) expected.update(chunk);
    assert.equal(total, 100 * 1024 * 1024);
    assert.equal(actual.digest("hex"), expected.digest("hex"));
    await attachments.request(state.large);
    assert.equal((await peer()).literalBytes, count);
  } else if (phase === "commands") {
    await peer({
      action: "flags",
      username: "maildock",
      uid: 2,
      flags: ["\\Answered"],
    });
    for (const action of ["mark_read", "mark_unread", "flag", "unflag"]) {
      await command(2, action);
      assert.ok(
        (
          await sql`select flags from mailbox_messages where mailbox_id=${state.source.mailbox_id} and uid=2`
        )[0].flags.includes("\\Answered"),
      );
    }
    const before = await peer();
    await command(3, "archive");
    await command(4, "trash");
    assert.equal((await peer()).move - before.move, 2);
    await peer({ move: false });
    const n = (await peer()).move;
    await command(5, "archive", "failed");
    assert.equal((await peer()).move, n);
    await peer({ move: true });
    await peer({ drop: "STORE" });
    const stores = (await peer()).store;
    await command(6, "flag");
    assert.equal((await peer()).store, stores + 1);
  } else if (phase === "outgoing") {
    const drafts = new DraftService(db);
    const draft = await drafts.create({
      id: randomUUID(),
      accountId: state.maildock,
      to: "recipient@fixture.test",
      subject: "R16 draft",
      plainText: "Autosave",
    });
    const saved = await drafts.update(draft.id, {
      expectedRevision: draft.revision,
      accountId: state.maildock,
      to: "recipient@fixture.test",
      subject: "R16 autosaved",
      plainText: "Autosaved text",
    });
    assert.equal(saved.plainText, "Autosaved text");
    const replySource = await source(2);
    await content.request(
      state.maildock,
      replySource.mailbox_id,
      replySource.message_id,
    );
    await until(
      async () =>
        (
          await content.detail(
            state.maildock,
            replySource.mailbox_id,
            replySource.message_id,
          )
        ).content.status === "ready",
    );
    for (const mode of ["reply", "reply_all", "forward"]) {
      const s = replySource;
      const result = await new ComposePreparationService(
        db,
        content,
        attachments,
      ).prepare({
        accountId: state.maildock,
        mailboxId: s.mailbox_id,
        messageId: s.message_id,
        mode,
      });
      assert.equal(result.status, "ready");
    }
    const outgoing = new OutgoingMessageService(
      db,
      (id) => outgoingScheduler.enqueue(id),
      undefined,
      undefined,
      undefined,
      undefined,
      storage,
      config,
    );
    state.sent = [];
    const before = await peer();
    for (const name of ["server", "maildock"]) {
      const result = await outgoing.create({
        accountId: state[name],
        to: "recipient@fixture.test",
        subject: `R16 ${name}`,
        plainText: "Original immutable MIME",
      });
      state.sent.push(result.id);
      await until(
        async () =>
          (
            await sql`select status,sent_copy_status from outgoing_messages where id=${result.id}`
          )[0].status === "sent",
      );
      await until(async () =>
        ["saved", "not_required"].includes(
          (
            await sql`select sent_copy_status from outgoing_messages where id=${result.id}`
          )[0].sent_copy_status,
        ),
      );
    }
    const after = await peer();
    assert.equal(after.smtp - before.smtp, 2);
    assert.equal(after.append - before.append, 1);
    assert.equal(after.appendDigests.at(-1), after.smtpDigests.at(-1));
    state.mutationsBeforeRestart = {
      append: after.append,
      store: after.store,
      move: after.move,
      smtp: after.smtp,
    };
  } else if (phase === "uncertain") {
    await peer({ drop: "MOVE" });
    await command(7, "archive", "failed");
    const before = await peer();
    await peer({ drop: "APPEND" });
    const outgoing = new OutgoingMessageService(
      db,
      (id) => outgoingScheduler.enqueue(id),
      undefined,
      undefined,
      undefined,
      undefined,
      storage,
      config,
    );
    const result = await outgoing.create({
      accountId: state.maildock,
      to: "recipient@fixture.test",
      subject: "R16 uncertain APPEND",
      plainText: "Exact uncertain MIME",
    });
    await until(
      async () =>
        ["saving", "uncertain"].includes(
          (
            await sql`select sent_copy_status from outgoing_messages where id=${result.id}`
          )[0].sent_copy_status,
        ) && (await peer()).append === before.append + 1,
    );
    const [row] =
      await sql`select receiving_attempt from outgoing_messages where id=${result.id}`;
    state.uncertain = result.id;
    state.uncertainAttempt = row.receiving_attempt.id;
    const after = await peer();
    state.mutationsBeforeRestart = {
      append: after.append,
      store: after.store,
      move: after.move,
      smtp: after.smtp,
    };
  } else if (phase === "pause-attachment") {
    const s = await source(1, state.server);
    await content.request(state.server, s.mailbox_id, s.message_id);
    await until(
      async () =>
        (await content.detail(state.server, s.mailbox_id, s.message_id)).content
          .status === "ready",
    );
    const [row] =
      await sql`select id from message_attachments where message_id=${s.message_id} and filename='large.bin'`;
    state.restartAttachment = row.id;
    const paused = (await peer()).pausedAttachment;
    await peer({ pauseAttachment: true });
    await attachments.request(row.id);
    await until(
      async () =>
        (
          await sql`select status from message_attachments where id=${row.id}`
        )[0].status === "fetching",
    );
    await until(async () => (await peer()).pausedAttachment > paused);
  } else if (["resume-attachment", "retry-attachment"].includes(phase)) {
    await peer({ pauseAttachment: false });
    let previous;
    if (phase === "retry-attachment") {
      const [failed] =
        await sql`select status,error,receiving_attempt from message_attachments where id=${state.restartAttachment}`;
      assert.equal(failed.status, "failed");
      assert.equal(failed.error, "failed_remote_read");
      previous = failed.receiving_attempt.id;
      await attachments.request(state.restartAttachment);
    }
    await until(
      async () =>
        (
          await sql`select status from message_attachments where id=${state.restartAttachment}`
        )[0].status === "ready",
      120_000,
    );
    const [row] =
      await sql`select receiving_attempt from message_attachments where id=${state.restartAttachment}`;
    if (previous) assert.notEqual(row.receiving_attempt.id, previous);
    else assert.ok(Number(row.receiving_attempt.reads) >= 2);
    const download = await attachments.downloadStream(state.restartAttachment);
    const digest = createHash("sha256");
    let bytes = 0;
    for await (const chunk of download.stream) {
      digest.update(chunk);
      bytes += chunk.length;
    }
    const expected = createHash("sha256");
    const expectedChunk = Buffer.alloc(32768, 97);
    for (let i = 0; i < 3200; i++) expected.update(expectedChunk);
    assert.equal(bytes, 100 * 1024 * 1024);
    assert.equal(digest.digest("hex"), expected.digest("hex"));
  } else if (phase === "quiet") {
    await peer({ action: "arrival", username: "maildock" });
    await until(
      async () =>
        Number(
          (
            await sql`select count(*) from mailbox_messages where mailbox_id=${state.source.mailbox_id} and uid=1025`
          )[0].count,
        ) === 1,
      45_000,
    );
    await peer({
      action: "flags",
      username: "maildock",
      uid: 10,
      flags: ["\\Flagged"],
    });
    await peer({ action: "delete", username: "maildock", uid: 11 });
    // Allow the finite 128-UID sweep to revisit the exact page; no wake is sent.
    await until(
      async () =>
        (
          await sql`select flags from mailbox_messages where mailbox_id=${state.source.mailbox_id} and uid=10`
        )[0].flags.includes("\\Flagged"),
      180_000,
    );
    await until(
      async () =>
        Number(
          (
            await sql`select count(*) from mailbox_messages where mailbox_id=${state.source.mailbox_id} and uid=11`
          )[0].count,
        ) === 0,
      180_000,
    );
  } else if (phase === "restart") {
    await until(
      async () =>
        (
          await sql`select expires_at>clock_timestamp() as live from receiving_coordinator`
        )[0].live,
    );
    if (state.uncertain) {
      await until(
        async () =>
          (
            await sql`select sent_copy_status from outgoing_messages where id=${state.uncertain}`
          )[0].sent_copy_status === "saved",
      );
      const [row] =
        await sql`select receiving_attempt from outgoing_messages where id=${state.uncertain}`;
      assert.equal(row.receiving_attempt.id, state.uncertainAttempt);
    }
    const after = await peer();
    for (const key of ["append", "store", "move", "smtp"])
      assert.equal(after[key], state.mutationsBeforeRestart[key]);
    assert.equal(after.maxPerAccount, 1);
    assert.ok(after.maxActive <= 2);
  } else throw new Error("Unknown smoke phase");
  await writeFile(statePath, JSON.stringify(state, null, 2));
  console.log(
    JSON.stringify({
      phase,
      result: "PASS",
      ms: performance.now() - started,
      measurements,
      peer: await peer(),
    }),
  );
} finally {
  clearTimeout(watchdog);
  await discovery?.stop();
  await database.client.end({ timeout: 0 });
  // PgBossOutgoingScheduler intentionally has no stop API in the web singleton.
  // This one-shot fixture process must not retain its pg-boss maintenance timers.
  setTimeout(() => process.exit(process.exitCode ?? 0), 10).unref();
}
