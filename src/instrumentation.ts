export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { validateDatabaseAuthority } =
      await import("./shared/infrastructure/database/database-authority");
    const { createDatabase } =
      await import("./shared/infrastructure/database/database");
    const { getConfig } = await import("./shared/infrastructure/config/config");
    const { logFailure } =
      await import("./shared/infrastructure/logging/diagnostics");
    const { createLogger } =
      await import("./shared/infrastructure/logging/logger");
    const { startBootstrapLifecycle } =
      await import("./modules/auth/infrastructure/bootstrap-startup");
    try {
      const database = createDatabase(getConfig());
      try {
        await validateDatabaseAuthority(database.client);
        const { assertNativeReleaseCompatible } =
          await import("./shared/infrastructure/database/native-release-guard");
        await assertNativeReleaseCompatible(database.client);
        await startBootstrapLifecycle(
          database.db,
          (error) =>
            logFailure(
              createLogger({ logLevel: "info" }),
              error,
              "web",
              "startup",
              "fatal",
            ),
          () => database.client.end(),
        );
      } catch (error) {
        await database.client.end();
        throw error;
      }
    } catch (error) {
      logFailure(
        createLogger({ logLevel: "info" }),
        error,
        "web",
        "startup",
        "fatal",
      );
      // Next reports a rejected hook but can leave its HTTP process alive.
      // Refuse the independently launched web root before it can serve work.
      process.exit(1);
    }
  }
}
