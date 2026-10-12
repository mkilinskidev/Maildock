import assert from "node:assert/strict";
import type { FetchMessageObject } from "imapflow";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Lane } from "./client.js";
export type RecordRow = {
  uid: number;
  messageId: string;
  flags: string[];
  size: number;
  subject: string;
};
export function record(row: FetchMessageObject): RecordRow {
  const headers = row.headers!.toString("utf8");
  const messageId = /^Message-ID:\s*(.+)\r?$/im.exec(headers)?.[1]?.trim();
  const subject = /^Subject:\s*(.+)\r?$/im.exec(headers)?.[1]?.trim();
  assert(messageId && subject, "Required fixture metadata");
  return {
    uid: row.uid,
    messageId,
    subject,
    flags: [...row.flags!].filter((f) => f !== "\\Recent").sort(),
    size: row.size!,
  };
}
export async function verify(count: number) {
  const lane = await Lane.open();
  try {
    assert.equal(lane.client.mailbox && lane.client.mailbox.exists, count);
    const next = lane.client.mailbox && lane.client.mailbox.uidNext;
    assert(next);
    const expected = new Map<string, Record<string, unknown>>(
      (
        await readFile(
          new URL(`fixtures/${count}/manifest.jsonl`, import.meta.url),
          "utf8",
        )
      )
        .trim()
        .split("\n")
        .map((line) => {
          const r = JSON.parse(line);
          return [r.messageId, r];
        }),
    );
    const records: RecordRow[] = [];
    for (let high = next - 1; high >= 1;) {
      const low = Math.max(1, high - 127);
      const uids = await lane.search(low, high);
      if (uids.length) records.push(...(await lane.metadata(uids)).map(record));
      high = low - 1;
    }
    assert.equal(records.length, count);
    assert.equal(new Set(records.map((r) => r.uid)).size, count);
    assert.equal(new Set(records.map((r) => r.messageId)).size, count);
    for (const r of records) {
      const e = expected.get(r.messageId);
      assert(e, `Unexpected fixture identity ${r.messageId}`);
      assert.equal(r.subject, e.subject);
      assert.equal(r.size, e.bytes);
      assert.deepEqual(r.flags, e.flags);
    }
    const identityJson =
      records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    await writeFile(
      new URL(`fixtures/${count}/assigned.jsonl`, import.meta.url),
      identityJson,
    );
    return {
      count,
      uidNext: next,
      uidValidity: String(lane.epoch.uidValidity),
      identitiesSha256: createHash("sha256").update(identityJson).digest("hex"),
      verifiedEveryIdentitySizeSubjectAndFlag: true,
    };
  } finally {
    await lane.close();
  }
}
