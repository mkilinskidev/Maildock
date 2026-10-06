import { routeBoundary } from "@/shared/infrastructure/logging/web-boundary";
import { requireJsonMediaType } from "@/modules/auth/application/json-media-type";
import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";
import { signatureService } from "@/modules/accounts/infrastructure/accounts";
import {
  readDraftRequest,
  draftApiError,
} from "@/modules/mail/application/draft-api";
import { z } from "zod";
export async function GET(request: Request) {
  return routeBoundary(async () => {
    const denied = await requireOwnerApiAccess(request);
    if (denied) return denied;
    try {
      return Response.json(await signatureService.catalog(), {
        headers: { "Cache-Control": "private, no-store" },
      });
    } catch (e) {
      return draftApiError(e);
    }
  });
}
export async function POST(request: Request) {
  return routeBoundary(async () => {
    const denied = await requireOwnerApiAccess(request);
    if (denied) return denied;
    const unsupported = requireJsonMediaType(request);
    if (unsupported) return unsupported;
    try {
      const { id, ...values } = z
        .object({ id: z.uuid(), name: z.string(), richDocument: z.unknown() })
        .strict()
        .parse(await readDraftRequest(request));
      return Response.json(await signatureService.save(id, values), {
        status: 201,
      });
    } catch (e) {
      return draftApiError(e);
    }
  });
}
