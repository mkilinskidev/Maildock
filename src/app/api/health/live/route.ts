import { routeBoundary } from "@/shared/infrastructure/logging/web-boundary";
export const dynamic = "force-dynamic";

export async function GET() {
  return routeBoundary(async () => {
    return Response.json(
      { status: "alive" },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  });
}
