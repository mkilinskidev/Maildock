import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const count = Number(process.argv[2] ?? 50000);
const scope = process.argv[3] ?? "all";
const requestedProfile = process.argv[4];
const runs: object[] = [];
const started = new Date().toISOString();
const compose = ["compose", "-f", "experiments/imap-dovecot/compose.yaml"];
const environment = {
  dockerInfo: (
    await exec(
      "docker",
      [
        "info",
        "--format",
        "Server={{.ServerVersion}} CPUs={{.NCPU}} Memory={{.MemTotal}} OS={{.OperatingSystem}} Arch={{.Architecture}}",
      ],
      { cwd: root },
    )
  ).stdout,
  image: (
    await exec("docker", ["image", "inspect", "dovecot/dovecot:2.4.3-dev"], {
      cwd: root,
    })
  ).stdout,
};
const serverSamples: {
  at: string;
  stats?: string;
  who?: string;
  error?: string;
}[] = [];
let sampling = false;
const timer = setInterval(async () => {
  if (sampling) return;
  sampling = true;
  try {
    const stats = await exec(
      "docker",
      [
        "stats",
        "--no-stream",
        "--format",
        "{{json .}}",
        "maildock-imap-experiment-dovecot-1",
      ],
      { cwd: root },
    );
    const who = await exec(
      "docker",
      [...compose, "exec", "-T", "dovecot", "doveadm", "who"],
      { cwd: root },
    );
    serverSamples.push({
      at: new Date().toISOString(),
      stats: stats.stdout,
      who: who.stdout,
    });
  } catch (e) {
    serverSamples.push({ at: new Date().toISOString(), error: String(e) });
  } finally {
    sampling = false;
  }
}, 5000);
async function run(
  mode: string,
  profile: string,
  trigger: string,
  trial: number,
) {
  const before = new Set(await readdir(new URL("outputs/", import.meta.url)));
  const args = [
    "--import",
    "tsx",
    "experiments/imap-dovecot/benchmark.ts",
    mode,
    String(count),
    profile,
    trigger,
  ];
  console.log(`Starting ${mode} ${profile} ${trigger} trial ${trial}`);
  let failure: string | undefined;
  try {
    await exec(process.execPath, args, {
      cwd: root,
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch (e) {
    failure = String(e);
  }
  const files = (await readdir(new URL("outputs/", import.meta.url))).filter(
    (f) =>
      !before.has(f) &&
      f.endsWith(`-${mode}-${count}-${profile}-${trigger}.json`),
  );
  for (const file of files) {
    const bytes = await readFile(new URL(`outputs/${file}`, import.meta.url));
    await writeFile(
      new URL(`outputs/${file}.gz`, import.meta.url),
      gzipSync(bytes),
    );
    const { lanes, ...r } = JSON.parse(bytes.toString());
    const ops = lanes[0].operations.filter(
      (o: { start: number }) => o.start >= lanes[0].operations[1]?.start,
    );
    const duration = ops
      .map((o: { end: number; start: number }) => o.end - o.start)
      .sort((a: number, b: number) => a - b);
    const summary = {
      ...r,
      trial,
      trace: `${file}.gz`,
      commandCount: lanes.reduce(
        (n: number, l: { commands: unknown[] }) => n + l.commands.length,
        0,
      ),
      occupancyMs: {
        p95: duration[Math.floor(duration.length * 0.95)],
        max: Math.max(...duration),
      },
      aggregateOvershoot: Math.max(
        0,
        ...lanes.flatMap(
          (l: {
            operations: { metrics: { received: number }; kind: string }[];
          }) =>
            l.operations.map(
              (o) =>
                o.metrics.received -
                (o.kind === "FULL UID FLAGS"
                  ? 16 * 1024 * 1024
                  : 2 * 1024 * 1024),
            ),
        ),
      ),
    };
    runs.push(summary);
    console.log(
      JSON.stringify({
        status: r.status,
        completeMs: r.completeMs,
        first128Ms: r.first128Ms,
        peakRss: r.peakRss,
        worstArrivalMs: Math.max(
          0,
          ...(r.arrivals ?? []).map(
            (a: { appendToAvailableMs: number }) => a.appendToAvailableMs,
          ),
        ),
      }),
    );
  }
  await writeFile(
    new URL(
      `outputs/suite-${started.replace(/[:.]/g, "-")}.json`,
      import.meta.url,
    ),
    JSON.stringify({ started, environment, runs, serverSamples }, null, 2) +
      "\n",
  );
  if (failure) throw new Error(failure);
}
try {
  if (scope !== "arrivals")
    for (let trial = 1; trial <= 3; trial++) {
      for (const mode of trial % 2
        ? ["baseline", "progressive"]
        : ["progressive", "baseline"])
        await run(mode, "C1", "fetch", trial);
    }
  for (let trial = 1; trial <= 3; trial++) {
    for (const profile of (trial % 2
      ? ["C1", "C2", "C5-one", "C5-two"]
      : ["C5-two", "C5-one", "C2", "C1"]
    ).filter(
      (p) =>
        !requestedProfile ||
        (requestedProfile === "one-lanes"
          ? p !== "C5-two"
          : p === requestedProfile),
    ))
      await run("arrivals", profile, "fetch", trial);
  }
  if (!requestedProfile)
    for (const profile of ["C1", "C2"])
      for (const trigger of ["search", "after", "waiting", "idle"])
        await run("arrivals", profile, trigger, 1);
} finally {
  clearInterval(timer);
}
