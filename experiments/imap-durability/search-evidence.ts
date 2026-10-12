import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { fixture } from "../imap-transport/fixture.js";
import { TransportExperiment } from "../imap-transport/hardening.js";
import { Lane } from "./client.js";
const results = [];
for (const complete of [false, true]) {
  const ca = await readFile(
    new URL("../imap-transport/localhost-cert.pem", import.meta.url),
  );
  const lane = new Lane(ca);
  const peer = await fixture(
    (remote, command) => {
      if (command.command.startsWith("UID SEARCH")) {
        if (complete) remote.send("* SEARCH\r\n", command);
        remote.ok(command);
        return true;
      }
      return false;
    },
    {
      logger: lane.client.options.logger,
      maxLineLength: 256 * 1024,
      maxLiteralSize: 256 * 1024,
      maxResponseSize: 2 * 1024 * 1024,
    },
  );
  try {
    lane.client = await peer.connect();
    lane.transport = new TransportExperiment(lane.client);
    assert(lane.client.mailbox);
    lane.epoch = {
      path: "INBOX",
      uidValidity: lane.client.mailbox.uidValidity,
    };
    if (complete) assert.deepEqual(await lane.exactSearch([9]), []);
    else
      await assert.rejects(
        lane.exactSearch([9]),
        /without complete membership SEARCH/,
      );
    results.push({
      complete,
      status: "PASS",
      searchResponses: lane.searchResponses,
      operations: lane.operations,
      commands: peer.commands,
    });
  } finally {
    await lane.close();
    await peer.cleanup();
  }
}
await writeFile(
  new URL("outputs/search-evidence.json", import.meta.url),
  JSON.stringify(
    {
      fixture: "existing scripted TLS peer, supplemental to real Dovecot",
      results,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify(
    results.map((r) => ({
      complete: r.complete,
      status: r.status,
      searchResponses: r.searchResponses,
    })),
  ),
);
