import type { AppConfig } from "@/shared/infrastructure/config/config";

export function hasValidOrigin(
  request: Request,
  config: Pick<AppConfig, "appOrigin">,
): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && origin === config.appOrigin;
}
