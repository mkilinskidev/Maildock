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
  const denied = await requireOwnerApiAccess(request, true);
  if (denied) return denied;
  try {
    const { id } = await context.params;
    const { expectedRevision } = draftRevision.parse(
      await readDraftRequest(request),
    );
    return Response.json(
      await outgoingMessageService.create(undefined, { id, expectedRevision }),
      { status: 202 },
    );
  } catch (e) {
    return draftApiError(e);
  }
}
