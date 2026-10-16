-- R14: exact MOVE authority, confirmed no-COPYUID completion, bounded observation.
-- R07 role semantics, including manual precedence and unambiguous special-use.
CREATE FUNCTION maildock_receiving_move_destination(account uuid, role_name text, destination uuid, path text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT FROM mailbox_roles r JOIN mailboxes b ON b.id=r.mailbox_id
    WHERE r.account_id=$1 AND r.role=$2 AND b.account_id=$1 AND b.id=$3 AND b.remote_path=$4 AND b.selectable AND b.lifecycle_status='active'
      AND (r.source='manual' OR (r.source='special_use' AND b.special_use @> ARRAY[chr(92)||CASE $2 WHEN 'archive' THEN 'Archive' WHEN 'trash' THEN 'Trash' END]
        AND (SELECT count(*) FROM (SELECT 1 FROM mailboxes candidate WHERE candidate.account_id=$1 AND candidate.selectable AND candidate.lifecycle_status='active'
          AND candidate.special_use @> ARRAY[chr(92)||CASE $2 WHEN 'archive' THEN 'Archive' WHEN 'trash' THEN 'Trash' END] LIMIT 2) matches)=1)))
$$;
REVOKE ALL ON FUNCTION maildock_receiving_move_destination(uuid,text,uuid,text) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION maildock_receiving_move_claim(actor uuid, term bigint, account uuid, binding bigint, lifecycle bigint,
  scopes jsonb, intent uuid, attempt uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE scope jsonb; c message_commands%ROWTYPE; n message_commands%ROWTYPE; marker jsonb; role_identity jsonb;
BEGIN
  scope:=maildock_receiving_data_scope(actor,term,account,binding,lifecycle,scopes);
  SELECT * INTO STRICT c FROM message_commands WHERE id=intent FOR UPDATE;
  SELECT to_jsonb(r) INTO STRICT role_identity FROM mailbox_roles r WHERE account_id=account AND role=c.action FOR SHARE;
  IF attempt IS NULL OR c.status<>'pending' OR c.attempts>=3 OR c.action NOT IN ('archive','trash') OR c.account_id IS DISTINCT FROM account OR
    jsonb_array_length(scopes)<>2 OR c.mailbox_id=c.destination_mailbox_id OR
    NOT EXISTS(SELECT FROM jsonb_array_elements(scopes) x WHERE x->>'mailbox'=c.mailbox_id::text AND x->>'path'=c.source_path) OR
    NOT EXISTS(SELECT FROM jsonb_array_elements(scopes) x WHERE x->>'mailbox'=c.destination_mailbox_id::text AND x->>'path'=c.destination_path) OR
    role_identity->>'mailbox_id' IS DISTINCT FROM c.destination_mailbox_id::text OR
    NOT maildock_receiving_move_destination(account,c.action,c.destination_mailbox_id,c.destination_path) OR
    c.receiving_attempt IS NOT NULL OR
    NOT maildock_receiving_active_source(account,c.mailbox_id,c.message_id,c.source_uid_validity,c.source_uid,binding) OR
    c.source_configuration_binding IS DISTINCT FROM binding OR
    NOT EXISTS(SELECT FROM mail_accounts WHERE id=account AND imap_capabilities @> ARRAY['MOVE']::text[]) THEN
    RAISE EXCEPTION 'Receiving MOVE claim fenced'; END IF;
  marker:=scope || jsonb_build_object('id',attempt,'phase','claimed','operation','move','role',role_identity,
    'source',c.mailbox_id,'destination',c.destination_mailbox_id,'message',c.message_id,'epoch',c.source_uid_validity::text,
    'uid',c.source_uid::text,'placement',c.placement_id);
  n:=c; n.receiving_attempt:=marker; n.status:='executing'; n.attempts:=c.attempts+1; n.error:=NULL;
  n.started_at:=clock_timestamp(); n.updated_at:=clock_timestamp();
  PERFORM maildock_receiving_bounded_permit('message_commands','UPDATE',to_jsonb(n),to_jsonb(c));
  UPDATE message_commands SET receiving_attempt=n.receiving_attempt,status=n.status,attempts=n.attempts,error=n.error,started_at=n.started_at,updated_at=n.updated_at WHERE id=intent;
  PERFORM maildock_receiving_bounded_advance();
  RETURN marker;
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION maildock_receiving_move_result(actor uuid, term bigint, account uuid, binding bigint, lifecycle bigint,
  scopes jsonb, intent uuid, attempt uuid, evidence jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE scope jsonb; c message_commands%ROWTYPE; n message_commands%ROWTYPE; ref message_commands%ROWTYPE; changed_ref message_commands%ROWTYPE; p mailbox_messages%ROWTYPE; dest mailbox_messages%ROWTYPE;
  role_identity jsonb; marker jsonb; destination_epoch bigint; destination_uid bigint;
BEGIN
  scope:=maildock_receiving_data_scope(actor,term,account,binding,lifecycle,scopes);
  SELECT * INTO STRICT c FROM message_commands WHERE id=intent FOR UPDATE;
  marker:=c.receiving_attempt;
  SELECT to_jsonb(r) INTO STRICT role_identity FROM mailbox_roles r WHERE account_id=account AND role=c.action FOR SHARE;
  IF attempt IS NULL OR marker->>'id' IS DISTINCT FROM attempt::text OR marker->>'actor' IS DISTINCT FROM actor::text OR
    marker->>'generation' IS DISTINCT FROM term::text OR marker->>'phase' IS DISTINCT FROM 'claimed' OR marker->>'operation' IS DISTINCT FROM 'move' OR
    c.status<>'executing' OR marker->>'account' IS DISTINCT FROM account::text OR marker->>'configuration' IS DISTINCT FROM binding::text OR
    marker->>'lifecycle' IS DISTINCT FROM lifecycle::text OR marker->'role' IS DISTINCT FROM role_identity OR
    NOT maildock_receiving_move_destination(account,c.action,c.destination_mailbox_id,c.destination_path) OR
    jsonb_array_length(scopes)<>2 OR marker->>'source' IS DISTINCT FROM c.mailbox_id::text OR
    marker->>'destination' IS DISTINCT FROM c.destination_mailbox_id::text OR
    NOT EXISTS(SELECT FROM jsonb_array_elements(scopes) x WHERE x->>'mailbox'=c.mailbox_id::text AND x->>'path'=c.source_path) OR
    NOT EXISTS(SELECT FROM jsonb_array_elements(scopes) x WHERE x->>'mailbox'=c.destination_mailbox_id::text AND x->>'path'=c.destination_path) OR
    EXISTS(SELECT FROM jsonb_array_elements(marker->'scopes') x JOIN jsonb_array_elements(scope->'scopes') y ON x->>'mailbox'=y->>'mailbox'
      WHERE x->>'path' IS DISTINCT FROM y->>'path' OR x->'state'->>'epoch' IS DISTINCT FROM y->'state'->>'epoch') OR
    NOT maildock_receiving_active_source(account,c.mailbox_id,c.message_id,c.source_uid_validity,c.source_uid,binding) THEN
    RAISE EXCEPTION 'Receiving MOVE result attempt fenced'; END IF;
  IF evidence IS NULL OR evidence - ARRAY['complete','taggedOk','sourceEpoch','sourceUid','destinationEpoch','destinationUid','sourceRemoved','flags','modseq','accepted'] <> '{}'::jsonb OR
    evidence->'complete' IS DISTINCT FROM 'true'::jsonb OR evidence->'taggedOk' IS DISTINCT FROM 'true'::jsonb OR
    evidence->>'sourceEpoch' IS DISTINCT FROM c.source_uid_validity::text OR evidence->>'sourceUid' IS DISTINCT FROM c.source_uid::text OR
    octet_length(evidence::text)>65536 THEN RAISE EXCEPTION 'Invalid MOVE evidence'; END IF;
  PERFORM maildock_receiving_destination_flags(evidence);
  destination_uid:=(evidence->>'destinationUid')::bigint;
  destination_epoch:=(evidence->>'destinationEpoch')::bigint;
  IF marker->'observation'='true'::jsonb AND (destination_uid IS NULL OR
    marker->'moveProof'->>'sourceEpoch' IS DISTINCT FROM c.source_uid_validity::text OR
    marker->'moveProof'->>'sourceUid' IS DISTINCT FROM c.source_uid::text OR
    marker->'moveProof'->>'epoch' IS DISTINCT FROM destination_epoch::text OR
    marker->'moveProof'->>'uid' IS DISTINCT FROM destination_uid::text) THEN
    RAISE EXCEPTION 'MOVE observation requires original exact COPYUID proof'; END IF;
  n:=c; n.updated_at:=clock_timestamp(); n.completed_at:=clock_timestamp();
  IF destination_uid IS NULL AND evidence->'accepted' IS DISTINCT FROM 'true'::jsonb THEN
    -- Missing COPYUID is uncertainty, never permission to invent a placement or retry MOVE.
    IF destination_epoch IS NOT NULL THEN RAISE EXCEPTION 'Partial destination mapping'; END IF;
    n.status:='failed'; n.error:='uncertain_remote_execution';
    n.receiving_attempt:=marker || jsonb_build_object('phase','uncertain_remote_execution');
    PERFORM maildock_receiving_request(account,c.mailbox_id);
    PERFORM maildock_receiving_request(account,c.destination_mailbox_id);
  ELSE
    IF evidence->'sourceRemoved' IS DISTINCT FROM 'true'::jsonb OR
      (destination_uid IS NULL AND destination_epoch IS NOT NULL) OR
      (destination_uid IS NOT NULL AND (destination_uid NOT BETWEEN 1 AND 4294967295 OR destination_epoch IS DISTINCT FROM
      (SELECT epoch FROM receiving_mailboxes WHERE mailbox_id=c.destination_mailbox_id))) THEN
      RAISE EXCEPTION 'Invalid known MOVE destination'; END IF;
    SELECT * INTO STRICT p FROM mailbox_messages WHERE id=c.placement_id FOR UPDATE;
    IF ROW(p.mailbox_id,p.message_id,p.uid_validity,p.uid,p.configuration_binding) IS DISTINCT FROM
      ROW(c.mailbox_id,c.message_id,c.source_uid_validity,c.source_uid,binding) THEN RAISE EXCEPTION 'MOVE placement identity fenced'; END IF;
    IF destination_uid IS NOT NULL THEN
    dest:=p; dest.id:=gen_random_uuid(); dest.mailbox_id:=c.destination_mailbox_id; dest.uid_validity:=destination_epoch; dest.uid:=destination_uid;
    dest.flags:=ARRAY(SELECT jsonb_array_elements_text(evidence->'flags')); dest.modseq:=(evidence->>'modseq')::bigint; dest.action_hidden:=false; dest.created_at:=clock_timestamp(); dest.updated_at:=clock_timestamp();
    dest.first_synchronized_at:=clock_timestamp(); dest.last_synchronized_at:=clock_timestamp();
    PERFORM maildock_receiving_bounded_permit('mailbox_messages','INSERT',to_jsonb(dest),NULL);
    INSERT INTO mailbox_messages SELECT (jsonb_populate_record(NULL::mailbox_messages,to_jsonb(dest))).*;
    END IF;
    -- Preserve placement FK behavior without permitting an arbitrary command UPDATE.
    n.placement_id:=NULL;
    PERFORM maildock_receiving_bounded_permit('message_commands','UPDATE',to_jsonb(n),to_jsonb(c));
    UPDATE message_commands SET placement_id=NULL,updated_at=n.updated_at,completed_at=n.completed_at WHERE id=intent;
    c:=n;
    IF (SELECT count(*) FROM message_commands WHERE placement_id=p.id)>128 THEN RAISE EXCEPTION 'MOVE reference scope overflow'; END IF;
    -- Historical command references retain the FK's SET NULL behavior, with exact old/new permits.
    FOR ref IN SELECT * FROM message_commands WHERE placement_id=p.id ORDER BY id FOR UPDATE LOOP
      IF ref.status IN ('pending','executing') OR ref.account_id IS DISTINCT FROM account OR ref.mailbox_id IS DISTINCT FROM c.mailbox_id OR
        ref.message_id IS DISTINCT FROM c.message_id THEN RAISE EXCEPTION 'Conflicting source command'; END IF;
      changed_ref:=ref; changed_ref.placement_id:=NULL;
      PERFORM maildock_receiving_bounded_permit('message_commands','UPDATE',to_jsonb(changed_ref),to_jsonb(ref));
      UPDATE message_commands SET placement_id=NULL WHERE id=ref.id;
    END LOOP;
    PERFORM maildock_receiving_bounded_permit('mailbox_messages','DELETE',NULL,to_jsonb(p));
    DELETE FROM mailbox_messages WHERE id=p.id;
    n.status:='succeeded'; n.error:=NULL; n.destination_uid:=destination_uid; n.destination_uid_validity:=destination_epoch;
    n.receiving_attempt:=marker || jsonb_build_object('phase',CASE WHEN destination_uid IS NULL THEN 'awaiting_uid' ELSE 'succeeded' END);
    PERFORM maildock_receiving_request(account,c.destination_mailbox_id);
  END IF;
  PERFORM maildock_receiving_bounded_permit('message_commands','UPDATE',to_jsonb(n),to_jsonb(c));
  UPDATE message_commands SET status=n.status,error=n.error,receiving_attempt=n.receiving_attempt,updated_at=n.updated_at,completed_at=n.completed_at,
    destination_uid=n.destination_uid,destination_uid_validity=n.destination_uid_validity WHERE id=intent;
  PERFORM maildock_receiving_bounded_advance();
END $$;


--> statement-breakpoint
CREATE FUNCTION maildock_receiving_move_validate(actor uuid, term bigint, account uuid, binding bigint, lifecycle bigint,
  scopes jsonb, intent uuid, attempt uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE scope jsonb; c message_commands%ROWTYPE; marker jsonb; role_identity jsonb;
BEGIN
  scope:=maildock_receiving_data_scope(actor,term,account,binding,lifecycle,scopes);
  SELECT * INTO STRICT c FROM message_commands WHERE id=intent AND account_id=account FOR UPDATE;
  marker:=c.receiving_attempt;
  SELECT to_jsonb(r) INTO STRICT role_identity FROM mailbox_roles r WHERE account_id=account AND role=c.action FOR SHARE;
  IF attempt IS NULL OR marker->>'id' IS DISTINCT FROM attempt::text OR marker->>'actor' IS DISTINCT FROM actor::text OR
    marker->>'generation' IS DISTINCT FROM term::text OR marker->>'phase' IS DISTINCT FROM 'claimed' OR marker->>'operation' IS DISTINCT FROM 'move' OR
    c.status<>'executing' OR marker->>'configuration' IS DISTINCT FROM binding::text OR marker->>'lifecycle' IS DISTINCT FROM lifecycle::text OR
    marker->'role' IS DISTINCT FROM role_identity OR
    NOT maildock_receiving_move_destination(account,c.action,c.destination_mailbox_id,c.destination_path) OR jsonb_array_length(scopes)<>2 OR
    marker->>'source' IS DISTINCT FROM c.mailbox_id::text OR marker->>'destination' IS DISTINCT FROM c.destination_mailbox_id::text OR
    marker->>'uid' IS DISTINCT FROM c.source_uid::text OR marker->>'epoch' IS DISTINCT FROM c.source_uid_validity::text OR
    marker->>'message' IS DISTINCT FROM c.message_id::text OR marker->>'placement' IS DISTINCT FROM c.placement_id::text OR
    NOT EXISTS(SELECT FROM jsonb_array_elements(scopes) x WHERE x->>'mailbox'=c.mailbox_id::text AND x->>'path'=c.source_path) OR
    NOT EXISTS(SELECT FROM jsonb_array_elements(scopes) x WHERE x->>'mailbox'=c.destination_mailbox_id::text AND x->>'path'=c.destination_path) OR
    NOT maildock_receiving_active_source(account,c.mailbox_id,c.message_id,c.source_uid_validity,c.source_uid,binding) THEN
    RAISE EXCEPTION 'MOVE pre-network identity fenced'; END IF;
END $$;
REVOKE ALL ON FUNCTION maildock_receiving_move_validate(uuid,bigint,uuid,bigint,bigint,jsonb,uuid,uuid) FROM PUBLIC;

--> statement-breakpoint
CREATE FUNCTION maildock_receiving_move_resume(actor uuid, term bigint, account uuid, binding bigint, lifecycle bigint,
  scopes jsonb, intent uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE scope jsonb; c message_commands%ROWTYPE; n message_commands%ROWTYPE; marker jsonb; role_identity jsonb;
BEGIN
  scope:=maildock_receiving_data_scope(actor,term,account,binding,lifecycle,scopes);
  SELECT * INTO STRICT c FROM message_commands WHERE id=intent AND account_id=account FOR UPDATE;
  marker:=c.receiving_attempt;
  SELECT to_jsonb(r) INTO STRICT role_identity FROM mailbox_roles r WHERE account_id=account AND role=c.action FOR SHARE;
  IF c.action NOT IN ('archive','trash') OR c.status NOT IN ('executing','failed') OR marker IS NULL OR
    marker->>'operation' IS DISTINCT FROM 'move' OR marker->>'phase' NOT IN ('claimed','uncertain_remote_execution') OR
    marker->>'account' IS DISTINCT FROM account::text OR marker->>'configuration' IS DISTINCT FROM binding::text OR
    c.source_configuration_binding IS DISTINCT FROM binding OR marker->'role' IS DISTINCT FROM role_identity OR
    NOT maildock_receiving_move_destination(account,c.action,c.destination_mailbox_id,c.destination_path) OR
    marker->>'source' IS DISTINCT FROM c.mailbox_id::text OR marker->>'destination' IS DISTINCT FROM c.destination_mailbox_id::text OR
    marker->>'uid' IS DISTINCT FROM c.source_uid::text OR marker->>'epoch' IS DISTINCT FROM c.source_uid_validity::text OR
    marker->>'message' IS DISTINCT FROM c.message_id::text OR marker->>'placement' IS DISTINCT FROM c.placement_id::text OR
    jsonb_array_length(scopes)<>2 OR coalesce((marker->>'observations')::integer,0)>=3 OR
    (SELECT jsonb_agg(jsonb_build_object('mailbox',x->>'mailbox','path',x->>'path','epoch',x->'state'->>'epoch') ORDER BY x->>'mailbox') FROM jsonb_array_elements(marker->'scopes') x)
      IS DISTINCT FROM (SELECT jsonb_agg(jsonb_build_object('mailbox',x->>'mailbox','path',x->>'path','epoch',x->'state'->>'epoch') ORDER BY x->>'mailbox') FROM jsonb_array_elements(scope->'scopes') x) OR
    NOT maildock_receiving_active_source(account,c.mailbox_id,c.message_id,c.source_uid_validity,c.source_uid,binding) THEN
    RAISE EXCEPTION 'MOVE observation source or budget fenced'; END IF;
  n:=c; n.status:='executing'; n.error:=NULL; n.completed_at:=NULL; n.updated_at:=clock_timestamp();
  n.receiving_attempt:=marker || jsonb_build_object('phase','claimed','observations',coalesce((marker->>'observations')::integer,0)+1,
    'originalActor',coalesce(marker->>'originalActor',marker->>'actor'),'originalGeneration',coalesce(marker->>'originalGeneration',marker->>'generation'),
    'actor',actor,'generation',term::text,'lifecycle',lifecycle::text,'observation',true);
  PERFORM maildock_receiving_bounded_permit('message_commands','UPDATE',to_jsonb(n),to_jsonb(c));
  UPDATE message_commands SET receiving_attempt=n.receiving_attempt,status=n.status,error=n.error,completed_at=n.completed_at,updated_at=n.updated_at WHERE id=intent;
  PERFORM maildock_receiving_bounded_advance();
END $$;
REVOKE ALL ON FUNCTION maildock_receiving_move_resume(uuid,bigint,uuid,bigint,bigint,jsonb,uuid) FROM PUBLIC;
--> statement-breakpoint
-- Preserve a fully correlated COPYUID proof when the subsequent target read
-- fails. Only the existing attempt row changes; there is no remote receipt ledger.
CREATE FUNCTION maildock_receiving_move_uncertain(actor uuid, term bigint, account uuid, binding bigint, lifecycle bigint,
  scopes jsonb, intent uuid, attempt uuid, outcome text, proof jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE c message_commands%ROWTYPE; n message_commands%ROWTYPE;
BEGIN
  PERFORM maildock_receiving_data_failure(actor,term,account,binding,lifecycle,scopes,'move',intent,attempt,outcome);
  IF proof IS NULL THEN RETURN; END IF;
  SELECT * INTO STRICT c FROM message_commands WHERE id=intent FOR UPDATE;
  IF outcome IS DISTINCT FROM 'uncertain_remote_execution' OR proof - ARRAY['epoch','uid','sourceEpoch','sourceUid'] <> '{}'::jsonb OR
    proof->>'sourceEpoch' IS DISTINCT FROM c.source_uid_validity::text OR proof->>'sourceUid' IS DISTINCT FROM c.source_uid::text OR
    (proof->>'uid')::bigint NOT BETWEEN 1 AND 4294967295 OR (proof->>'uid') IS NULL OR
    (proof->>'epoch')::bigint IS DISTINCT FROM (SELECT epoch FROM receiving_mailboxes WHERE mailbox_id=c.destination_mailbox_id) THEN
    RAISE EXCEPTION 'Invalid MOVE proof'; END IF;
  n:=c; n.receiving_attempt:=c.receiving_attempt || jsonb_build_object('moveProof',proof);
  PERFORM maildock_receiving_bounded_permit('message_commands','UPDATE',to_jsonb(n),to_jsonb(c));
  UPDATE message_commands SET receiving_attempt=n.receiving_attempt WHERE id=intent;
  PERFORM set_config('maildock.receiving_bounded_write','',true);
END $$;
REVOKE ALL ON FUNCTION maildock_receiving_move_uncertain(uuid,bigint,uuid,bigint,bigint,jsonb,uuid,uuid,text,jsonb) FROM PUBLIC;
--> statement-breakpoint
CREATE INDEX message_commands_receiving_move_idx ON message_commands(updated_at,id)
  WHERE action IN ('archive','trash') AND status IN ('pending','executing','failed') AND source_configuration_binding IS NOT NULL;

--> statement-breakpoint
-- Intent-only terminal repair: no remote/canonical facts, no counter reset, and
-- no clearing a command to make a new mutation possible without explicit intent.
CREATE FUNCTION maildock_receiving_repair_intent(actor uuid, term bigint, account uuid, binding bigint, lifecycle bigint,
  kind text, intent uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE lease receiving_coordinator%ROWTYPE; a mail_accounts%ROWTYPE; r jsonb; n jsonb; marker jsonb;
  relation text; key text; mailbox uuid; message uuid; epoch bigint; source_uid bigint; configuration bigint; obsolete boolean; exhausted boolean; reason text; destination_unavailable boolean:=false;
BEGIN
  IF kind IS NULL OR kind NOT IN ('command','content','attachment','sent') OR
    nullif(current_setting('maildock.receiving_bounded_scope',true),'') IS NOT NULL OR
    nullif(current_setting('maildock.receiving_mailbox',true),'') IS NOT NULL THEN RAISE EXCEPTION 'Invalid repair scope'; END IF;
  SELECT * INTO STRICT lease FROM receiving_coordinator WHERE singleton FOR SHARE;
  PERFORM pg_advisory_xact_lock(hashtextextended('mailbox-discovery:'||account::text,0));
  SELECT * INTO STRICT a FROM mail_accounts WHERE id=account FOR SHARE;
  IF actor IS NULL OR term IS NULL OR lease.owner IS DISTINCT FROM actor OR lease.generation IS DISTINCT FROM term OR lease.expires_at<=clock_timestamp() OR
    NOT a.enabled OR a.removal_requested_at IS NOT NULL OR a.configuration_version IS DISTINCT FROM binding OR a.receiving_lifecycle_version IS DISTINCT FROM lifecycle THEN
    RAISE EXCEPTION 'Repair owner or account fenced'; END IF;
  relation:=CASE kind WHEN 'command' THEN 'message_commands' WHEN 'content' THEN 'message_contents' WHEN 'attachment' THEN 'message_attachments' ELSE 'outgoing_messages' END;
  key:=CASE kind WHEN 'content' THEN 'message_id' ELSE 'id' END;
  -- Account SHARE prevents configuration/epoch replacement; discovery mutex
  -- serializes role changes. Lock original mailboxes before intent as in R04.
  EXECUTE format('SELECT to_jsonb(r) FROM %I r WHERE %I=$1',relation,key) INTO STRICT r USING intent;
  mailbox:=CASE kind WHEN 'command' THEN (r->>'mailbox_id')::uuid WHEN 'sent' THEN (r->>'sent_copy_mailbox_id')::uuid ELSE (r->>'source_mailbox_id')::uuid END;
  IF kind IN ('content','attachment') THEN
    IF (SELECT account_id FROM messages WHERE id=(r->>'message_id')::uuid) IS DISTINCT FROM account THEN RAISE EXCEPTION 'Repair account fenced'; END IF;
  ELSIF r->>'account_id' IS DISTINCT FROM account::text THEN RAISE EXCEPTION 'Repair account fenced'; END IF;
  PERFORM 1 FROM mailboxes WHERE id IN (mailbox,(r->>'destination_mailbox_id')::uuid) ORDER BY id FOR UPDATE;
  PERFORM 1 FROM receiving_mailboxes WHERE mailbox_id IN (mailbox,(r->>'destination_mailbox_id')::uuid) ORDER BY mailbox_id FOR UPDATE;
  EXECUTE format('SELECT to_jsonb(r) FROM %I r WHERE %I=$1 FOR UPDATE',relation,key) INTO STRICT n USING intent;
  IF n IS DISTINCT FROM r THEN RAISE EXCEPTION 'Repair intent changed'; END IF;
  marker:=nullif(r->'receiving_attempt','null'::jsonb);
  IF marker->>'phase'='repair_terminal' THEN RETURN; END IF;
  exhausted:=false; obsolete:=false;
  IF kind='sent' THEN
    IF r->>'status'<>'sent' OR r->>'sent_copy_policy'<>'maildock' OR r->>'sent_copy_status' NOT IN ('saving','uncertain') OR marker IS NULL THEN RETURN; END IF;
    exhausted:=coalesce((marker->>'observations')::integer,0)>=3;
    obsolete:=marker->>'configuration' IS DISTINCT FROM binding::text OR NOT EXISTS(
      SELECT FROM mailboxes b JOIN receiving_mailboxes s ON s.mailbox_id=b.id WHERE b.id=mailbox AND b.account_id=account AND b.selectable AND b.lifecycle_status='active'
        AND b.remote_path=r->>'sent_copy_path' AND s.configuration_binding=binding AND s.epoch::text=marker->'scopes'->0->'state'->>'epoch') OR
      marker->'sentRole' IS DISTINCT FROM (SELECT to_jsonb(role_row) FROM mailbox_roles role_row WHERE role_row.account_id=account AND role_row.role='sent');
  ELSE
    IF r->>'status' NOT IN ('pending','executing','fetching','failed') OR (r->>'status'='failed' AND marker->>'phase' NOT IN ('claimed','uncertain_remote_execution')) THEN RETURN; END IF;
    IF kind='command' AND r->>'status' NOT IN ('pending','executing','failed') THEN RETURN; END IF;
    IF kind<>'command' AND r->>'status' NOT IN ('pending','fetching') THEN RETURN; END IF;
    message:=(r->>'message_id')::uuid; epoch:=(r->>'source_uid_validity')::bigint; source_uid:=(r->>'source_uid')::bigint; configuration:=(r->>'source_configuration_binding')::bigint;
    IF configuration IS NULL THEN RETURN; END IF;
    obsolete:=configuration IS DISTINCT FROM binding OR NOT maildock_receiving_active_source(account,mailbox,message,epoch,source_uid,configuration) OR
      (kind='command' AND r->>'source_path' IS DISTINCT FROM (SELECT remote_path FROM mailboxes WHERE id=mailbox)) OR
      (kind IN ('content','attachment') AND marker IS NOT NULL AND marker->>'path' IS DISTINCT FROM (SELECT remote_path FROM mailboxes WHERE id=mailbox));
    IF kind='command' AND r->>'action' IN ('archive','trash') THEN
      destination_unavailable:=NOT maildock_receiving_move_destination(account,r->>'action',(r->>'destination_mailbox_id')::uuid,r->>'destination_path');
      obsolete:=obsolete OR destination_unavailable OR NOT EXISTS(SELECT FROM mailbox_roles role_row JOIN mailboxes b ON b.id=role_row.mailbox_id WHERE role_row.account_id=account AND role_row.role=r->>'action'
        AND b.id=(r->>'destination_mailbox_id')::uuid AND b.remote_path=r->>'destination_path' AND b.selectable AND b.lifecycle_status='active') OR
        (marker IS NOT NULL AND marker->'role' IS DISTINCT FROM (SELECT to_jsonb(role_row) FROM mailbox_roles role_row WHERE role_row.account_id=account AND role_row.role=r->>'action')) OR
        (marker IS NOT NULL AND EXISTS(SELECT FROM jsonb_array_elements(marker->'scopes') x LEFT JOIN receiving_mailboxes s ON s.mailbox_id=(x->>'mailbox')::uuid WHERE s.epoch::text IS DISTINCT FROM x->'state'->>'epoch' OR s.configuration_binding IS DISTINCT FROM binding));
    END IF;
    exhausted:=CASE WHEN kind='command' THEN coalesce((marker->>'observations')::integer,0)>=3 ELSE coalesce((marker->>'reads')::integer,0)>=3 END;
  END IF;
  IF NOT exhausted AND NOT obsolete THEN RETURN; END IF;
  reason:=CASE WHEN obsolete THEN 'obsolete_receiving_identity' ELSE 'receiving_attempts_exhausted' END;
  -- Empty scopes permit only the exact terminal intent certificate, with the
  -- unchanged mandatory deferred elected-owner/account/DB-clock commit check.
  PERFORM set_config('maildock.receiving_bounded_scope',jsonb_build_object('kind','repair_intent','actor',actor,'generation',term::text,
    'account',account,'configuration',binding::text,'lifecycle',lifecycle::text,'scopes','[]'::jsonb)::text,true);
  n:=r || jsonb_build_object('updated_at',clock_timestamp());
  IF marker IS NOT NULL THEN n:=n || jsonb_build_object('receiving_attempt',marker || jsonb_build_object('phase','repair_terminal','repairReason',reason)); END IF;
  IF kind='sent' THEN
    n:=n || jsonb_build_object('sent_copy_status','uncertain','sent_copy_error','Message sent, but Maildock could not confirm whether the Sent copy was saved.');
    PERFORM maildock_receiving_bounded_permit(relation,'UPDATE',n,r);
    UPDATE outgoing_messages SET receiving_attempt=n->'receiving_attempt',sent_copy_status='uncertain',sent_copy_error=n->>'sent_copy_error',updated_at=(n->>'updated_at')::timestamptz WHERE id=intent;
  ELSE
    n:=n || jsonb_build_object('status','failed','error',CASE WHEN kind='command' AND marker IS NOT NULL THEN 'uncertain_remote_execution' WHEN kind='command' AND destination_unavailable THEN 'The configured system mailbox or IMAP MOVE is unavailable.' ELSE reason END);
    IF kind='command' THEN n:=n || jsonb_build_object('completed_at',clock_timestamp()); END IF;
    PERFORM maildock_receiving_bounded_permit(relation,'UPDATE',n,r);
    IF kind='command' THEN UPDATE message_commands SET receiving_attempt=nullif(n->'receiving_attempt','null'::jsonb),status='failed',error=n->>'error',completed_at=(n->>'completed_at')::timestamptz,updated_at=(n->>'updated_at')::timestamptz WHERE id=intent;
    ELSIF kind='content' THEN UPDATE message_contents SET receiving_attempt=nullif(n->'receiving_attempt','null'::jsonb),status='failed',error=n->>'error',updated_at=(n->>'updated_at')::timestamptz WHERE message_id=intent;
    ELSE UPDATE message_attachments SET receiving_attempt=nullif(n->'receiving_attempt','null'::jsonb),status='failed',error=n->>'error',updated_at=(n->>'updated_at')::timestamptz WHERE id=intent; END IF;
  END IF;
  PERFORM set_config('maildock.receiving_bounded_write','',true);
END $$;
REVOKE ALL ON FUNCTION maildock_receiving_repair_intent(uuid,bigint,uuid,bigint,bigint,text,uuid) FROM PUBLIC;

CREATE INDEX message_commands_receiving_repair_idx ON message_commands(updated_at,id) WHERE status IN ('pending','executing','failed') AND source_configuration_binding IS NOT NULL;
