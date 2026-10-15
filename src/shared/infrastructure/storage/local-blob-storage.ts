import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, stat, opendir } from "node:fs/promises";
import path from "node:path";
import {
  BlobLimitError,
  type BlobStorage,
  type StoredBlob,
} from "../../application/blob-storage";

export class LocalBlobStorage implements BlobStorage {
  constructor(private readonly root: string) {
    if (!path.isAbsolute(root)) throw Error("Blob root must be absolute.");
  }
  private location(key: string) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        key,
      )
    )
      throw Error("Invalid blob key.");
    return path.join(this.root, "blobs", key.slice(0, 2), key);
  }
  async put(
    source: AsyncIterable<Uint8Array>,
    maxBytes: number,
  ): Promise<StoredBlob> {
    const key = randomUUID();
    const destination = this.location(key);
    const tmp = path.join(this.root, "tmp");
    await mkdir(tmp, { recursive: true, mode: 0o700 });
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = path.join(tmp, randomUUID());
    const handle = await open(temporary, "wx", 0o600);
    const hash = createHash("sha256");
    let size = 0;
    try {
      for await (const chunk of source) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > maxBytes) throw new BlobLimitError();
        hash.update(bytes);
        let offset = 0;
        while (offset < bytes.length) {
          const result = await handle.write(
            bytes,
            offset,
            bytes.length - offset,
          );
          if (!result.bytesWritten) throw Error("Blob write failed.");
          offset += result.bytesWritten;
        }
      }
      await handle.sync();
      await handle.close();
      await rename(temporary, destination);
      // Persist the directory entry on filesystems supporting directory fsync.
      if (process.platform !== "win32") {
        const directory = await open(path.dirname(destination), "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
      return { key, size, sha256: hash.digest("hex") };
    } finally {
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
  async open(key: string) {
    const location = this.location(key);
    const handle = await open(location, "r");
    return handle.createReadStream();
  }
  async exists(key: string) {
    try {
      return (await stat(this.location(key))).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  async delete(key: string) {
    await rm(this.location(key), { force: true });
  }

  /** Maintenance seam only: ALL web/worker/storage writers must be stopped for
   * the entire call. The callback must check the durable blobs registry, retaining
   * even unreferenced registered keys (draft/outgoing snapshots may share them).
   * Never call this on an elected heartbeat or use age as publication authority. */
  async reclaimWhileQuiescent(isRegistered: (key: string) => Promise<boolean>) {
    let temporary = 0,
      finalized = 0;
    const entries = async function* (directory: string) {
      let dir;
      try {
        dir = await opendir(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for await (const entry of dir) yield entry;
    };
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    for await (const entry of entries(path.join(this.root, "tmp"))) {
      if (!entry.isFile() || !uuid.test(entry.name)) continue;
      await rm(path.join(this.root, "tmp", entry.name));
      temporary++;
    }
    for await (const shard of entries(path.join(this.root, "blobs"))) {
      if (!shard.isDirectory() || !/^[0-9a-f]{2}$/.test(shard.name)) continue;
      for await (const entry of entries(
        path.join(this.root, "blobs", shard.name),
      )) {
        if (
          !entry.isFile() ||
          !uuid.test(entry.name) ||
          entry.name.slice(0, 2) !== shard.name
        )
          continue;
        if (await isRegistered(entry.name)) continue;
        await this.delete(entry.name);
        finalized++;
      }
    }
    return { temporary, finalized };
  }
}
