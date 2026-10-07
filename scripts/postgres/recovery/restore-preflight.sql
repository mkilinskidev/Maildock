DO $$
BEGIN
  IF current_user <> session_user
    OR NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname=session_user AND oid<>10 AND rolcanlogin
      AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
    OR EXISTS (SELECT FROM pg_catalog.pg_auth_members WHERE member=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=session_user))
    OR NOT EXISTS (SELECT FROM pg_catalog.pg_database WHERE datname=current_database() AND datdba=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=session_user))
    OR NOT pg_catalog.has_schema_privilege(session_user,'public','USAGE,CREATE')
    OR EXISTS (SELECT FROM pg_catalog.pg_namespace WHERE nspname NOT IN ('public','pg_catalog','information_schema') AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp%')
    OR EXISTS (SELECT FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public')
    OR EXISTS (SELECT FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public')
    OR EXISTS (SELECT FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public')
    OR EXISTS (SELECT FROM pg_catalog.pg_roles WHERE oid=10 AND rolcanlogin)
    OR EXISTS (SELECT FROM pg_catalog.pg_namespace WHERE nspname IN ('pg_catalog','information_schema') AND nspowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=session_user))
  THEN RAISE EXCEPTION 'Recovery destination refused.'; END IF;
END
$$;
