import type {
  GmailMessage,
  GmailHistory,
} from "@/modules/accounts/infrastructure/gmail-client";
export class SyntheticGmail {
  messages = new Map<string, GmailMessage>();
  labels = [
    { id: "INBOX", name: "INBOX", type: "system" },
    { id: "SENT", name: "SENT", type: "system" },
    { id: "TRASH", name: "TRASH", type: "system" },
    { id: "SPAM", name: "SPAM", type: "system" },
    { id: "Label_one", name: "Projects", type: "user" },
  ];
  head = 100n;
  events: (Pick<GmailHistory["history"][number], "id"> &
    Partial<Omit<GmailHistory["history"][number], "id">>)[] = [];
  requests: { method: string; path: string; query: URLSearchParams }[] = [];
  failures = new Map<string, number>();
  expired = false;
  loop = false;
  metadataUnits = 0;
  fixture(
    id: string,
    labels = ["INBOX", "UNREAD", "Label_one"],
    date = Date.now(),
  ) {
    const message: GmailMessage = {
      id,
      threadId: `thread-${id}`,
      historyId: this.head.toString(),
      labelIds: labels,
      internalDate: String(date),
      sizeEstimate: 100,
      payload: {
        partId: "",
        mimeType: "multipart/alternative",
        headers: [
          { name: "From", value: "Sender <sender@example.test>" },
          { name: "To", value: "owner@example.test" },
          { name: "Subject", value: `Subject ${id}` },
          { name: "Message-ID", value: `<${id}@example.test>` },
        ],
        parts: [
          {
            partId: "0",
            mimeType: "text/plain",
            body: { size: 5, data: Buffer.from("hello").toString("base64url") },
          },
          {
            partId: "1",
            mimeType: "text/html",
            body: {
              size: 80,
              data: Buffer.from(
                '<p>hello<img src="https://tracker.example.test/x"><script>alert(1)</script></p>',
              ).toString("base64url"),
            },
          },
        ],
      },
    };
    this.messages.set(id, message);
    return message;
  }
  change(id: string, labels?: string[]) {
    this.head++;
    const message = this.messages.get(id);
    if (message) {
      message.historyId = this.head.toString();
      if (labels) message.labelIds = labels;
    }
    this.events.push({ id: this.head.toString(), messages: [{ id }] });
  }
  fetch: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    if (url.origin !== "https://gmail.googleapis.com")
      throw new Error("Unexpected origin");
    const path = url.pathname.replace("/gmail/v1/users/me/", "");
    const method = options?.method ?? "GET";
    this.requests.push({ method, path, query: url.searchParams });
    const response = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status });
    const fail = this.failures.get(path);
    if (fail) {
      this.failures.delete(path);
      return response(
        { error: { errors: [{ reason: "backendError" }] } },
        fail,
      );
    }
    if (path === "profile")
      return response({
        historyId: this.head.toString(),
        messagesTotal: this.messages.size,
      });
    if (path === "labels") return response({ labels: this.labels });
    if (path.startsWith("labels/")) {
      const id = decodeURIComponent(path.slice(7));
      const label = this.labels.find((l) => l.id === id);
      return label
        ? response({
            ...label,
            messagesTotal: [...this.messages.values()].filter((m) =>
              m.labelIds.includes(id),
            ).length,
            messagesUnread: [...this.messages.values()].filter(
              (m) => m.labelIds.includes(id) && m.labelIds.includes("UNREAD"),
            ).length,
          })
        : response({}, 404);
    }
    if (path === "messages") {
      const q = url.searchParams.get("q");
      const cutoff = Number(q?.split(":")[1] ?? 0) * 1000;
      const ids = [...this.messages.values()]
        .filter(
          (m) =>
            !q ||
            (q.startsWith("after:")
              ? Number(m.internalDate) > cutoff
              : Number(m.internalDate) < cutoff),
        )
        .map((m) => ({ id: m.id }));
      const offset = Number(url.searchParams.get("pageToken") ?? 0);
      const next = offset + 100 < ids.length ? String(offset + 100) : undefined;
      return response({
        messages: ids.slice(offset, offset + 100),
        nextPageToken: this.loop ? "repeat" : next,
      });
    }
    if (path === "history") {
      if (this.expired) {
        this.expired = false;
        return response({}, 404);
      }
      const events = this.events.filter(
        (e) => BigInt(e.id) > BigInt(url.searchParams.get("startHistoryId")!),
      );
      const offset = Number(url.searchParams.get("pageToken") ?? 0);
      return response({
        historyId: this.head.toString(),
        history: events.slice(offset, offset + 100),
        nextPageToken:
          offset + 100 < events.length ? String(offset + 100) : undefined,
      });
    }
    const segments = path.split("/").map(decodeURIComponent);
    const message = this.messages.get(segments[1]);
    if (!message) return response({}, 404);
    if (segments[2] === "modify") {
      const body = JSON.parse(String(options?.body));
      message.labelIds = [
        ...new Set([...message.labelIds, ...body.addLabelIds]),
      ].filter((l) => !body.removeLabelIds.includes(l));
      this.change(message.id);
      return response({ id: message.id });
    }
    if (segments[2] === "trash") {
      message.labelIds = [
        ...message.labelIds.filter((l) => l !== "INBOX"),
        "TRASH",
      ];
      this.change(message.id);
      return response({ id: message.id });
    }
    if (segments[2] === "attachments")
      return response({
        data: Buffer.from("attachment-fixture").toString("base64url"),
        size: 18,
      });
    this.metadataUnits += 20;
    const copy = structuredClone(message);
    if (url.searchParams.has("fields")) {
      function strip(p: NonNullable<GmailMessage["payload"]>) {
        if (p.body) delete p.body.data;
        p.parts?.forEach(strip);
      }
      if (copy.payload) strip(copy.payload);
    }
    return response(copy);
  };
}
