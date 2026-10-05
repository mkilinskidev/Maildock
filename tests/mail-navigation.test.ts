import { expect, it } from "vitest";
import { resolveMailNavigation } from "@/modules/mail/domain/mail-navigation";

const a = "00000000-0000-4000-8000-000000000001";
const b = "00000000-0000-4000-8000-000000000002";
const mailbox = "00000000-0000-4000-8000-000000000003";
const message = "00000000-0000-4000-8000-000000000004";
const accounts = [
  { id: a, enabled: true },
  { id: b, enabled: true },
];
const boxes = { [a]: [], [b]: [{ id: mailbox }] };
it("has no implicit account target on a plain Mail page", () => {
  expect(resolveMailNavigation({}, accounts, boxes)).toBeUndefined();
  expect(
    resolveMailNavigation({}, [...accounts].reverse(), boxes),
  ).toBeUndefined();
  expect(resolveMailNavigation({}, [], {})).toBeUndefined();
});
it("preserves explicit account, mailbox and message placement", () => {
  expect(resolveMailNavigation({ account: b }, accounts, boxes)).toMatchObject({
    accountId: b,
  });
  expect(resolveMailNavigation({ mailbox }, accounts, boxes)).toMatchObject({
    accountId: b,
    mailboxId: mailbox,
  });
  expect(
    resolveMailNavigation({ account: b, mailbox, message }, accounts, boxes),
  ).toEqual({ accountId: b, mailboxId: mailbox, messageId: message });
});
it("rejects malformed, mismatched and disabled navigation without guessing a placement", () => {
  expect(
    resolveMailNavigation({ account: "invalid" }, accounts, boxes),
  ).toBeUndefined();
  expect(
    resolveMailNavigation({ account: a, mailbox, message }, accounts, boxes),
  ).toBeUndefined();
  expect(resolveMailNavigation({ message }, accounts, boxes)).toBeUndefined();
  expect(
    resolveMailNavigation(
      { account: b, mailbox, message },
      [{ id: b, enabled: false }],
      boxes,
    ),
  ).toBeUndefined();
});
