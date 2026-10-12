import { afterEach, describe, expect, it } from "vitest";
import {
  metadataPeer,
  type WindowPeerOptions,
} from "./fixtures/imap-metadata-peer";
import { until } from "../experiments/imap-transport/fixture";
import { fetchInboxMetadataWindow } from "@/modules/accounts/infrastructure/imap-metadata-window";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const expected = {
  epoch: 7n,
  revision: 3n,
  freshThrough: 256n,
  historyBefore: 257n,
  reconcileAfter: 0n,
};
async function run(
  config: WindowPeerOptions = {},
  timeout = 3000,
  signal?: AbortSignal,
  assertCurrent = () => {},
) {
  const peer = await metadataPeer(config);
  cleanups.push(peer.cleanup);
  const promise = fetchInboxMetadataWindow(
    peer.connection,
    expected,
    {
      deadline: performance.now() + timeout,
      signal,
      assertCurrent,
    },
    peer.createClient,
  );
  return { peer, promise };
}

describe("one owned real ImapFlow TLS metadata window", () => {
  it.each([false, true])(
    "dense 128 identities, actual installed entry point CJS=%s",
    async (cjs) => {
      const { peer, promise } = await run({
        cjs,
        uids: Array.from({ length: 128 }, (_, i) => 129 + i),
      });
      const result = await promise;
      expect(result.metadata).toHaveLength(128);
      expect(
        peer.commands.filter((c) => c.command === "SELECT INBOX"),
      ).toHaveLength(1);
      expect(result.evidence).toMatchObject({
        low: 129n,
        high: 256n,
        complete: true,
      });
      expect(
        peer.commands.find((c) => c.command.startsWith("UID SEARCH"))?.command,
      ).toBe("UID SEARCH UID 129:256");
      expect(
        peer.commands.filter((c) => c.command.startsWith("UID FETCH")),
      ).toHaveLength(1);
      expect(peer.observed[0].isClosed).toBe(true);
      await until(() => peer.events.some((e) => e.event === "server-close"));
    },
  );
  it.each([{ uids: [] }, { uids: [129, 211, 256] }])(
    "verified sparse/empty interval %j",
    async ({ uids }) => {
      const { promise, peer } = await run({ uids });
      const result = await promise;
      expect(result.metadata.map((m) => Number(m.uid))).toEqual(uids);
      expect(result.evidence?.searched).toEqual(uids.map(BigInt));
      if (!uids.length)
        expect(
          peer.commands.some((c) => c.command.startsWith("UID FETCH")),
        ).toBe(false);
    },
  );
  it.each(["flags", "sequence"] as const)(
    "legal unsolicited %s never becomes metadata",
    async (fetch) => {
      const { promise } = await run({ fetch });
      expect((await promise).metadata).toHaveLength(2);
    },
  );
  const failures: WindowPeerOptions[] = [
    { search: "absent" },
    { search: "duplicate" },
    { search: "invalid" },
    { search: "esearch" },
    { search: "no" },
    { fetch: "missing" },
    { fetch: "duplicate" },
    { fetch: "unexpected" },
    { fetch: "incomplete" },
    { fetch: "no" },
    { epoch: 8 },
    { select: "missing-next" },
    { uidNext: 200 },
    { fetch: "oversized" },
    {
      fetch: "aggregate",
      uids: Array.from({ length: 128 }, (_, i) => 129 + i),
    },
    ...(
      [
        "flags",
        "envelope",
        "structure",
        "duplicate-field",
        "wrong-section",
        "nil-header",
        "nesting",
        "malformed",
      ] as const
    ).map((raw) => ({ raw })),
  ];
  it.each(failures)(
    "rejects incomplete/malformed/oversized %j",
    async (config) => {
      const { promise, peer } = await run(config);
      await expect(promise).rejects.toThrow();
      expect(peer.observed[0].isClosed).toBe(true);
      await until(() => peer.events.some((e) => e.event === "server-close"));
    },
  );
  it.each([
    { select: "hung" },
    { search: "hung" },
    { fetch: "hung" },
  ] as WindowPeerOptions[])(
    "absolute deadline retires hung %j",
    async (config) => {
      const { promise, peer } = await run(config, 150);
      await expect(promise).rejects.toThrow("deadline");
      await until(() => peer.events.some((e) => e.event === "server-close"));
    },
  );
  it("destructive cancellation before tagged FETCH cannot publish yielded rows", async () => {
    const controller = new AbortController();
    const { promise, peer } = await run(
      { taggedDelay: 1000 },
      3000,
      controller.signal,
    );
    const rejection = expect(promise).rejects.toThrow("cancelled");
    await until(() =>
      peer.commands.some((c) => c.command.startsWith("UID FETCH")),
    );
    controller.abort();
    await rejection;
    await until(() => peer.events.some((e) => e.event === "server-close"));
  });
  it("waits for tagged FETCH, and rejects a revoked caller turn", async () => {
    let valid = true;
    const { promise, peer } = await run(
      { taggedDelay: 80 },
      3000,
      undefined,
      () => {
        if (!valid) throw new Error("Turn revoked");
      },
    );
    const rejection = expect(promise).rejects.toThrow("Turn revoked");
    await until(() =>
      peer.commands.some((c) => c.command.startsWith("UID FETCH")),
    );
    valid = false;
    await rejection;
  });
  it("tagged FETCH completion is awaited before success", async () => {
    const { promise, peer } = await run({ taggedDelay: 100 });
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    await until(() =>
      peer.commands.some((c) => c.command.startsWith("UID FETCH")),
    );
    expect(settled).toBe(false);
    await promise;
    expect(
      peer.commands.find((c) => c.command.startsWith("UID FETCH"))?.taggedMs,
    ).not.toBeNull();
  });
  it("trickle cannot extend the absolute operation deadline", async () => {
    const { promise } = await run({ fetch: "hung", trickle: true }, 150);
    await expect(promise).rejects.toThrow("deadline");
  });
  it.each([false, true])(
    "preserves resolved authentication config, OAuth=%s",
    async (oauth) => {
      const peer = await metadataPeer({ greeting: "OK" });
      cleanups.push(peer.cleanup);
      const connection = {
        ...peer.connection,
        credential: oauth
          ? { kind: "oauth2" as const, accessToken: "fixture-only-token" }
          : peer.connection.credential,
      };
      await fetchInboxMetadataWindow(
        connection,
        expected,
        { deadline: performance.now() + 3000, assertCurrent: () => {} },
        peer.createClient,
      );
      expect(
        peer.commands.some((c) => /^(LOGIN|AUTHENTICATE) /.test(c.command)),
      ).toBe(true);
    },
  );
  it.each([false, true])(
    "last MIME disposition survives the installed entry point CJS=%s",
    async (cjs) => {
      const { promise } = await run({ cjs, minimalDisposition: true });
      const result = await promise;
      expect(result.metadata[0].hasAttachments).toBe(true);
      expect(result.metadata[0].mimeStructure?.filename).toBe("fixture.pdf");
      expect(result.metadata[0].mimeStructure?.disposition).toBe("attachment");
    },
  );
});
