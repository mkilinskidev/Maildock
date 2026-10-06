import { routeBoundary } from "@/shared/infrastructure/logging/web-boundary";
import { requireJsonMediaType } from "@/modules/auth/application/json-media-type";
import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";
import { outgoingMessageService } from "@/modules/accounts/infrastructure/accounts";
import {
  readDraftRequest,
  draftApiError,
} from "@/modules/mail/application/draft-api";
import { draftRevision } from "@/modules/mail/domain/draft";
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return routeBoundary(async () => {
    const denied = await requireOwnerApiAccess(request);
    if (denied) return denied;
    const unsupported = requireJsonMediaType(request);
    if (unsupported) return unsupported;
    try {
      const { id } = await context.params;
      const { expectedRevision } = draftRevision.parse(
        await readDraftRequest(request),
      );
      return Response.json(
        await outgoingMessageService.create(undefined, {
          id,
          expectedRevision,
        }),
        { status: 202 },
      );
    } catch (e) {
      return draftApiError(e);
    }
  });
}
