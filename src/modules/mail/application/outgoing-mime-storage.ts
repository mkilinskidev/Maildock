import { eq } from "drizzle-orm";
import type { Database } from "../../../shared/infrastructure/database/database";
import { blobs } from "../../../shared/infrastructure/database/schema";
import {
  readVerifiedBlob,
  type BlobStorage,
} from "../../../shared/application/blob-storage";
import { storedBlob } from "./attachment-service";

export async function loadOutgoingMime(
  db: Database,
  storage: BlobStorage | undefined,
  row: { mimeBlobId: string | null; mimeBase64: string | null },
  maxBytes: number,
): Promise<Buffer> {
  if (row.mimeBlobId) {
    if (!storage) throw Error("MIME storage is unavailable.");
    const [blob] = await db
      .select()
      .from(blobs)
      .where(eq(blobs.id, row.mimeBlobId));
    if (!blob) throw Error("MIME blob metadata is unavailable.");
    return readVerifiedBlob(storage, storedBlob(blob), maxBytes);
  }
  if (!row.mimeBase64 || row.mimeBase64.length > Math.ceil(maxBytes / 3) * 4)
    throw Error("Legacy MIME is unavailable.");
  const bytes = Buffer.from(row.mimeBase64, "base64");
  if (bytes.length > maxBytes || bytes.toString("base64") !== row.mimeBase64)
    throw Error("Legacy MIME is invalid.");
  return bytes;
}
