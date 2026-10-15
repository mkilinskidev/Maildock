import type { Readable } from "node:stream";
import { createHash } from "node:crypto";

export type StoredBlob = Readonly<{
  key: string;
  size: number;
  sha256: string;
}>;
/** Opaque immutable objects. Filenames and mail semantics never enter this port. */
export interface BlobStorage {
  put(source: AsyncIterable<Uint8Array>, maxBytes: number): Promise<StoredBlob>;
  open(key: string): Promise<Readable>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}
export class BlobLimitError extends Error {
  constructor() {
    super("Attachment or message exceeds the configured size limit.");
  }
}

/** Integrity verification with constant retained buffers, including cancellation. */
export async function verifyBlob(
  storage: BlobStorage,
  blob: StoredBlob,
  maxBytes: number,
  signal?: AbortSignal,
) {
  if (!Number.isSafeInteger(blob.size) || blob.size > maxBytes || blob.size < 0)
    throw new BlobLimitError();
  signal?.throwIfAborted();
  const stream = await storage.open(blob.key);
  const abort = () => stream.destroy(new Error("Blob verification cancelled"));
  signal?.addEventListener("abort", abort, { once: true });
  const hash = createHash("sha256");
  let size = 0;
  try {
    signal?.throwIfAborted();
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      size += chunk.length;
      if (size > blob.size || size > maxBytes) throw new BlobLimitError();
      hash.update(chunk);
    }
    if (size !== blob.size || hash.digest("hex") !== blob.sha256)
      throw new Error("Blob integrity check failed.");
  } finally {
    signal?.removeEventListener("abort", abort);
    stream.destroy();
  }
}

export async function readVerifiedBlob(
  storage: BlobStorage,
  blob: StoredBlob,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (blob.size > maxBytes || blob.size < 0) throw new BlobLimitError();
  const stream = await storage.open(blob.key);
  const abort = () => stream.destroy(new Error("Blob read cancelled"));
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    const chunks: Buffer[] = [];
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes || size > blob.size) throw new BlobLimitError();
      hash.update(bytes);
      chunks.push(bytes);
    }
    if (size !== blob.size || hash.digest("hex") !== blob.sha256)
      throw Error("Blob integrity check failed.");
    return Buffer.concat(chunks, size);
  } finally {
    signal?.removeEventListener("abort", abort);
    stream.destroy();
  }
}
