export function credentialAvailability(account: {
  authMethod: string;
  oauthStatus: string | null;
  oauthFailureCategory?: string | null;
  oauthRefreshAttempt?: string | null;
}) {
  if (account.authMethod !== "oauth2") return null;
  if (account.oauthStatus === "reconnect_required") {
    const rejected = account.oauthFailureCategory === "rejected_grant";
    return {
      state: "reconnect_required" as const,
      message: rejected
        ? "Your mail provider rejected authorization. Reconnect this account to resume synchronization."
        : "Your mail connection requires authorization. The previous renewal outcome may be unknown. Reconnect this account to resume synchronization safely.",
      settingsPath: "/accounts",
    };
  }
  if (account.oauthRefreshAttempt)
    return {
      state: "temporary" as const,
      message:
        "Authorization renewal has not completed. Synchronization is paused. If this persists, reconnect this account in account settings.",
      settingsPath: "/accounts",
    };
  if (account.oauthFailureCategory === "temporary")
    return {
      state: "temporary" as const,
      message:
        "Authorization is temporarily unavailable. Synchronization will retry. You can check account settings or retry loading this message.",
      settingsPath: "/accounts",
    };
  return null;
}
