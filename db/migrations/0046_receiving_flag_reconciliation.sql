CREATE FUNCTION maildock_receiving_command_result_locked(actor uuid, term bigint, mailbox uuid, expected jsonb,
  binding bigint, intent uuid, attempt uuid, evidence jsonb)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE r jsonb; n jsonb; relation text; key text; s receiving_mailboxes%ROWTYPE; kind text:='command'; p mailbox_messages%ROWTYPE; updated mailbox_messages%ROWTYPE; flags text[]; flag text; desired boolean;
BEGIN
  IF evidence IS NULL OR evidence - ARRAY['complete','epoch','uid','flags','modseq'] <> '{}'::jsonb OR evidence->'complete' IS DISTINCT FROM 'true'::jsonb OR
    jsonb_typeof(evidence->'flags') IS DISTINCT FROM 'array' OR jsonb_array_length(evidence->'flags')>128 OR octet_length(evidence::text)>65536 THEN
    RAISE EXCEPTION 'Invalid complete STORE result evidence'; END IF;
  IF current_setting('maildock.receiving_operation',true) IS DISTINCT FROM 'attempt'
    OR current_setting('maildock.receiving_owner',true) IS DISTINCT FROM actor::text
    OR current_setting('maildock.receiving_generation',true) IS DISTINCT FROM term::text
    OR current_setting('maildock.receiving_mailbox',true) IS DISTINCT FROM mailbox::text
    OR current_setting('maildock.receiving_revision',true) IS DISTINCT FROM expected->>'revision' THEN
    RAISE EXCEPTION 'STORE locked authority context required'; END IF;
  relation:=CASE kind WHEN 'command' THEN 'message_commands' WHEN 'content' THEN 'message_contents' ELSE 'message_attachments' END;
  key:=CASE kind WHEN 'content' THEN 'message_id' ELSE 'id' END;
  EXECUTE format('SELECT to_jsonb(r) FROM %I r WHERE %I=$1 FOR UPDATE',relation,key) INTO STRICT r USING intent;
  IF r->'receiving_attempt'->>'id' IS DISTINCT FROM attempt::text OR attempt IS NULL OR
    r->'receiving_attempt'->>'actor' IS DISTINCT FROM actor::text OR
    r->'receiving_attempt'->>'generation' IS DISTINCT FROM term::text OR
    r->'receiving_attempt'->>'phase' IS DISTINCT FROM 'claimed' OR
    r->'receiving_attempt'->>'kind' IS DISTINCT FROM kind OR
    r->'receiving_attempt'->>'mailbox' IS DISTINCT FROM mailbox::text OR
    r->>'status' IS DISTINCT FROM (CASE kind WHEN 'command' THEN 'executing' ELSE 'fetching' END) OR
    NOT maildock_receiving_active_source((r->'receiving_attempt'->>'account')::uuid,mailbox,(r->>'message_id')::uuid,
      (r->'receiving_attempt'->>'epoch')::bigint,(r->'receiving_attempt'->>'uid')::bigint,binding) OR
    r->'receiving_attempt'->>'lifecycle' IS DISTINCT FROM (SELECT receiving_lifecycle_version::text FROM mail_accounts WHERE id=(r->'receiving_attempt'->>'account')::uuid) OR
    r->'receiving_attempt'->>'path' IS DISTINCT FROM (SELECT remote_path FROM mailboxes WHERE id=mailbox) THEN
    RAISE EXCEPTION 'Receiving matching failure attempt fenced'; END IF;
  IF r->>'action' NOT IN ('mark_read','mark_unread','flag','unflag') OR
    (evidence->>'epoch')::bigint IS DISTINCT FROM (r->>'source_uid_validity')::bigint OR
    (evidence->>'uid')::bigint IS DISTINCT FROM (r->>'source_uid')::bigint THEN
    RAISE EXCEPTION 'STORE result source or action fenced'; END IF;
  flags:=ARRAY(SELECT jsonb_array_elements_text(evidence->'flags'));
  flag:=CASE WHEN r->>'action' IN ('mark_read','mark_unread') THEN E'\\Seen' ELSE E'\\Flagged' END;
  desired:=r->>'action' IN ('mark_read','flag');
  IF (flag=ANY(flags)) IS DISTINCT FROM desired OR EXISTS(SELECT FROM unnest(flags) f WHERE f IS NULL OR octet_length(f)>256) OR
    cardinality(flags)<>(SELECT count(DISTINCT f) FROM unnest(flags) f) THEN
    RAISE EXCEPTION 'STORE result does not evidence desired state'; END IF;
  SELECT * INTO STRICT p FROM mailbox_messages WHERE id=(r->>'placement_id')::uuid FOR UPDATE;
  IF (evidence->>'modseq')::bigint<0 OR (p.modseq IS NOT NULL AND ((evidence->>'modseq')::bigint IS NULL OR (evidence->>'modseq')::bigint<p.modseq)) THEN
    RAISE EXCEPTION 'STORE stale MODSEQ fenced'; END IF;
  updated:=p; updated.flags:=flags; updated.modseq:=(evidence->>'modseq')::bigint; updated.updated_at:=clock_timestamp();
  PERFORM set_config('maildock.receiving_attempt_write',jsonb_build_object('relation','mailbox_messages','old',to_jsonb(p),'new',to_jsonb(updated))::text,true);
  UPDATE mailbox_messages SET flags=updated.flags,modseq=updated.modseq,updated_at=updated.updated_at WHERE id=p.id;
  n:=r || jsonb_build_object('status','succeeded','error',NULL,'updated_at',clock_timestamp(),'completed_at',clock_timestamp(),
    'receiving_attempt',r->'receiving_attempt' || jsonb_build_object('phase','succeeded'));
  PERFORM set_config('maildock.receiving_attempt_write',jsonb_build_object('relation',relation,'old',r,'new',n)::text,true);
  UPDATE message_commands SET status='succeeded',error=NULL,receiving_attempt=n->'receiving_attempt',
    completed_at=(n->>'completed_at')::timestamptz,updated_at=(n->>'updated_at')::timestamptz WHERE id=intent;
  PERFORM set_config('maildock.receiving_attempt_write','',true);
  UPDATE receiving_mailboxes SET revision=revision+1 WHERE mailbox_id=mailbox;
END $$;
REVOKE ALL ON FUNCTION maildock_receiving_command_result_locked(uuid,bigint,uuid,jsonb,bigint,uuid,uuid,jsonb) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION maildock_receiving_command_result(actor uuid, term bigint, mailbox uuid, expected jsonb,
  binding bigint, intent uuid, attempt uuid, evidence jsonb) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM maildock_receiving_attempt_context(actor,term,mailbox,expected,binding);
  PERFORM maildock_receiving_command_result_locked(actor,term,mailbox,expected,binding,intent,attempt,evidence);
END $$;
--> statement-breakpoint
-- R10: bounded read reconciliation on the original command/attempt, never a
-- second mutation claim or execution ledger. All writes retain R04 row permits.
CREATE FUNCTION maildock_receiving_flag_uncertain(actor uuid, term bigint, mailbox uuid, expected jsonb,
  binding bigint, intent uuid, attempt uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r message_commands%ROWTYPE; n jsonb;
BEGIN
  PERFORM maildock_receiving_attempt_failure(actor,term,mailbox,expected,binding,'command',intent,attempt,'uncertain_remote_execution');
  SELECT * INTO STRICT r FROM message_commands WHERE id=intent FOR UPDATE;
  -- Retain optimistic intent and serialization until remote inspection settles
  -- the original attempt; a disconnected socket cannot prove failure.
  n:=to_jsonb(r) || jsonb_build_object('status','executing','completed_at',NULL);
  PERFORM set_config('maildock.receiving_attempt_write',jsonb_build_object('relation','message_commands','old',to_jsonb(r),'new',n)::text,true);
  UPDATE message_commands SET status='executing',completed_at=NULL WHERE id=intent;
  PERFORM set_config('maildock.receiving_attempt_write','',true);
END $$;
REVOKE ALL ON FUNCTION maildock_receiving_flag_uncertain(uuid,bigint,uuid,jsonb,bigint,uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION maildock_receiving_flag_resume(actor uuid, term bigint, mailbox uuid, expected jsonb,
  binding bigint, intent uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r message_commands%ROWTYPE; n jsonb; marker jsonb; s receiving_mailboxes%ROWTYPE;
BEGIN
  s:=maildock_receiving_attempt_context(actor,term,mailbox,expected,binding);
  SELECT * INTO STRICT r FROM message_commands WHERE id=intent FOR UPDATE;
  marker:=r.receiving_attempt;
  IF r.mailbox_id IS DISTINCT FROM mailbox OR r.action NOT IN ('mark_read','mark_unread','flag','unflag')
    OR r.status NOT IN ('executing','failed') OR marker IS NULL
    OR marker->>'phase' NOT IN ('claimed','uncertain_remote_execution') OR marker->>'kind' IS DISTINCT FROM 'command'
    OR marker->>'mailbox' IS DISTINCT FROM mailbox::text OR marker->>'account' IS DISTINCT FROM r.account_id::text
    OR marker->>'epoch' IS DISTINCT FROM r.source_uid_validity::text OR marker->>'uid' IS DISTINCT FROM r.source_uid::text
    OR marker->>'configuration' IS DISTINCT FROM binding::text OR r.source_configuration_binding IS DISTINCT FROM binding
    OR marker->>'path' IS DISTINCT FROM r.source_path OR r.source_path IS DISTINCT FROM (SELECT remote_path FROM mailboxes WHERE id=mailbox)
    OR coalesce((marker->>'observations')::integer,0)>=3
    OR NOT maildock_receiving_active_source(r.account_id,mailbox,r.message_id,r.source_uid_validity,r.source_uid,binding) THEN
    RAISE EXCEPTION 'Flag reconciliation source or budget fenced'; END IF;
  marker:=marker || jsonb_build_object('observations',(coalesce((marker->>'observations')::integer,0)+1)::text,
    'reconciliationActor',actor,'reconciliationGeneration',term::text,
    'reconciliationLifecycle',(SELECT receiving_lifecycle_version::text FROM mail_accounts WHERE id=r.account_id));
  n:=to_jsonb(r) || jsonb_build_object('receiving_attempt',marker,'updated_at',clock_timestamp());
  PERFORM set_config('maildock.receiving_attempt_write',jsonb_build_object('relation','message_commands','old',to_jsonb(r),'new',n)::text,true);
  UPDATE message_commands SET receiving_attempt=marker,updated_at=(n->>'updated_at')::timestamptz WHERE id=intent;
  PERFORM set_config('maildock.receiving_attempt_write','',true);
  UPDATE receiving_mailboxes SET revision=revision+1 WHERE mailbox_id=mailbox;
END $$;
REVOKE ALL ON FUNCTION maildock_receiving_flag_resume(uuid,bigint,uuid,jsonb,bigint,uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION maildock_receiving_flag_recovery_result(actor uuid, term bigint, mailbox uuid, expected jsonb,
  binding bigint, intent uuid, attempt uuid, evidence jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r message_commands%ROWTYPE; n jsonb; marker jsonb; lifecycle text;
BEGIN
  PERFORM maildock_receiving_attempt_context(actor,term,mailbox,expected,binding);
  SELECT * INTO STRICT r FROM message_commands WHERE id=intent FOR UPDATE;
  marker:=r.receiving_attempt;
  lifecycle:=(SELECT receiving_lifecycle_version::text FROM mail_accounts WHERE id=r.account_id);
  IF attempt IS NULL OR marker IS NULL OR marker->>'id' IS DISTINCT FROM attempt::text
    OR r.mailbox_id IS DISTINCT FROM mailbox OR r.action NOT IN ('mark_read','mark_unread','flag','unflag')
    OR r.status NOT IN ('executing','failed') OR marker->>'phase' NOT IN ('claimed','uncertain_remote_execution')
    OR marker->>'kind' IS DISTINCT FROM 'command' OR marker->>'mailbox' IS DISTINCT FROM mailbox::text
    OR marker->>'account' IS DISTINCT FROM r.account_id::text OR marker->>'epoch' IS DISTINCT FROM r.source_uid_validity::text
    OR marker->>'uid' IS DISTINCT FROM r.source_uid::text OR marker->>'configuration' IS DISTINCT FROM binding::text
    OR r.source_configuration_binding IS DISTINCT FROM binding OR marker->>'path' IS DISTINCT FROM r.source_path
    OR r.source_path IS DISTINCT FROM (SELECT remote_path FROM mailboxes WHERE id=mailbox)
    OR NOT maildock_receiving_active_source(r.account_id,mailbox,r.message_id,r.source_uid_validity,r.source_uid,binding)
    OR ((marker->>'reconciliationActor'=actor::text AND marker->>'reconciliationGeneration'=term::text
      AND marker->>'reconciliationLifecycle'=lifecycle) OR (evidence IS NULL AND marker->>'actor'=actor::text
      AND marker->>'generation'=term::text AND marker->>'lifecycle'=lifecycle AND marker->>'phase'='claimed')) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Flag reconciliation result fenced'; END IF;
  IF evidence IS NULL THEN
    marker:=marker || jsonb_build_object('phase','flag_conflict');
    n:=to_jsonb(r) || jsonb_build_object('receiving_attempt',marker,'status','failed','error','flag_conflict',
      'updated_at',clock_timestamp(),'completed_at',clock_timestamp());
    PERFORM set_config('maildock.receiving_attempt_write',jsonb_build_object('relation','message_commands','old',to_jsonb(r),'new',n)::text,true);
    UPDATE message_commands SET receiving_attempt=marker,status='failed',error='flag_conflict',
      updated_at=(n->>'updated_at')::timestamptz,completed_at=(n->>'completed_at')::timestamptz WHERE id=intent;
    PERFORM set_config('maildock.receiving_attempt_write','',true);
    UPDATE receiving_mailboxes SET revision=revision+1 WHERE mailbox_id=mailbox;
  ELSE
    -- Rebind only inside this atomic result transaction. The original attempt ID
    -- remains intact and this intermediate state cannot authorize remote replay.
    marker:=marker || jsonb_build_object('originalActor',coalesce(marker->>'originalActor',marker->>'actor'),
      'originalGeneration',coalesce(marker->>'originalGeneration',marker->>'generation'),
      'actor',actor,'generation',term::text,'lifecycle',lifecycle,'phase','claimed');
    n:=to_jsonb(r) || jsonb_build_object('receiving_attempt',marker,'status','executing','error',NULL);
    PERFORM set_config('maildock.receiving_attempt_write',jsonb_build_object('relation','message_commands','old',to_jsonb(r),'new',n)::text,true);
    UPDATE message_commands SET receiving_attempt=marker,status='executing',error=NULL WHERE id=intent;
    PERFORM set_config('maildock.receiving_attempt_write','',true);
    PERFORM maildock_receiving_command_result_locked(actor,term,mailbox,expected,binding,intent,attempt,evidence);
  END IF;
END $$;
REVOKE ALL ON FUNCTION maildock_receiving_flag_recovery_result(uuid,bigint,uuid,jsonb,bigint,uuid,uuid,jsonb) FROM PUBLIC;
--> statement-breakpoint
CREATE INDEX message_commands_flag_work_idx ON message_commands(account_id,created_at,id)
  WHERE action IN ('mark_read','mark_unread','flag','unflag') AND status IN ('pending','executing','failed');
