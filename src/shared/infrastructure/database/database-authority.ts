import type postgres from "postgres";

export class DatabaseAuthorityError extends Error {
  constructor(
    readonly category: "database_authority" | "database_unavailable",
  ) {
    super(
      category === "database_authority"
        ? "Database authority refused. Provision an ordinary scoped application owner before starting Maildock."
        : "Database authority validation unavailable. Check database connectivity before starting Maildock.",
    );
    this.name = "DatabaseAuthorityError";
    this.stack = undefined;
  }
}

// One read-only catalog snapshot per process root, before any business work.
// Walk every membership edge conservatively, including NOINHERIT/SET paths.
// Predefined roles grant server/catalog authority even without role flags.
export async function validateDatabaseAuthority(client: postgres.Sql) {
  try {
    const [result] = await client`
      WITH RECURSIVE identity AS (
        SELECT * FROM pg_catalog.pg_roles WHERE rolname = session_user
      ), reachable(oid) AS (
        SELECT oid FROM identity
        UNION
        SELECT m.roleid FROM pg_catalog.pg_auth_members m
        JOIN reachable r ON m.member = r.oid
      )
      SELECT
        EXISTS (SELECT FROM identity WHERE oid <> 10 AND rolcanlogin
          AND current_user = session_user) AS identity_ok,
        NOT EXISTS (SELECT FROM reachable r JOIN pg_catalog.pg_roles p ON p.oid = r.oid
          WHERE p.oid = 10 OR p.rolsuper OR p.rolcreatedb OR p.rolcreaterole
            OR p.rolreplication OR p.rolbypassrls
            OR (p.rolname LIKE 'pg\\_%' ESCAPE '\\' AND p.rolname <> 'pg_database_owner')) AS authority_ok,
        pg_catalog.has_database_privilege(session_user, current_database(), 'CONNECT')
          AND pg_catalog.has_database_privilege(session_user, current_database(), 'CREATE')
          AND pg_catalog.has_schema_privilege(session_user, 'public', 'USAGE')
          AND pg_catalog.has_schema_privilege(session_user, 'public', 'CREATE')
          AND pg_catalog.has_language_privilege(session_user, 'sql', 'USAGE')
          AND pg_catalog.has_language_privilege(session_user, 'plpgsql', 'USAGE') AS scope_ok,
        NOT EXISTS (SELECT FROM pg_catalog.pg_namespace n
          WHERE n.nspname IN ('drizzle','pgboss')
            AND (NOT pg_catalog.has_schema_privilege(session_user, n.oid, 'USAGE')
              OR NOT pg_catalog.has_schema_privilege(session_user, n.oid, 'CREATE')
              OR NOT pg_catalog.pg_has_role(session_user, n.nspowner, 'USAGE'))) AS schemas_ok,
        NOT EXISTS (SELECT FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname IN ('public','drizzle','pgboss') AND c.relkind IN ('r','p','S','v','m','f')
            AND NOT pg_catalog.pg_has_role(session_user, c.relowner, 'USAGE'))
          AND NOT EXISTS (SELECT FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname IN ('public','drizzle','pgboss')
              AND NOT pg_catalog.pg_has_role(session_user, p.proowner, 'USAGE'))
          AND NOT EXISTS (SELECT FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
            WHERE n.nspname IN ('public','drizzle','pgboss')
              AND NOT pg_catalog.pg_has_role(session_user, t.typowner, 'USAGE')) AS objects_ok,
        NOT EXISTS (SELECT FROM pg_catalog.pg_namespace n JOIN reachable r ON n.nspowner = r.oid
          WHERE n.nspname IN ('pg_catalog','information_schema'))
          AND NOT EXISTS (SELECT FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            JOIN reachable r ON c.relowner = r.oid WHERE n.nspname IN ('pg_catalog','information_schema'))
          AND NOT EXISTS (SELECT FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
            JOIN reachable r ON p.proowner = r.oid WHERE n.nspname IN ('pg_catalog','information_schema'))
          AND NOT EXISTS (SELECT FROM pg_catalog.pg_extension e JOIN reachable r ON e.extowner = r.oid
            WHERE e.extname = 'plpgsql') AS system_ok
    `;
    if (
      !result?.identity_ok ||
      !result.authority_ok ||
      !result.scope_ok ||
      !result.schemas_ok ||
      !result.objects_ok ||
      !result.system_ok
    )
      throw new DatabaseAuthorityError("database_authority");
  } catch (error) {
    if (error instanceof DatabaseAuthorityError) throw error;
    throw new DatabaseAuthorityError("database_unavailable");
  }
}
