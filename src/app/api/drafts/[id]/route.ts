import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";
import { draftService } from "@/modules/accounts/infrastructure/accounts";
import {
  readDraftRequest,
  draftApiError,
} from "@/modules/mail/application/draft-api";
import { draftRevision } from "@/modules/mail/domain/draft";
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const denied = await requireOwnerApiAccess(request, false);
  if (denied) return denied;
  try {
    const { id } = await context.params;
    return Response.json(await draftService.get(id), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (e) {
    return draftApiError(e);
  }
}
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const denied = await requireOwnerApiAccess(request, true);
  if (denied) return denied;
  try {
    const { id } = await context.params;
    return Response.json(
      await draftService.update(id, await readDraftRequest(request)),
    );
  } catch (e) {
    return draftApiError(e);
  }
}
export async function DELETE(
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
    await draftService.discard(id, expectedRevision);
    return new Response(null, { status: 204 });
  } catch (e) {
    return draftApiError(e);
  }
}
