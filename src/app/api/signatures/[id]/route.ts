import { requireJsonMediaType } from "@/modules/auth/application/json-media-type";
import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";
import { signatureService } from "@/modules/accounts/infrastructure/accounts";
import {
  readDraftRequest,
  draftApiError,
} from "@/modules/mail/application/draft-api";
import { z } from "zod";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  const denied = await requireOwnerApiAccess(request);
  if (denied) return denied;
  try {
    return Response.json(
      await signatureService.get(z.uuid().parse((await context.params).id)),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    return draftApiError(e);
  }
}
export async function PATCH(request: Request, context: Context) {
  const denied = await requireOwnerApiAccess(request);
  if (denied) return denied;
  const unsupported = requireJsonMediaType(request);
  if (unsupported) return unsupported;
  try {
    const { expectedRevision, ...values } = z
      .object({
        expectedRevision: z.number().int().positive(),
        name: z.string(),
        richDocument: z.unknown(),
      })
      .strict()
      .parse(await readDraftRequest(request));
    return Response.json(
      await signatureService.save(
        z.uuid().parse((await context.params).id),
        values,
        expectedRevision,
      ),
    );
  } catch (e) {
    return draftApiError(e);
  }
}
export async function DELETE(request: Request, context: Context) {
  const denied = await requireOwnerApiAccess(request);
  if (denied) return denied;
  const unsupported = requireJsonMediaType(request);
  if (unsupported) return unsupported;
  try {
    const { expectedRevision } = z
      .object({ expectedRevision: z.number().int().positive() })
      .strict()
      .parse(await readDraftRequest(request));
    await signatureService.delete(
      z.uuid().parse((await context.params).id),
      expectedRevision,
    );
    return new Response(null, { status: 204 });
  } catch (e) {
    return draftApiError(e);
  }
}
