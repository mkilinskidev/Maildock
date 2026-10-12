import { readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { cpus, totalmem, platform, arch } from "node:os";
import { exec, compose } from "./support.js";
const hashes: Record<string, string> = {};
for (const file of (await readdir(new URL("./", import.meta.url))).filter((f) =>
  /\.(ts|sql|yaml|ps1|sh)$/.test(f),
))
  hashes[file] = createHash("sha256")
    .update(await readFile(new URL(file, import.meta.url)))
    .digest("hex");
for (const file of [
  "imapflow/dist/esm/imap-flow.js",
  "imapflow/dist/esm/commands/search.js",
  "imapflow/dist/esm/commands/fetch.js",
  "imapflow/dist/esm/handler/imap-stream.js",
  "imapflow/dist/esm/handler/token-parser.js",
  "postgres/src/index.js",
  "postgres/src/connection.js",
])
  hashes[file] = createHash("sha256")
    .update(
      await readFile(new URL("../../node_modules/" + file, import.meta.url)),
    )
    .digest("hex");
for (const [name, url] of [
  ["phase2-dovecot.conf", "../imap-dovecot/dovecot.conf"],
  ["phase3-public-tls.crt", ".runtime/tls/tls.crt"],
  ["Dockerfile.network", "Dockerfile.network"],
] as const)
  hashes[name] = createHash("sha256")
    .update(await readFile(new URL(url, import.meta.url)))
    .digest("hex");
const index = [];
for (const name of (await readdir(new URL("outputs/", import.meta.url))).filter(
  (f) => f !== "environment.json" && /\.(json|gz)$/.test(f),
)) {
  const data = await readFile(new URL("outputs/" + name, import.meta.url));
  index.push({
    name,
    bytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
  });
}
const capture = async (cmd: string, args: string[]) => {
  try {
    return (await exec(cmd, args, { maxBuffer: 2 * 1024 * 1024 })).stdout;
  } catch (error) {
    return String(error);
  }
};
const result = {
  at: new Date().toISOString(),
  branch: await capture("git", ["branch", "--show-current"]),
  base: "8c4f9790999f850b4dd2f4365a408d24671bb575",
  node: process.version,
  platform: platform(),
  arch: arch(),
  cpu: cpus()[0]?.model,
  logicalCpus: cpus().length,
  totalmem: totalmem(),
  seed: 2403,
  versions: Object.fromEntries(
    await Promise.all(
      ["imapflow", "postgres", "tsx", "typescript"].map(async (p) => [
        p,
        JSON.parse(
          await readFile(
            new URL(
              "../../node_modules/" + p + "/package.json",
              import.meta.url,
            ),
            "utf8",
          ),
        ).version,
      ]),
    ),
  ),
  docker: await capture("docker", ["version"]),
  compose: await capture("docker", ["compose", "version"]),
  images: await capture("docker", [
    "inspect",
    "maildock-imap-durability-dovecot-1",
    "maildock-imap-durability-postgres-1",
    "--format",
    "{{.Name}} {{.Config.Image}} {{.Image}}",
  ]),
  helper: await capture("docker", [
    "image",
    "inspect",
    "maildock-phase3-netem:local",
    "--format",
    "{{.Id}}",
  ]),
  database: await capture("docker", [
    ...compose,
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "phase3",
    "-d",
    "phase3",
    "-Atc",
    "select version(), current_setting('fsync'),current_setting('synchronous_commit'),current_setting('full_page_writes')",
  ]),
  hashes,
  index,
};
await writeFile(
  new URL("outputs/environment.json", import.meta.url),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(
  JSON.stringify({ files: index.length, hashes: Object.keys(hashes).length }),
);
