-- Quiet, empty-page observation settles a scheduling hint without fabricating
-- a frontier/revision change. No new fact-writing authority is introduced.
CREATE FUNCTION maildock_receiving_observation_due(actor uuid, term bigint, mailbox uuid,
  account uuid, binding bigint, lifecycle bigint, expected jsonb, request_generation bigint, poll_ms integer)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE s receiving_mailboxes%ROWTYPE; b mailboxes%ROWTYPE; certificate jsonb;
BEGIN
  IF nullif(current_setting('maildock.receiving_observation_due',true),'') IS NOT NULL
    OR actor IS NULL OR term IS NULL OR request_generation IS NULL OR request_generation<0
    OR poll_ms IS NULL OR poll_ms<1 OR poll_ms>2147483647 THEN RAISE EXCEPTION 'Invalid observation settlement'; END IF;
  PERFORM maildock_receiving_lock(actor,term,mailbox);
  PERFORM maildock_receiving_account_identity(account,binding,lifecycle);
  SELECT * INTO STRICT s FROM receiving_mailboxes WHERE mailbox_id=mailbox FOR UPDATE;
  SELECT * INTO STRICT b FROM mailboxes WHERE id=mailbox;
  IF b.account_id IS DISTINCT FROM account OR b.remote_path<>'INBOX' OR s.configuration_binding IS DISTINCT FROM binding
    OR b.uid_validity IS DISTINCT FROM s.epoch
    OR expected IS DISTINCT FROM jsonb_build_object('epoch',s.epoch::text,'revision',s.revision::text,
      'freshThrough',s.fresh_through::text,'historyBefore',s.history_before::text,'reconcileAfter',s.reconcile_after::text)
    OR s.reconcile_after<>0 OR EXISTS(SELECT FROM mailbox_messages WHERE mailbox_id=mailbox
      AND configuration_binding=binding AND uid_validity=s.epoch LIMIT 1)
    THEN RAISE EXCEPTION 'Empty observation identity or page fenced'; END IF;
  IF b.receiving_request_generation<>request_generation THEN RETURN; END IF;
  certificate:=jsonb_build_object('actor',actor,'term',term,'account',account,'binding',binding,'lifecycle',lifecycle,
    'state',to_jsonb(s),'old',to_jsonb(b),'new',to_jsonb(b) || jsonb_build_object('receiving_due_at',clock_timestamp()+poll_ms*interval '1 millisecond'));
  PERFORM set_config('maildock.receiving_observation_due',certificate::text,true);
  UPDATE mailboxes SET receiving_due_at=(certificate->'new'->>'receiving_due_at')::timestamptz WHERE id=mailbox;
END $$;
REVOKE ALL ON FUNCTION maildock_receiving_observation_due(uuid,bigint,uuid,uuid,bigint,bigint,jsonb,bigint,integer) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION maildock_receiving_observation_due_check(relation text, operation text, old_row jsonb, new_row jsonb)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE c jsonb;
BEGIN
  c:=nullif(current_setting('maildock.receiving_observation_due',true),'')::jsonb;
  IF c IS NULL THEN RETURN false; END IF;
  IF relation<>'mailboxes' OR operation<>'UPDATE'
    OR old_row IS DISTINCT FROM c->'old' OR new_row IS DISTINCT FROM c->'new'
    OR c->'state' IS DISTINCT FROM (SELECT to_jsonb(s) FROM receiving_mailboxes s WHERE mailbox_id=(new_row->>'id')::uuid)
    THEN RAISE EXCEPTION 'Observation COMMIT certificate fenced'; END IF;
  PERFORM maildock_receiving_account_identity((c->>'account')::uuid,(c->>'binding')::bigint,(c->>'lifecycle')::bigint);
  IF NOT maildock_receiving_validate((c->>'actor')::uuid,(c->>'term')::bigint)
    THEN RAISE EXCEPTION 'Observation COMMIT owner fenced'; END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION maildock_receiving_observation_due_check(text,text,jsonb,jsonb) FROM PUBLIC;
--> statement-breakpoint
-- Global keyset selection cannot use the previous account-leading flag index.
CREATE INDEX message_commands_receiving_flag_page_idx ON message_commands(created_at,id)
  WHERE action IN ('mark_read','mark_unread','flag','unflag') AND status IN ('pending','executing','failed');

--> statement-breakpoint
-- Preserve historical/pending command provenance when exact membership evidence
-- removes a placement. Reuse exact OLD/NEW attempt permits, not an intent bypass.
CREATE FUNCTION maildock_receiving_membership_references(mailbox uuid, expected_revision bigint, epoch bigint, binding bigint, absent jsonb)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE s receiving_mailboxes%ROWTYPE; b mailboxes%ROWTYPE; r message_commands%ROWTYPE; n message_commands%ROWTYPE;
  certificates jsonb:='[]'; total integer:=0;
BEGIN
  IF current_setting('maildock.receiving_mailbox',true) IS DISTINCT FROM mailbox::text
    OR current_setting('maildock.receiving_revision',true) IS DISTINCT FROM expected_revision::text
    OR nullif(current_setting('maildock.receiving_bounded_scope',true),'') IS NOT NULL
    OR nullif(current_setting('maildock.receiving_operation',true),'') IS NOT NULL
    OR nullif(current_setting('maildock.receiving_removed_references',true),'') IS NOT NULL
    OR jsonb_typeof(absent) IS DISTINCT FROM 'array' OR jsonb_array_length(absent)>128
    THEN RAISE EXCEPTION 'Membership reference scope required'; END IF;
  SELECT * INTO STRICT s FROM receiving_mailboxes WHERE mailbox_id=mailbox FOR UPDATE;
  SELECT * INTO STRICT b FROM mailboxes WHERE id=mailbox;
  IF s.revision IS DISTINCT FROM expected_revision OR s.epoch IS DISTINCT FROM epoch
    OR s.configuration_binding IS DISTINCT FROM binding OR b.uid_validity IS DISTINCT FROM epoch
    OR b.remote_path<>'INBOX' OR NOT maildock_receiving_validate(
      current_setting('maildock.receiving_owner',true)::uuid,current_setting('maildock.receiving_generation',true)::bigint)
    THEN RAISE EXCEPTION 'Membership reference authority fenced'; END IF;
  FOR r IN SELECT c.* FROM message_commands c JOIN mailbox_messages p ON p.id=c.placement_id
    WHERE p.mailbox_id=mailbox AND p.uid_validity=epoch AND p.configuration_binding=binding
      AND p.uid=ANY(ARRAY(SELECT jsonb_array_elements_text(absent))::bigint[])
    ORDER BY c.id LIMIT 129 FOR UPDATE OF c LOOP
    total:=total+1;
    IF total>128 OR r.account_id IS DISTINCT FROM b.account_id OR r.mailbox_id IS DISTINCT FROM mailbox
      THEN RAISE EXCEPTION 'Membership reference bound or identity fenced'; END IF;
    n:=r; n.placement_id:=NULL;
    PERFORM set_config('maildock.receiving_attempt_write',jsonb_build_object('relation','message_commands','old',to_jsonb(r),'new',to_jsonb(n))::text,true);
    UPDATE message_commands SET placement_id=NULL WHERE id=r.id;
    PERFORM set_config('maildock.receiving_attempt_write','',true);
    certificates:=certificates || jsonb_build_array(jsonb_build_object('placement',r.placement_id,'new',to_jsonb(n)));
    IF octet_length(certificates::text)>2097152 THEN RAISE EXCEPTION 'Membership reference certificate bound'; END IF;
  END LOOP;
  IF certificates<>'[]'::jsonb THEN PERFORM set_config('maildock.receiving_removed_references',certificates::text,true); END IF;
END $$;
REVOKE ALL ON FUNCTION maildock_receiving_membership_references(uuid,bigint,bigint,bigint,jsonb) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION maildock_receiving_membership_references_commit() RETURNS void LANGUAGE plpgsql AS $$
DECLARE certificates jsonb;
BEGIN
  certificates:=nullif(current_setting('maildock.receiving_removed_references',true),'')::jsonb;
  IF certificates IS NULL THEN RETURN; END IF;
  IF EXISTS(SELECT FROM jsonb_array_elements(certificates) c
    LEFT JOIN mailbox_messages p ON p.id=(c->>'placement')::uuid
    LEFT JOIN message_commands r ON r.id=(c->'new'->>'id')::uuid
    WHERE p.id IS NOT NULL OR c->'new' IS DISTINCT FROM to_jsonb(r))
    THEN RAISE EXCEPTION 'Membership reference COMMIT fenced'; END IF;
END $$;
REVOKE ALL ON FUNCTION maildock_receiving_membership_references_commit() FROM PUBLIC;
--> statement-breakpoint
-- Add only the exact hint-only branch; accepted R14 authority follows unchanged.
CREATE OR REPLACE FUNCTION maildock_receiving_commit_authority() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE lease receiving_coordinator%ROWTYPE; state receiving_mailboxes%ROWTYPE;
  folder mailboxes%ROWTYPE; enabled_account boolean; expected bigint;
BEGIN
  IF nullif(current_setting('maildock.receiving_removed_references',true),'') IS NOT NULL THEN
    PERFORM maildock_receiving_membership_references_commit(); END IF;
  IF nullif(current_setting('maildock.receiving_observation_due',true),'') IS NOT NULL THEN
    IF maildock_receiving_observation_due_check(TG_TABLE_NAME,TG_OP,to_jsonb(OLD),to_jsonb(NEW)) THEN RETURN NULL; END IF;
  END IF;
  IF maildock_receiving_bounded_commit() THEN RETURN NULL; END IF;
  -- Mandatory deferred phase; this check uses DB time after all lock waits.
  IF nullif(current_setting('maildock.receiving_mailbox',true),'') IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO STRICT lease FROM receiving_coordinator WHERE singleton FOR SHARE;
  SELECT * INTO STRICT folder FROM mailboxes WHERE id=nullif(current_setting('maildock.receiving_mailbox',true),'')::uuid FOR UPDATE;
  SELECT * INTO STRICT state FROM receiving_mailboxes WHERE mailbox_id=folder.id FOR UPDATE;
  SELECT enabled INTO STRICT enabled_account FROM mail_accounts WHERE id=folder.account_id;
  expected := nullif(current_setting('maildock.receiving_revision',true),'')::bigint;
  IF lease.owner::text IS DISTINCT FROM current_setting('maildock.receiving_owner',true)
    OR lease.generation::text IS DISTINCT FROM current_setting('maildock.receiving_generation',true)
    OR NOT enabled_account OR NOT folder.selectable OR folder.lifecycle_status <> 'active'
    OR folder.uid_validity IS DISTINCT FROM state.epoch OR expected IS NULL OR state.revision<>expected+1 THEN
    RAISE EXCEPTION 'Receiving COMMIT authority fenced';
  END IF;
  IF nullif(current_setting('maildock.receiving_operation',true),'')='attempt' AND
    (state.configuration_binding IS DISTINCT FROM (SELECT configuration_version FROM mail_accounts WHERE id=folder.account_id) OR
      current_setting('maildock.receiving_lifecycle',true) IS DISTINCT FROM (SELECT receiving_lifecycle_version::text FROM mail_accounts WHERE id=folder.account_id)) THEN
    RAISE EXCEPTION 'Receiving COMMIT configuration fenced'; END IF;
  IF nullif(current_setting('maildock.receiving_configuration',true),'') IS NOT NULL AND
    (state.configuration_binding::text IS DISTINCT FROM current_setting('maildock.receiving_configuration',true) OR
     current_setting('maildock.receiving_lifecycle',true) IS DISTINCT FROM (SELECT receiving_lifecycle_version::text FROM mail_accounts WHERE id=folder.account_id)) THEN
    RAISE EXCEPTION 'Receiving INBOX COMMIT identity fenced'; END IF;
  -- L is this final clock comparison in the last mandatory deferred invocation.
  -- The SHARE lock conflicts with takeover until transaction end, including after L.
  IF lease.expires_at <= clock_timestamp() THEN RAISE EXCEPTION 'Receiving COMMIT lease expired'; END IF;
  RETURN NULL;
END $$;
