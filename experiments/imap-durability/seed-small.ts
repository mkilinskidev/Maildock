import { fixture, oracle } from "./support.js";
import { Lane } from "./client.js";
import assert from "node:assert/strict";
for (let i = 2; i < 8; i++) {
  const account = "p3-load-" + i,
    lane = await Lane.open(true, "INBOX", account),
    count = lane.client.mailbox && lane.client.mailbox.exists;
  await lane.close();
  assert(count === 0 || count === 256);
  if (count === 0) await fixture(account, 256);
}
for (let i = 0; i < 8; i++) {
  const r = await oracle("p3-load-" + i);
  console.log(
    JSON.stringify({
      account: "p3-load-" + i,
      count: r.rows.length,
      epoch: r.epoch,
      next: r.next,
    }),
  );
}
