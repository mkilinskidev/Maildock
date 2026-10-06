import { createAuthEndpoint } from "better-auth/api";
import { deleteSessionCookie } from "better-auth/cookies";

// Pathless server API only: Better Auth never registers an HTTP endpoint.
// Keep cookie names, prefixes, attributes and chunk cleanup owned by Better Auth.
export const logoutCookies = {
  id: "maildock-logout-cookies",
  endpoints: {
    clearLogoutCookies: createAuthEndpoint.serverOnly(
      { method: "POST", requireHeaders: true },
      async (ctx) => {
        deleteSessionCookie(ctx);
        return ctx.json({});
      },
    ),
  },
};
