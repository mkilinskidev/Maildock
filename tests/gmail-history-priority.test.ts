import { describe, expect, it } from "vitest";
import { GmailClient } from "@/modules/accounts/infrastructure/gmail-client";
import { classifyGmailHistory } from "@/modules/mail/domain/gmail-history-priority";

async function decode(record: unknown) {
  const client = new GmailClient({
    token: async () => "fixture",
    reserve: async () => undefined,
    fetcher: async () =>
      new Response(JSON.stringify({ historyId: "2", history: [record] })),
  });
  return (await client.history("1")).history;
}
describe("Gmail history relevance", () => {
  it.each([
    { messagesAdded: [{ message: { id: "old", labelIds: ["INBOX"] } }] },
    {
      labelsAdded: [
        {
          message: { id: "old", labelIds: ["Label_one"] },
          labelIds: ["INBOX"],
        },
      ],
    },
    {
      labelsRemoved: [
        {
          message: { id: "old", labelIds: ["Label_one"] },
          labelIds: ["INBOX"],
        },
      ],
    },
    {
      labelsRemoved: [
        { message: { id: "old", labelIds: ["INBOX"] }, labelIds: ["UNREAD"] },
      ],
    },
    { messagesDeleted: [{ message: { id: "old" } }] },
    { messages: [{ id: "old" }] },
    { messages: [{ id: "old", labelIds: ["TRASH"] }] },
    { labelsRemoved: [{ message: { id: "old", labelIds: ["TRASH"] } }] },
  ])(
    "retains event context and conservatively prioritizes %j",
    async (event) => {
      expect(
        classifyGmailHistory(await decode({ id: "2", ...event }), new Set()),
      ).toEqual([{ id: "old", priorityClass: 0 }]);
    },
  );
  it("uses previous local INBOX membership for archive/delete and metadata", async () => {
    const history = await decode({
      id: "2",
      messagesDeleted: [{ message: { id: "old", labelIds: ["TRASH"] } }],
    });
    expect(
      classifyGmailHistory(history, new Set(["old"]))[0].priorityClass,
    ).toBe(0);
    expect(classifyGmailHistory(history, new Set())[0].priorityClass).toBe(1);
  });
  it("deduplicates generic references without downgrading typed evidence", async () => {
    const history = await decode({
      id: "2",
      messages: [{ id: "other" }],
      labelsAdded: [
        {
          message: { id: "other", threadId: "thread", labelIds: ["SENT"] },
          labelIds: ["STARRED"],
        },
      ],
    });
    expect(history[0].labelsAdded[0]).toMatchObject({
      labelIds: ["STARRED"],
      message: { threadId: "thread", labelIds: ["SENT"] },
    });
    expect(classifyGmailHistory(history, new Set())).toEqual([
      { id: "other", priorityClass: 1 },
    ]);
    history[0].labelsRemoved.push({
      message: { id: "other", labelIds: ["SENT"] },
      labelIds: ["INBOX"],
    });
    expect(classifyGmailHistory(history, new Set())).toEqual([
      { id: "other", priorityClass: 0 },
    ]);
  });
});
