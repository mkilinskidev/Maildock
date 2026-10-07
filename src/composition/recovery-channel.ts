import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { RecoveryError } from "../shared/infrastructure/database/restore-verification";

// Production Linux local operator mount: directory 0700 owned by UID 1001.
// Refuse Windows's non-POSIX permission semantics rather than pretending 0600
// establishes a restrictive Windows ACL. Never accept a symlink or stdout.
export async function privateChannelPath(file: string) {
  if (process.platform === "win32" || !path.isAbsolute(file))
    throw new RecoveryError("recovery_channel");
  const parent = path.dirname(file);
  const info = await lstat(parent);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid?.() ||
    (await realpath(parent)) !== parent
  )
    throw new RecoveryError("recovery_channel");
  return file;
}

export async function openPrivateOutput(file: string) {
  await privateChannelPath(file);
  return open(
    file,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
}

export async function readPrivateInput(file: string) {
  await privateChannelPath(file);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      (info.mode & 0o077) !== 0 ||
      info.uid !== process.getuid?.() ||
      info.size > 16_384
    )
      throw new RecoveryError("recovery_channel");
    return JSON.parse(await handle.readFile("utf8")) as unknown;
  } finally {
    await handle.close();
  }
}
