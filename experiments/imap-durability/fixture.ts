import { mkdir, open } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";

export const seed = 2403;
function tarHeader(name: string, size: number, directory = false) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "ascii");
  h.write(directory ? "0000755\0" : "0000644\0", 100, 8, "ascii");
  h.write("0001750\0", 108, 8, "ascii");
  h.write("0001750\0", 116, 8, "ascii");
  h.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
  h.write("14524770400\0", 136, 12, "ascii");
  h.fill(32, 148, 156);
  h[156] = directory ? 53 : 48;
  h.write("ustar\0", 257, 6, "ascii");
  h.write("00", 263, 2, "ascii");
  h.write(
    h
      .reduce((a, b) => a + b, 0)
      .toString(8)
      .padStart(6, "0") + "\0 ",
    148,
    8,
    "ascii",
  );
  return h;
}
export function message(index: number, run = "initial") {
  const id = `${run}-${seed}-${String(index).padStart(6, "0")}`;
  const oldDate = index % 97 === 0 || run !== "initial";
  const date = new Date(Date.UTC(oldDate ? 2001 : 2024, 0, 1) + index * 60_000);
  const flags = index % 3 === 0 ? ["\\Seen"] : [];
  const body =
    `Fixture ${id}\r\n` +
    "0123456789 abcdef\r\n".repeat(
      index % 101 === 0 ? 4096 : 1 + ((index * 17 + seed) % 20),
    );
  const header = `From: Fixture <sender@example.invalid>\r\nTo: Test <fixture@example.invalid>\r\nMessage-ID: <${id}@maildock.invalid>\r\nSubject: Maildock fixture ${id}\r\nDate: ${date.toUTCString()}\r\nMIME-Version: 1.0\r\n`;
  const attachment = index % 100 === 0;
  const multipart = index % 20 === 0;
  const data = Buffer.from(
    header +
      (multipart
        ? `Content-Type: multipart/mixed; boundary="${id}"\r\n\r\n--${id}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n` +
          (attachment
            ? `--${id}\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="fixture.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(
                id.repeat(16),
              )
                .toString("base64")
                .match(/.{1,76}/g)!
                .join("\r\n")}\r\n`
            : "") +
          `--${id}--\r\n`
        : `Content-Type: text/plain; charset=utf-8\r\n\r\n${body}`),
  );
  return {
    id,
    messageId: `<${id}@maildock.invalid>`,
    subject: `Maildock fixture ${id}`,
    flags,
    date: date.toISOString(),
    bytes: data.length,
    multipart,
    attachment,
    sha256: createHash("sha256").update(data).digest("hex"),
    data,
  };
}
export async function generate(count: number) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 50_000)
    throw new Error("Count must be 1..50000");
  const start = performance.now();
  const root = new URL(`fixtures/${count}/`, import.meta.url);
  await mkdir(root, { recursive: true });
  const manifest = await open(new URL("manifest.jsonl", root), "w");
  const tar = await open(new URL("mailbox.tar", root), "w");
  try {
    for (const directory of ["cur/", "new/", "tmp/"])
      await tar.write(tarHeader(directory, 0, true));
    for (let i = 1; i <= count; i++) {
      const { data, ...record } = message(i);
      await tar.write(
        tarHeader(
          `cur/${record.id}:2,${record.flags.length ? "S" : ""}`,
          data.length,
        ),
      );
      await tar.write(data);
      if (data.length % 512)
        await tar.write(Buffer.alloc(512 - (data.length % 512)));
      await manifest.write(JSON.stringify(record) + "\n");
    }
    await tar.write(Buffer.alloc(1024));
  } finally {
    await manifest.close();
    await tar.close();
  }
  return {
    count,
    seed,
    generationMs: performance.now() - start,
    path: root.pathname,
  };
}
