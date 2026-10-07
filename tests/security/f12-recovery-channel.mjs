// Runs as UID 1001 in the actual production image; no secret output.
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  chmod,
  symlink,
  link,
  stat,
  writeFile,
  rm,
} from "node:fs/promises";
import {
  openPrivateOutput,
  readPrivateInput,
} from "./dist-worker/composition/recovery-channel.js";
const root = await mkdtemp("/tmp/maildock-private-channel-");
try {
  await chmod(root, 0o700);
  const file = `${root}/receipt.json`;
  const handle = await openPrivateOutput(file);
  await handle.writeFile(
    JSON.stringify({
      receiptId: "synthetic",
      recoveryCodes: ["channel-canary"],
    }),
  );
  await handle.sync();
  await handle.close();
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await readPrivateInput(file)).receiptId, "synthetic");
  await assert.rejects(openPrivateOutput(file));
  await assert.rejects(openPrivateOutput("relative.json"));
  await symlink(file, `${root}/file-link.json`);
  await assert.rejects(readPrivateInput(`${root}/file-link.json`));
  await link(file, `${root}/hard-link.json`);
  await assert.rejects(readPrivateInput(file));
  await rm(`${root}/hard-link.json`);
  await mkdir(`${root}/public`, { mode: 0o755 });
  await assert.rejects(openPrivateOutput(`${root}/public/receipt.json`));
  await symlink(root, `${root}/directory-link`);
  await assert.rejects(openPrivateOutput(`${root}/directory-link/new.json`));
  await chmod(file, 0o644);
  await assert.rejects(readPrivateInput(file));
  await chmod(file, 0o600);
  await writeFile(file, "x".repeat(16385));
  await assert.rejects(readPrivateInput(file));
  console.log("Protected recovery channel assertions passed.");
} finally {
  await rm(root, { recursive: true, force: true });
}
