-- R13: original Sent-copy identity and bounded read-only recovery.
-- Before there is a selectable destination there is no mailbox authority to
-- claim. This intent-only failure has an exact row certificate, the usual owner
-- and account locks, and the same deferred owner/lifecycle/DB-clock COMMIT check.
CREATE FUNCTION maildock_receiving_append_pending_failure(actor uuid, term bigint, account uuid, binding bigint, lifecycle bigint,
  intent uuid, reason text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE lease receiving_coordinator%ROWTYPE; a mail_accounts%ROWTYPE; r outgoing_messages%ROWTYPE; n outgoing_messages%ROWTYPE;
BEGIN
  IF reason IS NULL OR reason NOT IN ('destination_unavailable','mime_unavailable') OR
    nullif(current_setting('maildock.receiving_bounded_scope',true),'') IS NOT NULL OR
    nullif(current_setting('maildock.receiving_mailbox',true),'') IS NOT NULL THEN RAISE EXCEPTION 'Invalid Sent pending failure'; END IF;
  SELECT * INTO STRICT lease FROM receiving_coordinator WHERE singleton FOR SHARE;
  PERFORM pg_advisory_xact_lock(hashtextextended('mailbox-discovery:'||account::text,0));
  SELECT * INTO STRICT a FROM mail_accounts WHERE id=account FOR SHARE;
  IF actor IS NULL OR term IS NULL OR lease.owner IS DISTINCT FROM actor OR lease.generation IS DISTINCT FROM term OR lease.expires_at<=clock_timestamp() OR
    NOT a.enabled OR a.configuration_version IS DISTINCT FROM binding OR a.receiving_lifecycle_version IS DISTINCT FROM lifecycle THEN RAISE EXCEPTION 'Sent pending failure owner fenced'; END IF;
  SELECT * INTO STRICT r FROM outgoing_messages WHERE id=intent AND account_id=account FOR UPDATE;
  IF r.status<>'sent' OR r.sent_copy_policy<>'maildock' OR r.sent_copy_status<>'pending' OR r.receiving_attempt IS NOT NULL OR r.sent_copy_started_at IS NOT NULL THEN
    RAISE EXCEPTION 'Sent pending failure intent fenced'; END IF;
  IF reason='destination_unavailable' AND EXISTS(SELECT FROM mailbox_roles role_row JOIN mailboxes b ON b.id=role_row.mailbox_id
    WHERE role_row.account_id=account AND role_row.role='sent' AND b.account_id=account AND b.selectable AND b.lifecycle_status='active'
      AND (role_row.source='manual' OR (role_row.source='special_use' AND b.special_use @> ARRAY[chr(92)||'Sent'] AND
        (SELECT count(*) FROM mailboxes candidate WHERE candidate.account_id=account AND candidate.selectable AND candidate.lifecycle_status='active'
          AND candidate.special_use @> ARRAY[chr(92)||'Sent'])=1))) THEN RETURN; END IF;
  PERFORM set_config('maildock.receiving_bounded_scope',jsonb_build_object('kind','sent_intent','actor',actor,'generation',term::text,
    'account',account,'configuration',binding::text,'lifecycle',lifecycle::text,'scopes','[]'::jsonb)::text,true);
  n:=r; n.sent_copy_status:='failed'; n.sent_copy_error:=CASE reason WHEN 'destination_unavailable' THEN
    'Message sent, but the Sent mailbox is unavailable. Check System folders → Sent.' ELSE 'Message sent, but the copy could not be saved to Sent.' END;
  n.updated_at:=clock_timestamp();
  PERFORM maildock_receiving_bounded_permit('outgoing_messages','UPDATE',to_jsonb(n),to_jsonb(r));
  UPDATE outgoing_messages SET sent_copy_status=n.sent_copy_status,sent_copy_error=n.sent_copy_error,updated_at=n.updated_at WHERE id=intent;
END $$;
REVOKE ALL ON FUNCTION maildock_receiving_append_pending_failure(uuid,bigint,uuid,bigint,bigint,uuid,text) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION maildock_receiving_append_claim(actor uuid, term bigint, account uuid, binding bigint, lifecycle bigint,
  scopes jsonb, intent uuid, attempt uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE scope jsonb; r outgoing_messages%ROWTYPE; n outgoing_messages%ROWTYPE; marker jsonb;
BEGIN
  scope:=maildock_receiving_data_scope(actor,term,account,binding,lifecycle,scopes);
  SELECT * INTO STRICT r FROM outgoing_messages WHERE id=intent FOR UPDATE;
  IF attempt IS NULL OR jsonb_array_length(scopes)<>1 OR r.account_id IS DISTINCT FROM account OR r.status<>'sent' OR
    r.sent_copy_policy<>'maildock' OR r.sent_copy_status<>'pending' OR
    r.receiving_attempt IS NOT NULL OR
    EXISTS(SELECT FROM mailbox_roles role_row WHERE role_row.account_id=account AND role_row.role='sent' AND role_row.mailbox_id IS DISTINCT FROM r.sent_copy_mailbox_id) OR r.sent_copy_uid IS NOT NULL OR r.sent_copy_uid_validity IS NOT NULL OR
    NOT EXISTS(SELECT FROM jsonb_array_elements(scopes) x WHERE x->>'mailbox'=r.sent_copy_mailbox_id::text AND x->>'path'=r.sent_copy_path) THEN
    RAISE EXCEPTION 'Receiving APPEND claim fenced'; END IF;
  marker:=scope || jsonb_build_object('id',attempt,'phase','claimed','operation','append','destination',r.sent_copy_mailbox_id,
    'sentRole',(SELECT to_jsonb(role_row) FROM mailbox_roles role_row WHERE role_row.account_id=account AND role_row.role='sent' FOR SHARE),'messageId',r.message_id,'mimeDigest',(SELECT sha256 FROM blobs WHERE id=r.mime_blob_id),'mimeBlob',r.mime_blob_id,'mimeSha256',encode(sha256(convert_to(r.mime_base64,'UTF8')),'hex'));
  n:=r; n.receiving_attempt:=marker; n.sent_copy_status:='saving'; n.sent_copy_error:=NULL;
  n.sent_copy_started_at:=clock_timestamp(); n.updated_at:=clock_timestamp();
  PERFORM maildock_receiving_bounded_permit('outgoing_messages','UPDATE',to_jsonb(n),to_jsonb(r));
  UPDATE outgoing_messages SET receiving_attempt=n.receiving_attempt,sent_copy_status=n.sent_copy_status,sent_copy_error=n.sent_copy_error,
    sent_copy_started_at=n.sent_copy_started_at,updated_at=n.updated_at WHERE id=intent;
  PERFORM maildock_receiving_bounded_advance(); RETURN marker;
END $$;
CREATE OR REPLACE FUNCTION maildock_receiving_append_result(actor uuid, term bigint, account uuid, binding bigint, lifecycle bigint,
  scopes jsonb, intent uuid, attempt uuid, evidence jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE scope jsonb; r outgoing_messages%ROWTYPE; n outgoing_messages%ROWTYPE; marker jsonb; dest mailbox_messages%ROWTYPE; existing_dest mailbox_messages%ROWTYPE;
  m messages%ROWTYPE; uid bigint; epoch bigint;
BEGIN
  scope:=maildock_receiving_data_scope(actor,term,account,binding,lifecycle,scopes);
  SELECT * INTO STRICT r FROM outgoing_messages WHERE id=intent FOR UPDATE; marker:=r.receiving_attempt;
  IF attempt IS NULL OR marker->>'id' IS DISTINCT FROM attempt::text OR marker->>'actor' IS DISTINCT FROM actor::text OR
    marker->>'generation' IS DISTINCT FROM term::text OR marker->>'operation' IS DISTINCT FROM 'append' OR
    marker->>'phase' IS NULL OR NOT ((marker->>'phase' IN ('claimed','reconciling') AND r.sent_copy_status='saving') OR (marker->>'phase' IN ('awaiting_metadata','awaiting_uid') AND r.sent_copy_status='saved' AND r.sent_copy_sync_pending)) OR
    r.status<>'sent' OR r.sent_copy_policy<>'maildock' OR marker->>'account' IS DISTINCT FROM account::text OR marker->>'configuration' IS DISTINCT FROM binding::text OR
    marker->>'lifecycle' IS DISTINCT FROM lifecycle::text OR jsonb_array_length(scopes)<>1 OR
    (marker ? 'sentRole' AND marker->'sentRole' IS DISTINCT FROM coalesce((SELECT to_jsonb(role_row) FROM mailbox_roles role_row WHERE role_row.account_id=account AND role_row.role='sent' FOR SHARE),'null'::jsonb)) OR
    (marker ? 'mimeDigest' AND marker->>'mimeDigest' IS DISTINCT FROM (SELECT sha256 FROM blobs WHERE id=r.mime_blob_id)) OR
    marker->>'destination' IS DISTINCT FROM r.sent_copy_mailbox_id::text OR marker->>'messageId' IS DISTINCT FROM r.message_id OR
    marker->'mimeBlob' IS DISTINCT FROM coalesce(to_jsonb(r.mime_blob_id),'null'::jsonb) OR
    marker->>'mimeSha256' IS DISTINCT FROM encode(sha256(convert_to(r.mime_base64,'UTF8')),'hex') OR
    NOT EXISTS(SELECT FROM jsonb_array_elements(scopes) x WHERE x->>'mailbox'=r.sent_copy_mailbox_id::text AND x->>'path'=r.sent_copy_path) OR
    marker->'scopes'->0->'state'->>'epoch' IS DISTINCT FROM scope->'scopes'->0->'state'->>'epoch' THEN
    RAISE EXCEPTION 'Receiving APPEND result attempt fenced'; END IF;
  IF evidence IS NULL OR evidence - ARRAY['kind','complete','taggedOk','destinationEpoch','destinationUid','message','flags','modseq','accepted'] <> '{}'::jsonb OR
    evidence->'complete' IS DISTINCT FROM 'true'::jsonb OR evidence->'taggedOk' IS DISTINCT FROM 'true'::jsonb OR
    evidence->>'kind' IS DISTINCT FROM (CASE marker->>'phase' WHEN 'claimed' THEN 'append' ELSE 'lookup' END) OR
    octet_length(evidence::text)>65536 THEN RAISE EXCEPTION 'Invalid APPEND evidence'; END IF;
  PERFORM maildock_receiving_destination_flags(evidence);
  uid:=(evidence->>'destinationUid')::bigint; epoch:=(evidence->>'destinationEpoch')::bigint;
  n:=r; n.updated_at:=clock_timestamp();
  IF uid IS NULL THEN
    IF marker->>'phase'<>'claimed' OR epoch IS NOT NULL OR evidence->>'message' IS NOT NULL THEN RAISE EXCEPTION 'Partial APPEND mapping'; END IF;
    IF evidence->'accepted'='true'::jsonb THEN
      n.sent_copy_status:='saved'; n.sent_copy_error:=NULL; n.sent_copy_saved_at:=coalesce(r.sent_copy_saved_at,clock_timestamp());
      n.sent_copy_sync_pending:=true; n.receiving_attempt:=marker || jsonb_build_object('phase','awaiting_uid');
    ELSE
      n.sent_copy_status:='uncertain'; n.sent_copy_error:='uncertain_remote_execution';
      n.receiving_attempt:=marker || jsonb_build_object('phase','uncertain_remote_execution');
    END IF;
    PERFORM maildock_receiving_request(account,r.sent_copy_mailbox_id);
  ELSE
    IF uid NOT BETWEEN 1 AND 4294967295 OR epoch IS DISTINCT FROM (SELECT s.epoch FROM receiving_mailboxes s WHERE mailbox_id=r.sent_copy_mailbox_id) THEN
      RAISE EXCEPTION 'Invalid known APPEND destination'; END IF;
    IF r.sent_copy_uid IS NOT NULL AND (uid IS DISTINCT FROM r.sent_copy_uid OR epoch IS DISTINCT FROM r.sent_copy_uid_validity) THEN
      RAISE EXCEPTION 'APPEND lookup cannot replace a saved mapping'; END IF;
    n.sent_copy_status:='saved'; n.sent_copy_error:=NULL; n.sent_copy_uid:=uid; n.sent_copy_uid_validity:=epoch;
    n.sent_copy_saved_at:=coalesce(r.sent_copy_saved_at,clock_timestamp());
    IF evidence->>'message' IS NULL THEN
      IF marker->>'phase' NOT IN ('claimed','reconciling','awaiting_uid','awaiting_metadata') THEN RAISE EXCEPTION 'Incomplete APPEND metadata lookup'; END IF;
      n.sent_copy_sync_pending:=true;
      n.receiving_attempt:=marker || jsonb_build_object('phase','awaiting_metadata');
      PERFORM maildock_receiving_request(account,r.sent_copy_mailbox_id);
    ELSE
    -- Targeted publication links already validated metadata; envelope/MIME creation retains its metadata capability.
    SELECT * INTO STRICT m FROM messages WHERE id=(evidence->>'message')::uuid FOR SHARE;
    IF m.account_id IS DISTINCT FROM account OR m.rfc_message_id IS DISTINCT FROM r.message_id THEN RAISE EXCEPTION 'APPEND message identity fenced'; END IF;
    dest.id:=gen_random_uuid(); dest.mailbox_id:=r.sent_copy_mailbox_id; dest.message_id:=m.id; dest.uid_validity:=epoch; dest.uid:=uid;
    dest.configuration_binding:=binding; dest.flags:=ARRAY(SELECT jsonb_array_elements_text(evidence->'flags')); dest.modseq:=(evidence->>'modseq')::bigint; dest.action_hidden:=false;
    dest.first_synchronized_at:=clock_timestamp(); dest.last_synchronized_at:=clock_timestamp(); dest.created_at:=clock_timestamp(); dest.updated_at:=clock_timestamp();
    SELECT * INTO existing_dest FROM mailbox_messages p WHERE p.mailbox_id=dest.mailbox_id AND p.uid_validity=dest.uid_validity AND p.uid=dest.uid FOR UPDATE;
    IF FOUND THEN
      IF evidence->>'kind'<>'lookup' OR ROW(existing_dest.message_id,existing_dest.configuration_binding,existing_dest.flags,existing_dest.modseq,existing_dest.action_hidden)
        IS DISTINCT FROM ROW(dest.message_id,dest.configuration_binding,dest.flags,dest.modseq,dest.action_hidden) THEN
        RAISE EXCEPTION 'Conflicting APPEND destination placement'; END IF;
    ELSE
      PERFORM maildock_receiving_bounded_permit('mailbox_messages','INSERT',to_jsonb(dest),NULL);
      INSERT INTO mailbox_messages SELECT (jsonb_populate_record(NULL::mailbox_messages,to_jsonb(dest))).*;
    END IF;
    n.sent_copy_sync_pending:=false;
    n.receiving_attempt:=marker || jsonb_build_object('phase','succeeded');
    END IF;
  END IF;
  PERFORM maildock_receiving_bounded_permit('outgoing_messages','UPDATE',to_jsonb(n),to_jsonb(r));
  UPDATE outgoing_messages SET receiving_attempt=n.receiving_attempt,sent_copy_status=n.sent_copy_status,sent_copy_error=n.sent_copy_error,
    sent_copy_uid=n.sent_copy_uid,sent_copy_uid_validity=n.sent_copy_uid_validity,sent_copy_saved_at=n.sent_copy_saved_at,
    sent_copy_sync_pending=n.sent_copy_sync_pending,updated_at=n.updated_at WHERE id=intent;
  PERFORM maildock_receiving_bounded_advance();
END $$;

--> statement-breakpoint

-- A read-only recovery admission adopts the original UUID. It never authorizes APPEND.
CREATE FUNCTION maildock_receiving_append_resume(actor uuid, term bigint, account uuid, binding bigint, lifecycle bigint,
  scopes jsonb, intent uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE scope jsonb; r outgoing_messages%ROWTYPE; n outgoing_messages%ROWTYPE; marker jsonb;
BEGIN
  scope:=maildock_receiving_data_scope(actor,term,account,binding,lifecycle,scopes);
  SELECT * INTO STRICT r FROM outgoing_messages WHERE id=intent AND account_id=account FOR UPDATE;
  marker:=r.receiving_attempt;
  IF marker IS NULL OR marker->>'operation' IS DISTINCT FROM 'append' OR r.status<>'sent' OR r.sent_copy_policy<>'maildock' OR
    r.sent_copy_status NOT IN ('saving','uncertain','saved') OR
    coalesce(marker->>'phase','') NOT IN ('claimed','reconciling','uncertain_remote_execution','awaiting_metadata','awaiting_uid') OR
    coalesce((marker->>'observations')::integer,0)>=3 OR
    marker->>'configuration' IS DISTINCT FROM binding::text OR marker->>'lifecycle' IS DISTINCT FROM lifecycle::text OR
    jsonb_array_length(scopes)<>1 OR marker->>'destination' IS DISTINCT FROM scopes->0->>'mailbox' OR
    marker->'scopes'->0->>'path' IS DISTINCT FROM scopes->0->>'path' OR
    marker->'scopes'->0->'state'->>'epoch' IS DISTINCT FROM scopes->0->'state'->>'epoch' OR
    marker->'sentRole' IS DISTINCT FROM coalesce((SELECT to_jsonb(role_row) FROM mailbox_roles role_row WHERE role_row.account_id=account AND role_row.role='sent' FOR SHARE),'null'::jsonb) THEN
    RAISE EXCEPTION 'Receiving APPEND reconciliation identity fenced'; END IF;
  n:=r;
  n.receiving_attempt:=marker || jsonb_build_object('actor',actor,'generation',term::text,
    'observations',coalesce((marker->>'observations')::integer,0)+1,'phase',CASE WHEN r.sent_copy_status='saved' THEN marker->>'phase' ELSE 'reconciling' END);
  IF r.sent_copy_status<>'saved' THEN n.sent_copy_status:='saving'; END IF;
  n.updated_at:=clock_timestamp();
  PERFORM maildock_receiving_bounded_permit('outgoing_messages','UPDATE',to_jsonb(n),to_jsonb(r));
  UPDATE outgoing_messages SET receiving_attempt=n.receiving_attempt,sent_copy_status=n.sent_copy_status,updated_at=n.updated_at WHERE id=intent;
  PERFORM maildock_receiving_bounded_advance(); RETURN n.receiving_attempt;
END $$;
REVOKE ALL ON FUNCTION maildock_receiving_append_resume(uuid,bigint,uuid,bigint,bigint,jsonb,uuid) FROM PUBLIC;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION maildock_receiving_data_failure(actor uuid, term bigint, account uuid, binding bigint, lifecycle bigint,
  scopes jsonb, operation text, intent uuid, attempt uuid, outcome text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE scope jsonb; marker jsonb; c message_commands%ROWTYPE; nc message_commands%ROWTYPE; r outgoing_messages%ROWTYPE; nr outgoing_messages%ROWTYPE;
BEGIN
  IF operation IS NULL OR operation NOT IN ('move','append') OR outcome IS NULL OR outcome NOT IN ('failed_before_execution','uncertain_remote_execution') THEN
    RAISE EXCEPTION 'Invalid data failure capability'; END IF;
  scope:=maildock_receiving_data_scope(actor,term,account,binding,lifecycle,scopes);
  IF operation='move' THEN
    SELECT * INTO STRICT c FROM message_commands WHERE id=intent AND account_id=account FOR UPDATE; marker:=c.receiving_attempt;
    IF c.status<>'executing' OR jsonb_array_length(scopes)<>2 OR
      NOT maildock_receiving_active_source(account,c.mailbox_id,c.message_id,c.source_uid_validity,c.source_uid,binding) THEN RAISE EXCEPTION 'MOVE failure source fenced'; END IF;
  ELSE
    SELECT * INTO STRICT r FROM outgoing_messages WHERE id=intent AND account_id=account FOR UPDATE; marker:=r.receiving_attempt;
    IF r.sent_copy_status<>'saving' OR r.status<>'sent' OR jsonb_array_length(scopes)<>1 THEN RAISE EXCEPTION 'APPEND failure source fenced'; END IF;
  END IF;
  IF attempt IS NULL OR marker->>'id' IS DISTINCT FROM attempt::text OR marker->>'actor' IS DISTINCT FROM actor::text OR
    marker->>'generation' IS DISTINCT FROM term::text OR (marker->>'phase' IS DISTINCT FROM 'claimed' AND (operation IS DISTINCT FROM 'append' OR marker->>'phase' IS DISTINCT FROM 'reconciling')) OR marker->>'operation' IS DISTINCT FROM operation OR
    marker->>'account' IS DISTINCT FROM account::text OR marker->>'configuration' IS DISTINCT FROM binding::text OR marker->>'lifecycle' IS DISTINCT FROM lifecycle::text OR
    (SELECT jsonb_agg(jsonb_build_object('mailbox',x->>'mailbox','path',x->>'path','epoch',x->'state'->>'epoch') ORDER BY x->>'mailbox') FROM jsonb_array_elements(marker->'scopes') x)
      IS DISTINCT FROM (SELECT jsonb_agg(jsonb_build_object('mailbox',x->>'mailbox','path',x->>'path','epoch',x->'state'->>'epoch') ORDER BY x->>'mailbox') FROM jsonb_array_elements(scope->'scopes') x) THEN
    RAISE EXCEPTION 'Matching data failure attempt fenced'; END IF;
  IF operation='move' THEN
    nc:=c; nc.status:='failed'; nc.error:=outcome; nc.completed_at:=clock_timestamp(); nc.updated_at:=clock_timestamp();
    nc.receiving_attempt:=marker || jsonb_build_object('phase',outcome);
    PERFORM maildock_receiving_bounded_permit('message_commands','UPDATE',to_jsonb(nc),to_jsonb(c));
    UPDATE message_commands SET status=nc.status,error=nc.error,completed_at=nc.completed_at,updated_at=nc.updated_at,receiving_attempt=nc.receiving_attempt WHERE id=intent;
    IF outcome='uncertain_remote_execution' THEN PERFORM maildock_receiving_request(account,c.mailbox_id); PERFORM maildock_receiving_request(account,c.destination_mailbox_id); END IF;
  ELSE
    nr:=r; nr.sent_copy_status:=CASE outcome WHEN 'uncertain_remote_execution' THEN 'uncertain' ELSE 'failed' END;
    nr.sent_copy_error:=CASE outcome WHEN 'uncertain_remote_execution' THEN 'Message sent, but Maildock could not confirm whether the Sent copy was saved.' ELSE 'Message sent, but the copy could not be saved to Sent.' END; nr.updated_at:=clock_timestamp(); nr.receiving_attempt:=marker || jsonb_build_object('phase',outcome);
    PERFORM maildock_receiving_bounded_permit('outgoing_messages','UPDATE',to_jsonb(nr),to_jsonb(r));
    UPDATE outgoing_messages SET sent_copy_status=nr.sent_copy_status,sent_copy_error=nr.sent_copy_error,updated_at=nr.updated_at,receiving_attempt=nr.receiving_attempt WHERE id=intent;
    IF outcome='uncertain_remote_execution' THEN PERFORM maildock_receiving_request(account,r.sent_copy_mailbox_id); END IF;
  END IF;
  PERFORM maildock_receiving_bounded_advance();
END $$;
