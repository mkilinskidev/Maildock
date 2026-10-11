import { z } from "zod";

export function publicationRequest(url: URL) {
  const readerId = url.searchParams.get("readerId");
  return {
    revision: z
      .string()
      .max(128)
      .optional()
      .parse(url.searchParams.get("revision") ?? undefined),
    reader: readerId
      ? {
          id: z.uuid().parse(readerId),
          accountId: z.uuid().parse(url.searchParams.get("readerAccountId")),
          mailboxId: z.uuid().parse(url.searchParams.get("readerMailboxId")),
        }
      : undefined,
  };
}
