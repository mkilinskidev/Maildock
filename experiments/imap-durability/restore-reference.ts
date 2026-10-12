import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Lane } from "./client.js";
import { generate } from "./fixture.js";
import { exec, compose } from "./support.js";
const account = "p3-load-0",
  lane = await Lane.open(true, "INBOX", account);
assert(lane.client.mailbox);
const before = lane.client.mailbox.exists;
await lane.close();
assert(
  before >= 35000 && before < 50000,
  "Restore only the measured post-15000-deletion Phase 3 account",
);
await generate(15000);
await exec("docker", [
  ...compose,
  "cp",
  fileURLToPath(new URL("fixtures/15000/mailbox.tar", import.meta.url)),
  "dovecot:/tmp/phase3-restore.tar",
]);
await exec("docker", [
  ...compose,
  "exec",
  "-T",
  "dovecot",
  "sh",
  "-c",
  "mkdir -p /tmp/phase3-restore; tar -xf /tmp/phase3-restore.tar -C /tmp/phase3-restore",
]);
// The only destination is the separate Phase 3 synthetic account. UIDs are
// assigned by Dovecot and never reset/fabricated; the old 15k gap remains real.
await exec(
  "docker",
  [
    ...compose,
    "exec",
    "-T",
    "dovecot",
    "sh",
    "-c",
    'doveadm import -u p3-load-0 maildir:/tmp/phase3-restore "" all',
  ],
  { timeout: 900000 },
);
const afterLane = await Lane.open(true, "INBOX", account);
assert(afterLane.client.mailbox);
const after = afterLane.client.mailbox.exists;
assert.equal(after, before + 15000);
await afterLane.close();
await writeFile(
  new URL("outputs/reference-restoration.json", import.meta.url),
  JSON.stringify(
    {
      at: new Date().toISOString(),
      account,
      before,
      after,
      restored: 15000,
      note: "Server-assigned new UIDs; original expunged UID gap retained",
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify({ before, after }));
