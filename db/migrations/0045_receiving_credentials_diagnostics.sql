ALTER TABLE mail_accounts ADD COLUMN oauth_refresh_attempt uuid;
ALTER TABLE receiving_coordinator ADD COLUMN diagnostic_endpoint text
  CHECK (octet_length(diagnostic_endpoint)<=512);
--> statement-breakpoint
CREATE FUNCTION maildock_receiving_diagnostic_endpoint(actor uuid, term bigint, endpoint text)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE lease receiving_coordinator%ROWTYPE;
BEGIN
  SELECT * INTO STRICT lease FROM receiving_coordinator WHERE singleton FOR UPDATE;
  IF actor IS NULL OR term IS NULL OR lease.owner IS DISTINCT FROM actor
    OR lease.generation<>term OR lease.expires_at<=clock_timestamp() THEN RETURN false; END IF;
  IF endpoint IS NOT NULL AND (octet_length(endpoint)>512 OR endpoint !~ '^http://[^/?#@]+$') THEN
    RAISE EXCEPTION 'Invalid internal diagnostic endpoint';
  END IF;
  UPDATE receiving_coordinator SET diagnostic_endpoint=endpoint WHERE singleton;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION maildock_receiving_diagnostic_endpoint(uuid,bigint,text) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION maildock_receiving_clear_old_endpoint() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner IS DISTINCT FROM OLD.owner OR NEW.generation<>OLD.generation
    OR NEW.expires_at='-infinity'::timestamptz THEN NEW.diagnostic_endpoint=NULL; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER receiving_diagnostic_term BEFORE UPDATE ON receiving_coordinator
  FOR EACH ROW EXECUTE FUNCTION maildock_receiving_clear_old_endpoint();

--> statement-breakpoint
CREATE FUNCTION maildock_receiving_diagnostic_result(actor uuid, term bigint, account uuid,
  configuration bigint, lifecycle bigint, success boolean, category text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF nullif(current_setting('maildock.diagnostic_owner',true),'') IS NOT NULL THEN
    RAISE EXCEPTION 'Diagnostic publication is single-use'; END IF;
  IF NOT maildock_receiving_validate(actor,term) THEN RAISE EXCEPTION 'Diagnostic owner fenced'; END IF;
  PERFORM 1 FROM mail_accounts WHERE id=account AND enabled AND removal_requested_at IS NULL
    AND configuration_version=configuration AND receiving_lifecycle_version=lifecycle FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Diagnostic configuration fenced'; END IF;
  IF success IS NULL OR (NOT success AND (category IS NULL OR category NOT IN ('dns_or_host_unreachable','connection_timeout',
    'tls_certificate_failure','authentication_rejected','starttls_unavailable','verification_failed','internal_error')))
    THEN RAISE EXCEPTION 'Invalid diagnostic result'; END IF;
  PERFORM set_config('maildock.diagnostic_owner',jsonb_build_object('actor',actor,'term',term,'account',account,'configuration',configuration,'lifecycle',lifecycle)::text,true);
  UPDATE mail_accounts SET imap_status=CASE WHEN success THEN 'success' ELSE 'error' END,
    imap_error=CASE WHEN success THEN NULL ELSE 'IMAP connection test failed.' END,
    connection_status=CASE WHEN success AND smtp_status='success' THEN 'verified' ELSE 'error' END,
    last_successful_connection_test_at=CASE WHEN success AND smtp_status='success' THEN clock_timestamp()
      ELSE last_successful_connection_test_at END, updated_at=clock_timestamp() WHERE id=account;
END $$;
REVOKE ALL ON FUNCTION maildock_receiving_diagnostic_result(uuid,bigint,uuid,bigint,bigint,boolean,text) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION maildock_receiving_diagnostic_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE certificate jsonb;
BEGIN
  certificate:=nullif(current_setting('maildock.diagnostic_owner',true),'')::jsonb;
  IF certificate IS NOT NULL THEN
    IF NOT maildock_receiving_validate((certificate->>'actor')::uuid,(certificate->>'term')::bigint)
      THEN RAISE EXCEPTION 'Diagnostic COMMIT owner fenced'; END IF;
    PERFORM 1 FROM mail_accounts WHERE id=(certificate->>'account')::uuid AND enabled
      AND removal_requested_at IS NULL AND configuration_version=(certificate->>'configuration')::bigint
      AND receiving_lifecycle_version=(certificate->>'lifecycle')::bigint FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Diagnostic COMMIT configuration fenced'; END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER receiving_diagnostic_commit AFTER UPDATE ON mail_accounts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION maildock_receiving_diagnostic_commit();
