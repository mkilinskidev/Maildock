import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalBlobStorage } from "@/shared/infrastructure/storage/local-blob-storage";
import { readVerifiedBlob } from "@/shared/application/blob-storage";
import { parseConfig } from "@/shared/infrastructure/config/config";
import {
  safeFilename,
  downloadDisposition,
} from "@/modules/mail/domain/attachments";

describe("local immutable blob storage", () => {
  let root: string, storage: LocalBlobStorage;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "maildock-blob-"));
    storage = new LocalBlobStorage(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  it("uses ATTACHMENTS_PATH and returns authoritative size/hash with opaque keys", async () => {
    const config = parseConfig({
      APP_ORIGIN: "http://localhost",
      POSTGRES_PASSWORD: "unused-test-password",
      AUTH_SECRET: Buffer.alloc(32).toString("base64"),
      CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
      ATTACHMENTS_PATH: root,
    });
    storage = new LocalBlobStorage(config.attachmentsPath);
    const bytes = Buffer.from([0, 1, 255, 10]);
    const blob = await storage.put(
      Readable.from([bytes.subarray(0, 2), bytes.subarray(2)]),
      100,
    );
    expect(blob.size).toBe(4);
    expect(blob.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(blob.key).toMatch(/^[a-f0-9-]{36}$/);
    expect(await readVerifiedBlob(storage, blob, 100)).toEqual(bytes);
    expect(await storage.exists(blob.key)).toBe(true);
    await storage.delete(blob.key);
    expect(await storage.exists(blob.key)).toBe(false);
    await storage.delete(blob.key);
    expect(await readdir(path.join(root, "tmp"))).toEqual([]);
  });
  it.each([
    "../invoice.pdf",
    "/etc/passwd",
    "C:\\secrets",
    "..\\..\\x",
    "％２ｅ％２ｅ/file",
    "\u202e/file",
  ])("never accepts a filename/path as an opaque key: %s", async (value) => {
    expect(safeFilename(value)).not.toMatch(/[\\/]/);
    await expect(storage.open(value)).rejects.toThrow();
    await expect(storage.exists(value)).rejects.toThrow();
    await expect(storage.delete(value)).rejects.toThrow();
  });
  it("publishes only after EOF and clears interrupted temporary writes", async () => {
    async function* source() {
      yield Buffer.from("partial");
      expect(await readdir(path.join(root, "blobs"))).toHaveLength(1);
      const shard = (await readdir(path.join(root, "blobs")))[0];
      expect(await readdir(path.join(root, "blobs", shard))).toEqual([]);
      throw Error("interrupted");
    }
    await expect(storage.put(source(), 100)).rejects.toThrow("interrupted");
    expect(await readdir(path.join(root, "tmp"))).toEqual([]);
    for (const shard of await readdir(path.join(root, "blobs")))
      expect(await readdir(path.join(root, "blobs", shard))).toEqual([]);
  });
  it("rejects actual stream overflow and accepts exactly the limit", async () => {
    await expect(
      storage.put(Readable.from([Buffer.alloc(5), Buffer.alloc(6)]), 10),
    ).rejects.toThrow("size limit");
    expect(await readdir(path.join(root, "tmp"))).toEqual([]);
    expect(
      (await storage.put(Readable.from([Buffer.alloc(10)]), 10)).size,
    ).toBe(10);
  });
  it("detects corruption, truncation and missing blobs", async () => {
    const blob = await storage.put(Readable.from([Buffer.from("good")]), 10);
    const location = path.join(root, "blobs", blob.key.slice(0, 2), blob.key);
    await writeFile(location, "evil");
    await expect(readVerifiedBlob(storage, blob, 10)).rejects.toThrow(
      "integrity",
    );
    await writeFile(location, "g");
    await expect(readVerifiedBlob(storage, blob, 10)).rejects.toThrow(
      "integrity",
    );
    await storage.delete(blob.key);
    await expect(readVerifiedBlob(storage, blob, 10)).rejects.toThrow();
  });
  it("provides forced, injection-safe Unicode Content-Disposition", () => {
    const header = downloadDisposition("Zażółć.pdf\r\nX-Evil: yes\x00");
    expect(header).toMatch(/^attachment;/);
    expect(header).not.toMatch(/[\r\n\x00]/);
    expect(header).toContain("filename*=UTF-8''Za%C5%BC%C3%B3%C5%82%C4%87.pdf");
    expect(downloadDisposition(null)).toContain('filename="Attachment"');
    expect(() => downloadDisposition("\ud800.pdf")).not.toThrow();
  });
});
