import { ZodError } from "zod";

import {
  initializeOwner,
  InstanceAlreadyInitializedError,
  isInstanceInitialized,
  setupInputSchema,
} from "@/modules/auth/application/instance-auth";
import { hasValidOrigin } from "@/modules/auth/application/origin";
import { getConfig } from "@/shared/infrastructure/config/config";
import { db } from "@/shared/infrastructure/database/runtime-database";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(
    { initialized: await isInstanceInitialized(db) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  if (!hasValidOrigin(request, getConfig())) {
    return Response.json({ error: "Invalid request origin." }, { status: 403 });
  }

  try {
    const contentType = request.headers.get("content-type") ?? "";
    const submittedAsForm =
      contentType.startsWith("application/x-www-form-urlencoded") ||
      contentType.startsWith("multipart/form-data");
    const rawInput = submittedAsForm
      ? Object.fromEntries(await request.formData())
      : await request.json();
    const input = setupInputSchema.parse(rawInput);
    await initializeOwner(db, input);
    if (submittedAsForm) {
      return Response.redirect(new URL("/login", request.url), 303);
    }
    return Response.json({ initialized: true }, { status: 201 });
  } catch (error) {
    if (error instanceof InstanceAlreadyInitializedError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof ZodError) {
      return Response.json(
        { error: "Username or password does not meet the requirements." },
        { status: 400 },
      );
    }
    return Response.json(
      { error: "Setup could not be completed." },
      { status: 500 },
    );
  }
}
