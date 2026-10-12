import { Lane } from "./client.js";
import { Store } from "./store.js";
import { generate } from "./fixture.js";
const mode = process.argv[2] ?? "ready";
if (mode === "generate")
  console.log(JSON.stringify(await generate(Number(process.argv[3] ?? 50000))));
else if (mode === "ready") {
  const store = new Store();
  await store.setup();
  const [settings] =
    await store.sql`select current_database(),current_user,current_setting('fsync') fsync,current_setting('synchronous_commit') synchronous_commit,current_setting('full_page_writes') full_page_writes,version()`;
  let lane: Lane | undefined;
  try {
    for (let i = 0; i < 20; i++) {
      try {
        lane = await Lane.open();
        break;
      } catch (error) {
        if (i === 19) throw error;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    console.log(
      JSON.stringify({ settings, epoch: String(lane!.epoch.uidValidity) }),
    );
  } finally {
    await lane?.close();
    await store.close();
  }
}
