import { StringDecoder } from "node:string_decoder";

export class TerminalInterrupted extends Error {}

// Raw mode disables the terminal driver's echo, including pasted passwords.
// Never mask with stars or include input in exceptions/diagnostics.
export async function readTerminal(
  prompt: string,
  secret = true,
): Promise<string> {
  const input = process.stdin,
    output = process.stdout;
  if (!input.isTTY || !output.isTTY)
    throw new Error("Interactive terminal required.");
  const wasRaw = input.isRaw;
  const decoder = new StringDecoder("utf8");
  let value = "";
  return new Promise<string>((resolve, reject) => {
    const cleanup = () => {
      input.removeListener("data", data);
      input.removeListener("end", abort);
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
      input.setRawMode(wasRaw);
      input.pause();
      value = "";
      output.write("\n");
    };
    const abort = () => {
      cleanup();
      reject(new TerminalInterrupted());
    };
    const data = (chunk: Buffer) => {
      for (const char of decoder.write(chunk)) {
        if (["\u0003", "\u0004"].includes(char)) {
          abort();
          return;
        }
        if (char === "\r" || char === "\n") {
          const result = value;
          cleanup();
          resolve(result);
          return;
        }
        if (char === "\u007f" || char === "\b") {
          if (value) {
            value = Array.from(value).slice(0, -1).join("");
            if (!secret) output.write("\b \b");
          }
        } else if (char >= " " && char !== "\u007f") {
          value += char;
          if (value.length > 256) {
            cleanup();
            reject(new Error("Input too long."));
            return;
          }
          if (!secret) output.write(char);
        } else {
          cleanup();
          reject(new Error("Unsupported terminal input."));
          return;
        }
      }
    };
    input.setRawMode(true);
    input.on("data", data);
    input.once("end", abort);
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    input.resume();
    output.write(prompt);
  });
}
