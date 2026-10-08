\set ON_ERROR_STOP on
\set VERBOSITY terse
\set ECHO none
-- Bundled clusters only. Run with writers stopped; never from app startup.
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(1296125024);
SET LOCAL search_path = pg_catalog, pg_temp;

CREATE FUNCTION pg_temp.maildock_check_authority(owner_oid oid, hardened boolean)
RETURNS void LANGUAGE plpgsql AS $check$
DECLARE
  app pg_catalog.pg_roles;
  bootstrap pg_catalog.pg_roles;
BEGIN
  SELECT * INTO STRICT app FROM pg_roles WHERE rolname = 'maildock';
  SELECT * INTO STRICT bootstrap FROM pg_roles WHERE oid = 10;
  IF current_database() <> 'maildock' OR app.oid <> owner_oid
     OR NOT app.rolcanlogin OR app.rolconnlimit <> -1 OR app.rolvaliduntil IS NOT NULL
     OR app.rolconfig IS NOT NULL
     OR (hardened AND (app.oid = 10 OR app.rolsuper OR app.rolcreatedb
         OR app.rolcreaterole OR app.rolreplication OR app.rolbypassrls))
     OR (NOT hardened AND (app.oid <> 10 OR NOT app.rolsuper OR NOT app.rolcreatedb
         OR NOT app.rolcreaterole OR NOT app.rolreplication OR NOT app.rolbypassrls))
     OR (hardened AND (bootstrap.rolname <> 'maildock_bootstrap'
         OR bootstrap.rolcanlogin OR NOT bootstrap.rolsuper))
     OR EXISTS (SELECT FROM pg_roles WHERE rolname = 'maildock_hardening_bridge')
     OR EXISTS (SELECT FROM pg_roles WHERE oid >= 16384 AND oid <> owner_oid)
     OR EXISTS (SELECT FROM pg_auth_members WHERE member IN (10, owner_oid)
         OR roleid IN (10, owner_oid))
     OR EXISTS (SELECT FROM pg_db_role_setting)
     OR EXISTS (SELECT FROM pg_default_acl)
     OR EXISTS (SELECT FROM pg_database WHERE datname NOT IN ('maildock','postgres','template0','template1')
         OR datdba <> CASE WHEN datname = 'maildock' THEN owner_oid ELSE 10 END
         OR (datname IN ('maildock','postgres') AND datacl IS NOT NULL)
         OR (datname IN ('template0','template1') AND datacl IS DISTINCT FROM
           format('{=c/%1$s,%1$s=CTc/%1$s}', bootstrap.rolname)::aclitem[]))
     OR EXISTS (SELECT FROM pg_namespace WHERE nspname NOT IN ('public','drizzle','pgboss','pg_catalog','information_schema','pg_toast')
         AND nspname !~ '^pg_(toast_)?temp_[0-9]+$')
     OR EXISTS (SELECT FROM pg_namespace WHERE nspname IN ('drizzle','pgboss')
         AND (nspowner <> owner_oid OR nspacl IS NOT NULL))
     OR EXISTS (SELECT FROM pg_namespace WHERE nspname IN ('pg_catalog','information_schema') AND nspowner <> 10)
     OR EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname IN ('pg_catalog','information_schema')
           AND (c.relowner <> 10 OR (n.nspname = 'pg_catalog' AND c.oid >= 16384)))
     OR EXISTS (SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname IN ('pg_catalog','information_schema')
           AND (p.proowner <> 10 OR (n.nspname = 'pg_catalog' AND p.oid >= 16384)))
     OR NOT EXISTS (SELECT FROM pg_namespace WHERE nspname = 'public'
         AND nspowner = 'pg_database_owner'::regrole
         AND nspacl = ARRAY['pg_database_owner=UC/pg_database_owner','=U/pg_database_owner']::aclitem[])
  THEN RAISE EXCEPTION 'unsupported'; END IF;

  -- Public is shared with PostgreSQL, so only the reviewed Maildock inventory
  -- is eligible. Queue partitions are inventoried by dependency, never counts.
  IF EXISTS (
    SELECT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public','drizzle','pgboss') AND (
      c.relowner <> owner_oid OR c.relacl IS NOT NULL
      OR c.relkind NOT IN ('r','p','i','I','S')
      OR (n.nspname = 'public' AND c.relkind IN ('r','p') AND c.relname NOT IN (
        'account','account_signature_defaults','application_events','auth_admission','blobs',
        'conversation_members','conversation_references','conversations','draft_attachments','drafts',
        'instance_state','login_throttle','mail_accounts','mailbox_messages','mailbox_roles','mailboxes',
        'message_attachments','message_commands','message_contents','messages','mfa_replacement',
        'notification_events','oauth_authorization_states','oauth_provider_configs',
        'outgoing_message_attachments','outgoing_messages','owner_recovery','rate_limit','recovery_maintenance','remote_content_senders',
        'session','signature_resources','signatures','staged_attachments','two_factor','user','verification'))
      OR (n.nspname = 'public' AND c.relkind = 'S' AND c.relname <> 'mail_account_order_seq')
      OR (n.nspname = 'drizzle' AND c.relkind IN ('r','p','S')
        AND c.relname NOT IN ('__drizzle_migrations','__drizzle_migrations_id_seq'))
      OR (n.nspname = 'pgboss' AND c.relkind IN ('r','p') AND c.relname NOT IN (
        'version','queue','schedule','subscription','bam','job','job_common','warning','queue_stats','job_dependency')
        AND NOT EXISTS (SELECT FROM pg_inherits h JOIN pg_class parent ON parent.oid = h.inhparent
          WHERE h.inhrelid = c.oid AND parent.relnamespace = n.oid
          AND parent.relname IN ('job','queue_stats')))
      OR (n.nspname = 'pgboss' AND c.relkind = 'S')
      OR (c.relkind IN ('i','I') AND NOT EXISTS
        (SELECT FROM pg_index i WHERE i.indexrelid = c.oid))
    )
  ) OR EXISTS (
    SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public','drizzle','pgboss') AND (
      p.proowner <> owner_oid OR p.proacl IS NOT NULL OR p.prosecdef OR p.prokind <> 'f'
      OR n.nspname = 'drizzle'
      OR (n.nspname = 'public' AND (p.proname, oidvectortypes(p.proargtypes)) NOT IN (
        ('maildock_outgoing_snapshot_immutable',''),('maildock_blob_snapshot_immutable',''),
        ('maildock_thread_ids','text'),('maildock_reconcile_conversation','uuid, boolean'),
        ('maildock_conversation_trigger',''),('maildock_search_addresses','jsonb'),
        ('maildock_search_vector','text, jsonb, jsonb, jsonb, jsonb, text'),
        ('maildock_update_search_body','')))
      OR (n.nspname = 'pgboss' AND (p.proname, oidvectortypes(p.proargtypes)) NOT IN (
        ('job_now',''),('job_table_format','text, text'),('job_table_run','text, text, text'),
        ('job_table_run_async','text, integer, text, text, text'),
        ('create_queue','text, jsonb'),('delete_queue','text')))
    )
  ) OR EXISTS (
    SELECT FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname IN ('public','drizzle','pgboss') AND (
      t.typowner <> owner_oid OR t.typacl IS NOT NULL
      OR NOT (t.typrelid <> 0 OR t.typelem <> 0
        OR (n.nspname = 'pgboss' AND t.typname = 'job_state' AND t.typtype = 'e')))
  ) OR EXISTS (SELECT FROM pg_extension WHERE extname <> 'plpgsql' OR extowner <> 10)
    OR EXISTS (SELECT FROM pg_foreign_server)
    OR EXISTS (SELECT FROM pg_foreign_data_wrapper)
    OR EXISTS (SELECT FROM pg_event_trigger)
    OR EXISTS (SELECT FROM pg_publication)
    OR EXISTS (SELECT oid FROM pg_subscription)
    OR EXISTS (SELECT FROM pg_language WHERE lanname NOT IN ('internal','c','sql','plpgsql'))
  THEN RAISE EXCEPTION 'unsupported'; END IF;
END
$check$;

DO $authority$
DECLARE
  owner_oid oid;
  object record;
  verifier text;
BEGIN
  SELECT oid INTO STRICT owner_oid FROM pg_roles WHERE rolname = 'maildock';
  PERFORM pg_temp.maildock_check_authority(owner_oid, owner_oid <> 10);
  IF owner_oid <> 10 THEN RETURN; END IF;
  IF session_user <> 'maildock' OR current_user <> session_user
    OR EXISTS (SELECT FROM pg_stat_activity WHERE usesysid = 10 AND pid <> pg_backend_pid()
      AND backend_type IN ('client backend','walsender'))
  THEN RAISE EXCEPTION 'unsupported'; END IF;

  -- Never send the verifier to the client or retain a second login credential.
  -- Stock PostgreSQL logging is disabled locally for verifier-bearing DDL.
  PERFORM set_config('log_statement', 'none', true);
  PERFORM set_config('log_min_duration_statement', '-1', true);
  PERFORM set_config('log_min_error_statement', 'panic', true);
  SELECT rolpassword INTO STRICT verifier FROM pg_authid WHERE oid = 10;
  IF verifier IS NULL THEN RAISE EXCEPTION 'unsupported'; END IF;
  CREATE ROLE maildock_hardening_bridge NOLOGIN SUPERUSER PASSWORD NULL;
  SET SESSION AUTHORIZATION maildock_hardening_bridge;
  ALTER ROLE maildock RENAME TO maildock_bootstrap;
  EXECUTE format('CREATE ROLE maildock LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', verifier);
  verifier := NULL;
  ALTER DATABASE maildock OWNER TO maildock;

  FOR object IN SELECT n.nspname, c.relname, c.relkind FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public','drizzle','pgboss') AND c.relkind IN ('r','p')
  LOOP EXECUTE format('ALTER TABLE %I.%I OWNER TO maildock', object.nspname, object.relname); END LOOP;
  FOR object IN SELECT n.nspname, c.relname FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public','drizzle','pgboss') AND c.relkind = 'S'
  LOOP EXECUTE format('ALTER SEQUENCE %I.%I OWNER TO maildock', object.nspname, object.relname); END LOOP;
  FOR object IN SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public','drizzle','pgboss')
  LOOP EXECUTE format('ALTER FUNCTION %I.%I(%s) OWNER TO maildock', object.nspname, object.proname, object.args); END LOOP;
  IF to_regtype('pgboss.job_state') IS NOT NULL THEN ALTER TYPE pgboss.job_state OWNER TO maildock; END IF;
  FOR object IN SELECT nspname FROM pg_namespace WHERE nspname IN ('drizzle','pgboss')
  LOOP EXECUTE format('ALTER SCHEMA %I OWNER TO maildock', object.nspname); END LOOP;
  ALTER ROLE maildock_bootstrap NOLOGIN PASSWORD NULL;
  IF EXISTS (SELECT FROM pg_authid WHERE oid = 10 AND rolpassword IS NOT NULL)
  THEN RAISE EXCEPTION 'unsupported'; END IF;
  SET SESSION AUTHORIZATION maildock_bootstrap;
  DROP ROLE maildock_hardening_bridge;
  SELECT oid INTO STRICT owner_oid FROM pg_roles WHERE rolname = 'maildock';
  PERFORM pg_temp.maildock_check_authority(owner_oid, true);
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Maildock database authority transition refused. Stop writers, verify backup and request DBA review of the bundled cluster; no changes committed.';
END
$authority$;
DROP FUNCTION pg_temp.maildock_check_authority(oid, boolean);
COMMIT;
