/** Decode MIME transfer encoding only, preserving text attachment charset/flowed bytes. */
export async function* decodeAttachment(
  source: AsyncIterable<Uint8Array>,
  encoding: string | null,
): AsyncGenerator<Uint8Array> {
  const kind = encoding?.toLowerCase();
  if (!kind || ["7bit", "8bit", "binary"].includes(kind)) {
    yield* source;
    return;
  }
  if (!["base64", "quoted-printable"].includes(kind))
    throw Error("Unsupported attachment transfer encoding.");
  let pending = "";
  for await (const bytes of source) {
    pending += Buffer.from(bytes).toString("latin1");
    if (kind === "base64") {
      pending = pending.replace(/[\t\r\n ]/g, "");
      if (/[^A-Za-z0-9+/=]/.test(pending))
        throw Error("Invalid base64 attachment.");
      const length = pending.includes("=")
        ? pending.indexOf("=") - (pending.indexOf("=") % 4)
        : pending.length - (pending.length % 4);
      if (length) yield Buffer.from(pending.slice(0, length), "base64");
      pending = pending.slice(length);
    } else {
      let end = pending.length;
      const lastEquals = pending.lastIndexOf("=");
      if (lastEquals >= 0 && lastEquals >= end - 2) end = lastEquals;
      if (end)
        yield Buffer.from(
          pending
            .slice(0, end)
            .replace(/=\r?\n/g, "")
            .replace(/=([0-9a-f]{2})/gi, (_, hex: string) =>
              String.fromCharCode(parseInt(hex, 16)),
            ),
          "latin1",
        );
      pending = pending.slice(end);
    }
  }
  if (kind === "base64") {
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        pending,
      )
    )
      throw Error("Truncated base64 attachment.");
    if (pending) yield Buffer.from(pending, "base64");
  } else if (pending)
    yield Buffer.from(
      pending
        .replace(/=\r?\n/g, "")
        .replace(/=([0-9a-f]{2})/gi, (_, hex: string) =>
          String.fromCharCode(parseInt(hex, 16)),
        ),
      "latin1",
    );
}
