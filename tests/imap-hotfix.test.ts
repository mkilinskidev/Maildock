import { describe, expect, it } from "vitest";
import { sanitizeError } from "@/modules/accounts/infrastructure/imap-smtp-mail-provider";
import { guardImapClient } from "@/modules/accounts/infrastructure/imap-client-lifecycle";
import { MailProviderOperationError } from "@/modules/accounts/domain/mail-provider";
import { presenceBatches } from "@/modules/accounts/infrastructure/uid-presence";
import { EventEmitter } from "node:events";

describe("IMAP hotfix safety", () => {
  it.each([
    ["CONNECT_TIMEOUT", "connection_timeout"],
    ["GREETING_TIMEOUT", "connection_timeout"],
    ["UPGRADE_TIMEOUT", "connection_timeout"],
    ["ETIMEDOUT", "connection_timeout"],
    ["ETIMEOUT", "socket_timeout"],
    ["EAUTH", "authentication_rejected"],
    ["CERT_HAS_EXPIRED", "tls_certificate_failure"],
    ["ECONNRESET", "provider_disconnected"],
    ["ABORT_ERR", "cancelled"],
  ])("normalizes %s without revealing provider text", (code, category) => {
    const result = sanitizeError(
      Object.assign(new Error("password secret login timeout"), { code }),
      "IMAP",
    );
    expect(result.category).toBe(category);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(
      sanitizeError(new MailProviderOperationError(result), "IMAP"),
    ).toEqual(result);
  });
  it("keeps the first socket timeout when a pending command rejects on close", async () => {
    class Client extends EventEmitter {
      close() {}
      async connect() {
        this.emit(
          "error",
          Object.assign(new Error("secret"), { code: "ETIMEOUT" }),
        );
        throw Object.assign(new Error("closed"), { code: "ConnectionClosed" });
      }
    }
    await expect(guardImapClient(new Client()).connect()).rejects.toMatchObject(
      { code: "ETIMEOUT" },
    );
  });
  it("bounds maximum-width sparse UID requests and handles empty snapshots", () => {
    expect([...presenceBatches([])]).toEqual([]);
    const uids = Array.from({ length: 41246 }, (_, i) =>
      String(0xffffffff - i * 100),
    );
    const batches = [...presenceBatches(uids)];
    expect(batches.length).toBe(57);
    expect(batches.flat()).toEqual(uids);
    expect(
      batches.every(
        (batch) => batch.length <= 1000 && batch.join(",").length <= 8000,
      ),
    ).toBe(true);
  });
});
