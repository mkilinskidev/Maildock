import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";
import { draftService } from "@/modules/accounts/infrastructure/accounts";
import {
  readDraftRequest,
  draftApiError,
} from "@/modules/mail/application/draft-api";
export async function GET(request: Request) {
  const denied = await requireOwnerApiAccess(request, false);
  if (denied) return denied;
  try {
    return Response.json(await draftService.list(), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (e) {
    return draftApiError(e);
  }
}
export async function POST(request: Request) {
  const denied = await requireOwnerApiAccess(request, true);
  if (denied) return denied;
  try {
    return Response.json(
      await draftService.create(await readDraftRequest(request)),
      { status: 201 },
    );
  } catch (e) {
    return draftApiError(e);
  }
}
