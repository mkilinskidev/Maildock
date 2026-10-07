import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";
import { signatureService } from "@/modules/accounts/infrastructure/accounts";
import {
  readDraftRequest,
  draftApiError,
} from "@/modules/mail/application/draft-api";
import { z } from "zod";
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const denied = await requireOwnerApiAccess(request, true);
  if (denied) return denied;
  try {
    const { draftId } = z
      .object({ draftId: z.uuid() })
      .strict()
      .parse(await readDraftRequest(request));
    return Response.json(
      await signatureService.snapshot(
        z.uuid().parse((await context.params).id),
        draftId,
      ),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    return draftApiError(e);
  }
}
