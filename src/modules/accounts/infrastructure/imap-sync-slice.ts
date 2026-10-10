import type { FetchMessageObject } from "imapflow";
import type { ImapClient } from "./imap-smtp-mail-provider";
import { assertImapHealthy } from "./imap-client-lifecycle";
import {
  MailboxEpochChangedError,
  type RemoteMessageMetadata,
} from "../domain/mail-provider";
import type { ImapSliceLimits, ImapSliceSink } from "../domain/imap-sync-slice";

/** Fully drain each bounded protocol request before doing database work. */
export async function executeImapSlice(
  client: ImapClient,
  path: string,
  phase: "recent" | "delta",
  limits: ImapSliceLimits,
  sink: ImapSliceSink,
  normalize: (message: FetchMessageObject) => RemoteMessageMetadata,
  signal?: AbortSignal,
): Promise<boolean> {
  let stopped = false;
  const stop = () => {
    stopped = true;
    try {
      client.close();
    } catch {
      /* The first failure remains authoritative. */
    }
  };
  const timer = setTimeout(stop, limits.timeoutMs);
  timer.unref();
  signal?.addEventListener("abort", stop, { once: true });
  const check = () => {
    if (stopped || signal?.aborted)
      throw new Error("IMAP slice cancelled or timed out.");
    assertImapHealthy(client);
  };
  const fetch = async (
    range: string,
    query: Parameters<ImapClient["fetch"]>[1],
  ) => {
    check();
    const result: FetchMessageObject[] = [];
    const iterator = client.fetch(range, query, { uid: true });
    try {
      for (;;) {
        const next = await iterator.next();
        check();
        if (next.done) {
          if (next.value === false) throw new Error("IMAP FETCH failed.");
          break;
        }
        result.push(next.value);
        if (
          result.length > range.split(",").length ||
          result.slice(0, -1).some((item) => item.uid === next.value.uid)
        )
          throw new Error("IMAP FETCH exceeded requested bounds.");
      }
    } finally {
      await iterator.return(undefined);
    }
    return result;
  };
  const search = async (uids: string, cutoff?: string | null) => {
    check();
    const result = await client.search(
      { uid: uids, ...(cutoff ? { since: new Date(cutoff) } : {}) },
      { uid: true },
    );
    check();
    if (
      !Array.isArray(result) ||
      result.some(
        (uid) => !Number.isSafeInteger(uid) || uid < 1 || uid > 0xffffffff,
      )
    )
      throw new Error("IMAP UID search failed.");
    return result;
  };
  try {
    check();
    await client.connect();
    check();
    const selected = await client.mailboxOpen(path, { readOnly: true });
    check();
    if (
      !Number.isSafeInteger(selected.uidNext) ||
      selected.uidNext! < 1 ||
      selected.uidNext! > 0xffffffff
    )
      throw new Error("IMAP UID horizon unavailable.");
    const epoch = selected.uidValidity.toString();
    if (selected.uidValidity < 1n || selected.uidValidity > 0xffffffffn)
      throw new Error("Invalid IMAP UIDVALIDITY.");
    const condstore =
      !selected.noModseq &&
      (client.capabilities.has("CONDSTORE") || client.enabled.has("CONDSTORE"));
    const progress = {
      ...(await sink.selected(
        epoch,
        String(selected.uidNext! - 1),
        condstore ? (selected.highestModseq?.toString() ?? null) : null,
      )),
    };
    check();
    if (progress.uidValidity !== epoch) throw new MailboxEpochChangedError();
    if (progress.phase === "messages") {
      const start = BigInt(progress.cursor) + 1n;
      const frontier = BigInt(progress.frontier);
      if (start <= frontier) {
        const end =
          start + BigInt(limits.uidSpan) - 1n < frontier
            ? start + BigInt(limits.uidSpan) - 1n
            : frontier;
        const uids = await search(`${start}:${end}`, progress.cutoff);
        if (
          uids.length > limits.uidSpan ||
          new Set(uids).size !== uids.length ||
          uids.some((uid) => BigInt(uid) < start || BigInt(uid) > end)
        )
          throw new Error("IMAP search exceeded requested range.");
        for (let offset = 0; offset < uids.length; offset += limits.batchSize) {
          const group = uids.slice(offset, offset + limits.batchSize);
          const batch = await fetch(group.join(","), {
            uid: true,
            flags: true,
            envelope: true,
            headers: ["references"],
            bodyStructure: true,
            internalDate: true,
            size: true,
            modseq: true,
            emailId: true,
          });
          if (batch.some((item) => !group.includes(item.uid)))
            throw new Error("Unexpected fetched UID.");
          const absent = group.filter(
            (uid) => !batch.some((item) => item.uid === uid),
          );
          // A SEARCH/FETCH race must not skip an unfetched live message.
          if (
            absent.length &&
            ((await search(absent.join(","))).length ||
              (await fetch(absent.join(","), { uid: true })).length)
          )
            throw new Error("Unfetched UID remains present.");
          await sink.messages(batch.map(normalize));
          check();
          progress.messageCount += batch.length;
        }
        progress.cursor = end.toString();
      }
      if (BigInt(progress.cursor) >= BigInt(progress.frontier))
        progress.phase = "reconcile";
    } else if (phase === "delta") {
      const group = await sink.localUids(
        progress.localCursor,
        progress.frontier,
        limits.batchSize,
      );
      check();
      if (group.length) {
        // Conservative per-UID flag reconciliation works even if capabilities change
        // on reconnect. No intermediate CHANGEDSINCE/MODSEQ advancement is needed.
        const batch = await fetch(group.join(","), {
          uid: true,
          flags: true,
          modseq: true,
        });
        if (batch.some((item) => !group.includes(String(item.uid))))
          throw new Error("Unexpected fetched UID.");
        const missing = group.filter(
          (uid) => !batch.some((item) => String(item.uid) === uid),
        );
        if (
          missing.length &&
          ((await search(missing.join(","))).length ||
            (await fetch(missing.join(","), { uid: true })).length)
        )
          throw new Error("UID absence confirmation failed.");
        await sink.flags(
          batch.map((item) => ({
            uid: String(item.uid),
            flags: [...(item.flags ?? [])],
            ...(item.modseq === undefined
              ? {}
              : { modseq: item.modseq.toString() }),
          })),
        );
        check();
        // Validate the epoch before irreversible membership removal.
        await status();
        await sink.removed(missing);
        check();
        progress.localCursor = group[group.length - 1];
      } else {
        const observation = await status();
        await sink.completed(progress, observation);
        check();
        return false;
      }
    }
    const observation = await status();
    if (phase === "recent" && progress.phase === "reconcile") {
      await sink.completed(progress, observation);
      check();
      return false;
    }
    await sink.checkpoint(progress);
    check();
    return true;

    async function status() {
      check();
      if (!client.status) throw new Error("IMAP STATUS unavailable.");
      const value = await client.status(path, {
        messages: true,
        unseen: true,
        uidNext: true,
        uidValidity: true,
      });
      check();
      if (!value) throw new Error("IMAP STATUS observation failed.");
      if (value.uidValidity !== BigInt(epoch))
        throw new MailboxEpochChangedError();
      if (
        !Number.isSafeInteger(value.messages) ||
        value.messages! < 0 ||
        !Number.isSafeInteger(value.unseen) ||
        value.unseen! < 0 ||
        value.unseen! > value.messages! ||
        !Number.isSafeInteger(value.uidNext) ||
        value.uidNext! < 1 ||
        value.uidNext! > 0xffffffff
      )
        throw new Error("IMAP STATUS observation failed.");
      return {
        uidNext: String(value.uidNext),
        messageCount: String(value.messages),
        unseenCount: String(value.unseen),
      };
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    // Read-only SELECT: closing the socket releases server selection without
    // introducing unbounded CLOSE/LOGOUT requests during cancellation.
    client.close();
  }
}
