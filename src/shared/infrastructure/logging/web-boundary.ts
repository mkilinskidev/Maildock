import { createLogger } from "./logger";
import { logFailure } from "./diagnostics";
import { unstable_rethrow } from "next/navigation";

const logger = createLogger({ logLevel: "info" });

// The callback covers authorization/prechecks as well as route body work.
// Neither the Request nor route URL/query is an input to diagnostics.
export async function routeBoundary<T extends Response>(
  work: () => Promise<T>,
): Promise<T | Response> {
  try {
    return await work();
  } catch (error) {
    logFailure(logger, error, "web", "request");
    return Response.json(
      { error: "Request could not be completed." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export async function pageBoundary<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    // Preserve Next redirect/notFound/dynamic rendering control flow.
    unstable_rethrow(error);
    logFailure(logger, error, "web", "render");
    throw new Error("Maildock page could not be loaded.");
  }
}
