import { Lane } from "./client.js";
import { generate } from "./fixture.js";
import { verify } from "./model.js";
const command = process.argv[2];
if (command === "generate")
  console.log(JSON.stringify(await generate(Number(process.argv[3] ?? 100))));
else if (command === "verify")
  console.log(JSON.stringify(await verify(Number(process.argv[3] ?? 100))));
else if (command === "cleanup") {
  const lane = await Lane.open();
  try {
    const uids = await lane.op("FIND FIXTURE ARRIVALS", async () => {
      const r = await lane.client.search(
        { header: { "Message-ID": "arrival-2403-" } },
        { uid: true },
      );
      if (!Array.isArray(r) || r.length > 100)
        throw new Error("Unsafe fixture cleanup set");
      return r;
    });
    if (uids.length)
      await lane.op("REMOVE FIXTURE ARRIVALS", async () => {
        if (!(await lane.client.messageDelete(uids, { uid: true })))
          throw new Error("Cleanup failed");
      });
    console.log(JSON.stringify({ removedFixtureArrivals: uids }));
  } finally {
    await lane.close();
  }
} else if (command === "ready" || command === "empty") {
  const lane = await Lane.open();
  if (
    command === "empty" &&
    lane.client.mailbox &&
    lane.client.mailbox.exists !== 0
  ) {
    await lane.close();
    throw new Error("Fixture already populated");
  }
  console.log(
    JSON.stringify({
      ready: true,
      epoch: String(lane.epoch.uidValidity),
      count: lane.client.mailbox && lane.client.mailbox.exists,
      uidNext: lane.client.mailbox && lane.client.mailbox.uidNext,
      capabilities: [...lane.client.capabilities.keys()],
    }),
  );
  await lane.close();
} else throw new Error("Use ready or generate COUNT");
