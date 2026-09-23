import { spawn } from "node:child_process";

const role = process.env.MAILDOCK_ROLE ?? "all";
if (!["all", "web", "worker"].includes(role)) {
  console.error("MAILDOCK_ROLE must be one of: all, web, worker.");
  process.exit(1);
}

function child(command, args) {
  const process = spawn(command, args, {
    stdio: "inherit",
    env: globalThis.process.env,
  });
  const exited = new Promise((resolve) => {
    process.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { process, exited };
}

const migration = child("node", [
  "dist-worker/shared/infrastructure/database/migrate.js",
]);
const migrationExit = await migration.exited;
if (migrationExit.code !== 0) process.exit(migrationExit.code ?? 1);

const children = [];
if (role === "all" || role === "web")
  children.push(child("node", ["server.js"]));
if (role === "all" || role === "worker") {
  children.push(child("node", ["dist-worker/composition/worker-process.js"]));
}

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const childProcess of children) childProcess.process.kill(signal);
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

const exit = await Promise.race(
  children.map((childProcess) => childProcess.exited),
);
shutdown("SIGTERM");
await Promise.all(children.map((childProcess) => childProcess.exited));
process.exit(exit.code ?? (exit.signal ? 1 : 0));
