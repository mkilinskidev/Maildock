import { routeBoundary } from "@/shared/infrastructure/logging/web-boundary";
import { requireOwnerApiAccess } from "@/modules/auth/application/api-access";
import { db } from "@/shared/infrastructure/database/runtime-database";
import {
  MAX_SEARCH_QUERY_LENGTH,
  SearchService,
} from "@/modules/mail/application/search-service";

export const dynamic = "force-dynamic";
const searchService = new SearchService(db);
const headers = { "Cache-Control": "no-store" };
export async function GET(request: Request) {
  return routeBoundary(async () => {
    const denied = await requireOwnerApiAccess(request);
    if (denied) return denied;
    const query = new URL(request.url).searchParams.get("q") ?? "";
    if (query.length > MAX_SEARCH_QUERY_LENGTH)
      return Response.json(
        { error: "Search queries must be at most 256 characters." },
        { status: 400, headers },
      );
    if (query.includes("\0"))
      return Response.json(
        { error: "Invalid search query." },
        { status: 400, headers },
      );
    try {
      return Response.json(await searchService.search(query), { headers });
    } catch {
      return Response.json(
        { error: "Mail search is temporarily unavailable." },
        { status: 500, headers },
      );
    }
  });
}
