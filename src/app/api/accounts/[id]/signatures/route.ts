import { requireJsonMediaType } from "@/modules/auth/application/json-media-type";
import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";
import { signatureService } from "@/modules/accounts/infrastructure/accounts";
import {
  readDraftRequest,
  draftApiError,
} from "@/modules/mail/application/draft-api";
import { z } from "zod";
export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const denied = await requireOwnerApiAccess(request);
  if (denied) return denied;
  const unsupported = requireJsonMediaType(request);
  if (unsupported) return unsupported;
  try {
    return Response.json(
      await signatureService.setDefaults(
        z.uuid().parse((await context.params).id),
        await readDraftRequest(request),
      ),
    );
  } catch (e) {
    return draftApiError(e);
  }
}
