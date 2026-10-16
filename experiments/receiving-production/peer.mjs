// Disposable local protocol peer for R16 deployment smoke. Run only inside an
// isolated Compose project. It never contacts or changes a real provider.
import { createServer as tlsServer } from "node:tls";
import { createServer as httpServer, request as proxyRequest } from "node:http";
import { createServer as httpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const tls = {
  key: readFileSync(
    new URL("../imap-transport/localhost-key.pem", import.meta.url),
  ),
  cert: readFileSync(
    new URL("../imap-transport/localhost-cert.pem", import.meta.url),
  ),
};
const atom = (value) => (value.startsWith('"') ? JSON.parse(value) : value);
const accounts = new Map();
const stats = {
  connections: 0,
  active: 0,
  maxActive: 0,
  maxPerAccount: 0,
  append: 0,
  move: 0,
  store: 0,
  smtp: 0,
  fetch: 0,
  pausedAttachment: 0,
  literalBytes: 0,
  mutations: [],
  smtpDigests: [],
  appendDigests: [],
  trace: [],
};
const activeAccounts = new Map();
const control = {
  drop: null,
  pauseAttachment: false,
  largeHtml: true,
  move: true,
};
const plain = Buffer.from("Hello R16\n");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1kAAAAASUVORK5CYII=",
  "base64",
);
let html = Buffer.from(
  "<div>" +
    "<p>R16 HTML body text.</p>".repeat(87_380) +
    '</div><img src="https://remote.invalid/image"><img src="cid:r16-inline">',
);
const smallHtml = Buffer.from(
  '<div><p>Ordinary R16 newsletter.</p><img src="https://remote.invalid/image"><img src="cid:r16-inline"></div>',
);
const binaryBytes = 100 * 1024 * 1024;
const hash = (b) => createHash("sha256").update(b).digest("hex");
const messageSize = (uid, message) =>
  message.mime?.length ??
  (uid === 1 || uid === 101 ? binaryBytes + html.length + 2048 : 200);
function account(name) {
  if (!accounts.has(name))
    accounts.set(
      name,
      new Map(
        ["INBOX", "Sent", "Archive", "Trash"].map((folder) => [
          folder,
          {
            next: folder === "INBOX" ? 1025 : 1,
            messages: new Map(
              folder === "INBOX"
                ? Array.from({ length: 1024 }, (_, i) => [
                    i + 1,
                    { id: `<r16-${i + 1}@fixture.test>`, flags: [] },
                  ])
                : [],
            ),
          },
        ]),
      ),
    );
  return accounts.get(name);
}
const textPart = (type, size) =>
  `("TEXT" "${type}" ("CHARSET" "UTF-8") NIL NIL "8BIT" ${size} 1 NIL NIL NIL NIL)`;
function structure(uid, message) {
  if (message.mime) return textPart("PLAIN", plain.length);
  if (uid === 2)
    return (
      `((${textPart("PLAIN", plain.length)}${textPart("HTML", smallHtml.length)} "ALTERNATIVE" ("BOUNDARY" "alt") NIL NIL NIL)` +
      `("APPLICATION" "OCTET-STREAM" ("NAME" "large.bin") NIL NIL "BINARY" ${binaryBytes} NIL ("ATTACHMENT" ("FILENAME" "large.bin")) NIL NIL)` +
      `("IMAGE" "PNG" ("NAME" "inline.png") "<r16-inline>" NIL "BINARY" ${png.length} NIL ("INLINE" ("FILENAME" "inline.png")) NIL NIL) "MIXED" ("BOUNDARY" "mixed") NIL NIL NIL)`
    );
  if (uid !== 1 && uid !== 101) return textPart("PLAIN", plain.length);
  return (
    `((${textPart("PLAIN", plain.length)}${textPart("HTML", html.length)} "ALTERNATIVE" ("BOUNDARY" "alt") NIL NIL NIL)` +
    `("APPLICATION" "OCTET-STREAM" ("NAME" "large.bin") NIL NIL "BINARY" ${binaryBytes} NIL ("ATTACHMENT" ("FILENAME" "large.bin")) NIL NIL)` +
    `("IMAGE" "PNG" ("NAME" "inline.png") "<r16-inline>" NIL "BINARY" ${png.length} NIL ("INLINE" ("FILENAME" "inline.png")) NIL NIL) "MIXED" ("BOUNDARY" "mixed") NIL NIL NIL)`
  );
}
function part(uid, name, message) {
  if (name === "" && message.mime)
    return { type: "text/plain", bytes: message.mime };
  if (["TEXT", "1", "1.1"].includes(name))
    return { type: "text/plain", bytes: plain };
  if (name === "1.2")
    return { type: "text/html", bytes: uid === 2 ? smallHtml : html };
  if (name === "2")
    return { type: "application/octet-stream", size: binaryBytes };
  if (name === "3") return { type: "image/png", bytes: png };
  throw new Error("Unrecognized fixture section");
}
function selected(folder, tag, write) {
  return `* ${folder.messages.size} EXISTS\r\n* FLAGS (\\Seen \\Answered \\Flagged)\r\n* OK [PERMANENTFLAGS (\\Seen \\Answered \\Flagged \\*)] Flags\r\n* OK [UIDVALIDITY 7] Epoch\r\n* OK [UIDNEXT ${folder.next}] Next\r\n${tag} OK [${write ? "READ-WRITE" : "READ-ONLY"}] Selected\r\n`;
}
const imap = tlsServer(tls, (socket) => {
  socket.setNoDelay(true);
  stats.connections++;
  stats.active++;
  stats.maxActive = Math.max(stats.maxActive, stats.active);
  let authTag;
  let input = Buffer.alloc(0),
    literal,
    username,
    folderName = "INBOX";
  const send = (line) => socket.write(line + "\r\n");
  const ok = (tag, text = "Completed") => send(`${tag} OK ${text}`);
  const caps = () =>
    `IMAP4rev1 AUTH=PLAIN SASL-IR UIDPLUS${control.move ? " MOVE" : ""}`;
  socket.on("error", () => {});
  socket.on("close", () => {
    stats.active--;
    if (username)
      activeAccounts.set(username, activeAccounts.get(username) - 1);
  });
  send(`* OK [CAPABILITY ${caps()}] R16 isolated peer`);
  const authenticated = (name) => {
    username = name;
    account(name);
    activeAccounts.set(name, (activeAccounts.get(name) ?? 0) + 1);
    stats.maxPerAccount = Math.max(
      stats.maxPerAccount,
      activeAccounts.get(name),
    );
  };
  const finishAppend = () => {
    const mime = Buffer.concat(literal.chunks, literal.size);
    const target = account(username).get(literal.folder),
      uid = target.next++;
    target.messages.set(uid, {
      id: /^message-id:\s*(.+)$/im.exec(mime.toString())?.[1].trim(),
      flags: ["\\Seen"],
      mime,
    });
    stats.append++;
    stats.appendDigests.push(hash(mime));
    const tag = literal.tag;
    literal = undefined;
    if (control.drop === "APPEND") {
      control.drop = null;
      socket.destroy();
    } else ok(tag, `[APPENDUID 7 ${uid}] Copied`);
  };
  socket.on("data", (chunk) => {
    input = Buffer.concat([input, chunk]);
    try {
      while (input.length) {
        if (literal) {
          const size = Math.min(input.length, literal.size - literal.received);
          literal.chunks.push(input.subarray(0, size));
          literal.received += size;
          input = input.subarray(size);
          if (literal.received === literal.size) finishAppend();
          else break;
          continue;
        }
        const boundary = input.indexOf("\r\n");
        if (boundary < 0) break;
        const line = input.subarray(0, boundary).toString();
        input = input.subarray(boundary + 2);
        if (!line) continue;
        if (authTag) {
          authenticated(Buffer.from(line, "base64").toString().split("\0")[1]);
          ok(authTag);
          authTag = undefined;
          continue;
        }
        const space = line.indexOf(" "),
          tag = line.slice(0, space),
          command = line.slice(space + 1);
        stats.trace.push(
          /^(LOGIN|AUTHENTICATE)/.test(command)
            ? command
                .split(" ")
                .slice(0, command.startsWith("LOGIN") ? 1 : 2)
                .join(" ") + " [redacted]"
            : command,
        );
        if (stats.trace.length > 32) stats.trace.shift();
        if (command === "CAPABILITY") {
          send(`* CAPABILITY ${caps()}`);
          ok(tag);
        } else if (command === "AUTHENTICATE PLAIN") {
          authTag = tag;
          send("+");
        } else if (/^AUTHENTICATE PLAIN /.test(command)) {
          authenticated(
            Buffer.from(command.split(" ")[2], "base64")
              .toString()
              .split("\0")[1],
          );
          ok(tag);
        } else if (command.startsWith("LOGIN ")) {
          authenticated(atom(command.match(/^LOGIN ("[^"]*"|\S+)/)[1]));
          ok(tag);
        } else if (/^(LIST|LSUB) /.test(command)) {
          if (command === 'LIST "" ""') send('* LIST () "/" ""');
          else
            for (const name of [...account(username).keys()].filter(
              (name) =>
                command.includes('"*"') ||
                command.endsWith(JSON.stringify(name)) ||
                command.endsWith(" " + name),
            ))
              send(
                `* ${command.startsWith("LSUB") ? "LSUB" : "LIST"} (${name === "INBOX" ? "" : "\\" + name}) "/" "${name}"`,
              );
          ok(tag);
        } else if (/^(SELECT|EXAMINE) /.test(command)) {
          folderName = atom(command.match(/^[A-Z]+ ("[^"]*"|\S+)/)[1]);
          socket.write(
            selected(
              account(username).get(folderName),
              tag,
              command.startsWith("SELECT"),
            ),
          );
        } else if (command.startsWith("UID SEARCH")) {
          const folder = account(username).get(folderName);
          const range = / UID ([\d:,]+)/.exec(command)?.[1];
          const messageId = /HEADER "?Message-ID"? (?:"([^"]+)"|([^ ]+))/i.exec(
            command,
          );
          const hits = [...folder.messages]
            .filter(([uid, m]) =>
              range
                ? range.split(",").some((s) => {
                    const [a, b = a] = s.split(":").map(Number);
                    return uid >= a && uid <= b;
                  })
                : messageId
                  ? m.id === (messageId[1] ?? messageId[2])
                  : false,
            )
            .map(([uid]) => uid);
          send(`* SEARCH${hits.length ? " " + hits.join(" ") : ""}`);
          ok(tag);
        } else if (command.startsWith("UID FETCH")) {
          stats.fetch++;
          const folder = account(username).get(folderName),
            ranges = command.split(" ")[2];
          const hits = [...folder.messages].filter(([uid]) =>
            ranges.split(",").some((s) => {
              const [a, b = a] = s.split(":").map(Number);
              return uid >= a && uid <= b;
            }),
          );
          if (control.pauseAttachment && /BODY\.PEEK\[2\]</.test(command)) {
            stats.pausedAttachment++;
            continue;
          }
          for (const [uid, message] of hits) {
            if (command.includes("ENVELOPE")) {
              const refs = Buffer.from(
                "References: <parent@fixture.test>\r\n\r\n",
              );
              socket.write(
                `* 1 FETCH (UID ${uid} FLAGS (${message.flags.join(" ")}) INTERNALDATE "01-Jan-2026 00:00:00 +0000" RFC822.SIZE ${messageSize(uid, message)} ENVELOPE (NIL "Fixture ${uid}" (("Sender" NIL "sender" "fixture.test")) NIL NIL ((NIL NIL "recipient" "fixture.test")) NIL NIL NIL "${message.id}") BODYSTRUCTURE ${structure(uid, message)} BODY[HEADER.FIELDS (REFERENCES)] {${refs.length}}\r\n`,
              );
              socket.write(refs);
              send(")");
            } else if (command.includes("BODYSTRUCTURE"))
              send(
                `* 1 FETCH (UID ${uid} BODYSTRUCTURE ${structure(uid, message)})`,
              );
            else if (command.includes("BODY.PEEK")) {
              socket.write(
                `* 1 FETCH (UID ${uid}${command.includes("FLAGS") ? ` FLAGS (${message.flags.join(" ")})` : ` RFC822.SIZE ${messageSize(uid, message)}`}`,
              );
              for (const m of command.matchAll(
                /BODY\.PEEK\[([^\]]*)\](?:<(\d+)\.(\d+)>)?/g,
              )) {
                const section = m[1].toUpperCase(),
                  header = section === "HEADER" || section.endsWith(".MIME");
                const body = part(
                  uid,
                  header
                    ? section === "HEADER"
                      ? "TEXT"
                      : section.slice(0, -5)
                    : section,
                  message,
                );
                const offset = Number(m[2] ?? 0),
                  limit = Number(m[3] ?? body.bytes?.length ?? 0);
                const bytes = header
                  ? Buffer.from(
                      `Content-Type: ${body.type}; charset=utf-8\r\nContent-Transfer-Encoding: ${body.size || section === "3.MIME" ? "binary" : "8bit"}\r\n\r\n`,
                    )
                  : body.bytes
                    ? body.bytes.subarray(offset, offset + limit)
                    : Buffer.alloc(
                        Math.max(0, Math.min(limit, body.size - offset)),
                        97,
                      );
                stats.literalBytes += bytes.length;
                socket.write(
                  ` BODY[${section}]${header || m[2] === undefined ? "" : `<${offset}>`} {${bytes.length}}\r\n`,
                );
                socket.write(bytes);
              }
              send(")");
            } else
              send(`* 1 FETCH (UID ${uid} FLAGS (${message.flags.join(" ")}))`);
          }
          ok(tag);
        } else if (command.startsWith("UID STORE")) {
          const uid = Number(command.split(" ")[2]),
            message = account(username).get(folderName).messages.get(uid);
          const flag = command.includes("\\Seen") ? "\\Seen" : "\\Flagged";
          message.flags = command.includes("+FLAGS")
            ? [...new Set([...message.flags, flag])]
            : message.flags.filter((f) => f !== flag);
          stats.store++;
          stats.mutations.push({ kind: "STORE", username, uid });
          if (control.drop === "STORE") {
            control.drop = null;
            socket.destroy();
          } else ok(tag);
        } else if (command.startsWith("UID MOVE")) {
          const uid = Number(command.split(" ")[2]),
            targetName = atom(command.match(/ ("[^"]*"|\S+)$/)[1]);
          const source = account(username).get(folderName),
            target = account(username).get(targetName),
            mapped = target.next++;
          target.messages.set(mapped, source.messages.get(uid));
          source.messages.delete(uid);
          stats.move++;
          stats.mutations.push({ kind: "MOVE", username, uid });
          if (control.drop === "MOVE") {
            control.drop = null;
            socket.destroy();
          } else ok(tag, `[COPYUID 7 ${uid} ${mapped}] Moved`);
        } else if (command.startsWith("APPEND ")) {
          const size = Number(/\{(\d+)\+?\}$/.exec(command)[1]);
          if (size > 25 * 1024 * 1024) throw new Error("Fixture MIME ceiling");
          literal = {
            size,
            tag,
            folder: atom(/^APPEND ("[^"]*"|\S+)/.exec(command)[1]),
            chunks: [],
            received: 0,
          };
          if (!command.endsWith("+}")) send("+ Ready for literal");
        } else if (command === "LOGOUT") {
          send("* BYE Closing");
          ok(tag);
          socket.end();
        } else if (["NOOP", "CLOSE", "UNSELECT"].includes(command)) ok(tag);
        else send(`${tag} BAD Unsupported fixture command`);
      }
    } catch (error) {
      console.error(
        "Fixture protocol error",
        error.name,
        error.stack?.split("\n").slice(1, 3).join("\n"),
      );
      socket.destroy();
    }
  });
});
const smtp = tlsServer(tls, (socket) => {
  let input = "",
    data = false,
    lines = [],
    username = "";
  const send = (line) => socket.write(line + "\r\n");
  socket.on("error", () => {});
  send("220 r16.fixture ESMTP");
  socket.on("data", (chunk) => {
    input += chunk.toString();
    let end;
    while ((end = input.indexOf("\r\n")) >= 0) {
      const line = input.slice(0, end);
      input = input.slice(end + 2);
      if (data) {
        if (line !== ".") {
          lines.push(line.startsWith("..") ? line.slice(1) : line);
          continue;
        }
        const mime = Buffer.from(lines.join("\r\n") + "\r\n");
        lines = [];
        data = false;
        stats.smtp++;
        stats.smtpDigests.push(hash(mime));
        if (username === "server") {
          const target = account(username).get("Sent");
          target.messages.set(target.next++, {
            id: /^message-id:\s*(.+)$/im.exec(mime.toString())?.[1].trim(),
            flags: ["\\Seen"],
            mime,
          });
        }
        send("250 2.0.0 Accepted");
      } else if (/^(EHLO|HELO)/.test(line))
        send("250-r16.fixture\r\n250-AUTH PLAIN\r\n250 SIZE 26214400");
      else if (line.startsWith("AUTH PLAIN")) {
        username = Buffer.from(line.split(" ")[2], "base64")
          .toString()
          .split("\0")[1];
        send("235 Authenticated");
      } else if (/^(MAIL FROM|RCPT TO|RSET|NOOP)/.test(line)) send("250 OK");
      else if (line === "DATA") {
        data = true;
        send("354 End with dot");
      } else if (line === "QUIT") {
        send("221 Bye");
        socket.end();
      } else send("500 Unsupported fixture command");
    }
  });
});
const http = httpServer(async (req, res) => {
  if (req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const update = JSON.parse(body);
    if (update.largeHtml)
      html = Buffer.from(
        "<div>" +
          "<p>R16 HTML body text.</p>".repeat(87_380) +
          '</div><img src="https://remote.invalid/image"><img src="cid:r16-inline">',
      );
    Object.assign(control, update);
    if (update.action) {
      const folder = account(update.username).get(update.folder ?? "INBOX");
      if (update.action === "arrival")
        folder.messages.set(folder.next++, {
          id: `<arrival-${folder.next}@fixture.test>`,
          flags: [],
        });
      if (update.action === "flags")
        folder.messages.get(update.uid).flags = update.flags;
      if (update.action === "delete") folder.messages.delete(update.uid);
    }
  }
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      ...stats,
      control,
      folders: [...accounts].map(([username, folders]) => ({
        username,
        folders: [...folders].map(([name, folder]) => ({
          name,
          count: folder.messages.size,
          next: folder.next,
        })),
      })),
    }),
  );
});
const ingress = httpsServer(tls, (req, res) => {
  const upstream = proxyRequest(
    {
      host: "127.0.0.1",
      port: 3000,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, "x-forwarded-proto": "https" },
    },
    (reply) => {
      res.writeHead(reply.statusCode, reply.headers);
      reply.pipe(res);
    },
  );
  upstream.on("error", () => {
    res.writeHead(503);
    res.end();
  });
  req.pipe(upstream);
});
await Promise.all([
  new Promise((r) => imap.listen(1993, "127.0.0.1", r)),
  new Promise((r) => smtp.listen(1465, "127.0.0.1", r)),
  new Promise((r) => http.listen(1995, "127.0.0.1", r)),
  new Promise((r) => ingress.listen(3443, "0.0.0.0", r)),
]);
console.log("R16 isolated TLS/SMTP/control peer ready");
