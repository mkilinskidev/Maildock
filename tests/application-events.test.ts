import { expect, it } from "vitest";
import { safeDiagnosticDetails } from "@/modules/diagnostics/domain/application-event";
it("accepts only bounded protocol metadata and strips sensitive fields", () => {
  const details = safeDiagnosticDetails({
    category: "authentication_rejected",
    mailboxPath: "INBOX",
    uidValidity: "10",
    password: "SECRET",
    accessToken: "SECRET",
    refreshToken: "SECRET",
    credentialEnvelope: { ciphertext: "SECRET" },
    authorization: "SECRET",
    cookie: "SECRET",
    rawMime: "SECRET",
    messageBody: "SECRET",
    attachmentContents: "SECRET",
    subject: "SECRET",
    sender: "SECRET",
    stack: "SECRET",
    exception: new Error("SECRET"),
  });
  expect(details).toEqual({
    category: "authentication_rejected",
    mailboxPath: "INBOX",
    uidValidity: "10",
  });
  expect(JSON.stringify(details)).not.toContain("SECRET");
  for (const input of [
    new Error("SECRET"),
    { category: "SECRET" },
    { mailboxPath: "x".repeat(513) },
    { uidValidity: "SECRET" },
  ])
    expect(safeDiagnosticDetails(input)).toEqual({});
});
it("accepts provider failure tokens and rejects free-form values", () => {
  const tokens = {
    category: "server_unavailable",
    mailboxPath: "[Gmail]/All Mail",
    phase: "fetch",
    reason: "poll",
    imapStatus: "NO",
    imapResponseCode: "UNAVAILABLE",
    errorCode: "ETHROTTLE",
  };
  expect(safeDiagnosticDetails({ ...tokens, responseText: "SECRET" })).toEqual(
    tokens,
  );
  for (const input of [
    { phase: "SECRET" },
    { reason: "SECRET" },
    { imapStatus: "OK" },
    { imapResponseCode: "owner@example.com" },
    { errorCode: "Command failed: SECRET" },
  ])
    expect(safeDiagnosticDetails(input)).toEqual({});
});
