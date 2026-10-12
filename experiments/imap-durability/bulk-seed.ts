import assert from "node:assert/strict";
import { Lane } from "./client.js";
import { exec, compose } from "./support.js";
const account = process.argv[2];
assert(["p3-load-0", "p3-load-1"].includes(account));
const lane = await Lane.open(true, "INBOX", account);
const count = lane.client.mailbox && lane.client.mailbox.exists;
await lane.close();
assert(
  count === 0 || count === 50000,
  "Refuse to overwrite or duplicate a partial/nonempty fixture",
);
if (count === 0)
  await exec(
    "docker",
    [
      ...compose,
      "exec",
      "-T",
      "dovecot",
      "sh",
      "/tmp/phase3-import.sh",
      account,
    ],
    { timeout: 900000, maxBuffer: 1024 * 1024 },
  );
await exec("docker", [
  ...compose,
  "exec",
  "-T",
  "dovecot",
  "doveadm",
  "index",
  "-u",
  account,
  "INBOX",
]);
console.log(JSON.stringify({ account, alreadySeeded: count === 50000 }));
