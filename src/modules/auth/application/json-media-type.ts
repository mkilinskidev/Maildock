/** Application JSON endpoints accept JSON with optional media-type parameters. */
export function requireJsonMediaType(request: Request): Response | null {
  const mediaType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    return Response.json(
      { error: "Content-Type must be application/json." },
      { status: 415 },
    );
  }
  return null;
}
