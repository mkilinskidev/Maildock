import { DraftConflictError } from "../domain/draft";
import { OutgoingValidationError } from "./outgoing-message-service";
import { ZodError } from "zod";
export async function readDraftRequest(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new SyntaxError();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 3100000) {
        await reader.cancel();
        throw new SyntaxError("Draft is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export function draftApiError(error: unknown) {
  const conflict = error instanceof DraftConflictError;
  const invalid =
    error instanceof ZodError ||
    error instanceof SyntaxError ||
    error instanceof OutgoingValidationError;
  return Response.json(
    {
      error:
        conflict || error instanceof OutgoingValidationError
          ? error.message
          : invalid
            ? "Invalid draft request."
            : "Draft operation failed. Please retry.",
    },
    { status: conflict ? 409 : invalid ? 400 : 500 },
  );
}
