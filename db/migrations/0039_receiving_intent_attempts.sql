-- R04-A. Claims live on the original business rows, never in a new ledger.
ALTER TABLE mail_accounts ADD COLUMN receiving_lifecycle_version bigint NOT NULL DEFAULT 1 CHECK(receiving_lifecycle_version>0);
CREATE FUNCTION maildock_receiving_lifecycle_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.enabled IS DISTINCT FROM OLD.enabled THEN NEW.receiving_lifecycle_version:=OLD.receiving_lifecycle_version+1;
  ELSIF NEW.receiving_lifecycle_version IS DISTINCT FROM OLD.receiving_lifecycle_version THEN
    RAISE EXCEPTION 'Receiving lifecycle version is derived'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER receiving_lifecycle_version BEFORE UPDATE ON mail_accounts
FOR EACH ROW EXECUTE FUNCTION maildock_receiving_lifecycle_version();
REVOKE ALL ON FUNCTION maildock_receiving_lifecycle_version() FROM PUBLIC;
--> statement-breakpoint
ALTER TABLE message_commands ADD COLUMN receiving_attempt jsonb;
ALTER TABLE message_contents ADD COLUMN receiving_attempt jsonb;
ALTER TABLE message_attachments ADD COLUMN receiving_attempt jsonb;
--> statement-breakpoint
-- Keep R02 request/metadata guards as the default-deny fallback.
--> statement-breakpoint
CREATE FUNCTION maildock_receiving_attempt_write(relation text, operation text, n jsonb, o jsonb)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE permit jsonb;
BEGIN
  permit:=nullif(current_setting('maildock.receiving_attempt_write',true),'')::jsonb;
  IF permit IS NULL THEN RETURN false; END IF;
  IF operation<>'UPDATE' OR relation IS DISTINCT FROM permit->>'relation'
    OR o IS DISTINCT FROM permit->'old' OR n IS DISTINCT FROM permit->'new' THEN
    RAISE EXCEPTION 'Receiving attempt write scope fenced';
  END IF;
  RETURN true;
END $$;
CREATE OR REPLACE FUNCTION maildock_receiving_command_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p mailbox_messages%ROWTYPE; b mailboxes%ROWTYPE; dest mailboxes%ROWTYPE;
BEGIN
  IF maildock_receiving_attempt_write(TG_TABLE_NAME,TG_OP,to_jsonb(NEW),to_jsonb(OLD)) THEN RETURN NEW; END IF;
  IF nullif(current_setting('maildock.receiving_operation',true),'')='attempt' THEN
    RAISE EXCEPTION 'Receiving attempt mixed command write forbidden'; END IF;
  IF TG_OP<>'DELETE' AND NEW.receiving_attempt IS NOT NULL AND
    (TG_OP='INSERT' OR NEW.receiving_attempt IS DISTINCT FROM OLD.receiving_attempt) THEN
    RAISE EXCEPTION 'Receiving attempt marker is owner-controlled';
  END IF;

  IF TG_OP<>'INSERT' AND maildock_receiving_account_enrolled(OLD.account_id) THEN
    RAISE EXCEPTION 'Receiving command execution capability disabled'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF NOT maildock_receiving_account_enrolled(NEW.account_id) AND NOT maildock_receiving_account_enrolled((SELECT account_id FROM messages WHERE id=NEW.message_id)) AND NOT maildock_receiving_account_enrolled((SELECT account_id FROM mailboxes WHERE id=NEW.mailbox_id)) THEN RETURN NEW; END IF;
  IF TG_OP<>'INSERT' OR NEW.status<>'pending' OR NEW.attempts<>0 OR NEW.started_at IS NOT NULL OR NEW.completed_at IS NOT NULL
    OR NEW.error IS NOT NULL OR NEW.destination_uid IS NOT NULL OR NEW.destination_uid_validity IS NOT NULL THEN
    RAISE EXCEPTION 'Receiving command intent-only fields required'; END IF;
  p:=maildock_receiving_intent_source(NEW.account_id,NEW.mailbox_id,NEW.message_id);
  SELECT * INTO STRICT b FROM mailboxes WHERE id=p.mailbox_id;
  IF p.id IS DISTINCT FROM NEW.placement_id OR p.uid IS DISTINCT FROM NEW.source_uid OR p.uid_validity IS DISTINCT FROM NEW.source_uid_validity
    OR p.configuration_binding IS DISTINCT FROM NEW.source_configuration_binding OR b.remote_path IS DISTINCT FROM NEW.source_path
    OR p.flags IS DISTINCT FROM NEW.original_flags THEN RAISE EXCEPTION 'Receiving command source mismatch'; END IF;
  IF NEW.action IN ('archive','trash') THEN
    SELECT d.* INTO dest FROM mailbox_roles r JOIN mailboxes d ON d.id=r.mailbox_id
      WHERE r.account_id=NEW.account_id AND r.role=NEW.action AND d.account_id=NEW.account_id AND d.selectable AND d.lifecycle_status='active';
    IF dest.id IS NULL OR dest.id=NEW.mailbox_id OR dest.id IS DISTINCT FROM NEW.destination_mailbox_id OR dest.remote_path IS DISTINCT FROM NEW.destination_path
      OR NOT EXISTS(SELECT FROM mail_accounts WHERE id=NEW.account_id AND imap_capabilities @> ARRAY['MOVE']::text[]) THEN
      RAISE EXCEPTION 'Receiving command destination mismatch'; END IF;
  ELSIF NEW.destination_mailbox_id IS NOT NULL OR NEW.destination_path IS NOT NULL THEN
    RAISE EXCEPTION 'Receiving flag command destination forbidden'; END IF;
  PERFORM maildock_receiving_request(NEW.account_id,NEW.mailbox_id);
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION maildock_receiving_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_data jsonb; scope uuid; context uuid; account_uuid uuid; previous boolean;
BEGIN
  IF maildock_receiving_attempt_write(TG_TABLE_NAME,TG_OP,to_jsonb(NEW),to_jsonb(OLD)) THEN RETURN NEW; END IF;
  IF nullif(current_setting('maildock.receiving_operation',true),'')='attempt' THEN
    RAISE EXCEPTION 'Receiving attempt mixed write forbidden'; END IF;
  IF TG_TABLE_NAME IN ('message_contents','message_attachments') THEN
    IF TG_OP<>'DELETE' AND NEW.receiving_attempt IS NOT NULL AND
      (TG_OP='INSERT' OR NEW.receiving_attempt IS DISTINCT FROM OLD.receiving_attempt) THEN
      RAISE EXCEPTION 'Receiving attempt marker is owner-controlled';
    END IF;
  END IF;

  IF TG_TABLE_NAME IN ('message_contents','message_attachments') AND TG_OP <> 'DELETE' THEN
    IF maildock_receiving_intent_guard(TG_TABLE_NAME,TG_OP,to_jsonb(NEW)-'receiving_attempt',CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD)-'receiving_attempt' ELSE NULL END) THEN RETURN NEW; END IF;
  END IF;
  IF NOT EXISTS(SELECT FROM receiving_mailboxes) THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  context := nullif(current_setting('maildock.receiving_mailbox',true),'')::uuid;
  -- Inspect both sides of UPDATE: moving an identity into an unenrolled scope
  -- must not erase its original mailbox's authority requirement.
  FOR previous IN SELECT false WHERE TG_OP<>'DELETE' UNION ALL SELECT true WHERE TG_OP IN ('UPDATE','DELETE') LOOP
  -- Project identities only. Do not duplicate MIME/body/attachment payloads for
  -- unenrolled v1 records when another mailbox uses the new receiving state.
  IF TG_TABLE_NAME IN ('messages','mailboxes') THEN
    IF previous THEN row_data:=jsonb_build_object('id',OLD.id,'account_id',OLD.account_id);
    ELSE row_data:=jsonb_build_object('id',NEW.id,'account_id',NEW.account_id); END IF;
  ELSIF TG_TABLE_NAME='mailbox_messages' THEN
    IF previous THEN row_data:=jsonb_build_object('mailbox_id',OLD.mailbox_id,'message_id',OLD.message_id,'uid_validity',OLD.uid_validity,'uid',OLD.uid,'modseq',OLD.modseq);
    ELSE row_data:=jsonb_build_object('mailbox_id',NEW.mailbox_id,'message_id',NEW.message_id,'uid_validity',NEW.uid_validity,'uid',NEW.uid,'modseq',NEW.modseq); END IF;
  ELSIF TG_TABLE_NAME='notification_events' THEN
    IF previous THEN row_data:=jsonb_build_object('account_id',OLD.account_id,'mailbox_id',OLD.mailbox_id,'message_id',OLD.message_id,'uid_validity',OLD.uid_validity,'uid',OLD.uid);
    ELSE row_data:=jsonb_build_object('account_id',NEW.account_id,'mailbox_id',NEW.mailbox_id,'message_id',NEW.message_id,'uid_validity',NEW.uid_validity,'uid',NEW.uid); END IF;
  ELSIF TG_TABLE_NAME='message_attachments' THEN
    IF previous THEN row_data:=jsonb_build_object('source_mailbox_id',OLD.source_mailbox_id,'message_id',OLD.message_id);
    ELSE row_data:=jsonb_build_object('source_mailbox_id',NEW.source_mailbox_id,'message_id',NEW.message_id); END IF;
  ELSIF TG_TABLE_NAME='message_contents' THEN
    IF previous THEN row_data:=jsonb_build_object('message_id',OLD.message_id);
    ELSE row_data:=jsonb_build_object('message_id',NEW.message_id); END IF;
  END IF;
  scope := NULL; account_uuid := NULL;
  IF TG_TABLE_NAME='mailboxes' THEN scope := (row_data->>'id')::uuid;
  ELSIF TG_TABLE_NAME IN ('mailbox_messages','notification_events') THEN scope := (row_data->>'mailbox_id')::uuid;
  ELSIF TG_TABLE_NAME='message_attachments' THEN scope := (row_data->>'source_mailbox_id')::uuid;
    IF scope IS NULL THEN
      SELECT m.id INTO scope FROM messages msg JOIN mailboxes m ON m.account_id=msg.account_id JOIN receiving_mailboxes s ON s.mailbox_id=m.id WHERE msg.id=(row_data->>'message_id')::uuid LIMIT 1;
    END IF;
  ELSIF TG_TABLE_NAME='messages' THEN
    account_uuid := (row_data->>'account_id')::uuid;
    SELECT m.id INTO scope FROM mailboxes m JOIN receiving_mailboxes s ON s.mailbox_id=m.id
      WHERE m.account_id=account_uuid LIMIT 1;
    IF context IS NOT NULL AND (SELECT account_id FROM mailboxes WHERE id=context)=account_uuid THEN scope:=context; END IF;
    IF TG_OP<>'INSERT' AND scope IS NOT NULL AND EXISTS(
      SELECT FROM mailbox_messages p JOIN receiving_mailboxes s ON s.mailbox_id=p.mailbox_id
      WHERE p.message_id=(row_data->>'id')::uuid AND p.mailbox_id IS DISTINCT FROM context) THEN
      RAISE EXCEPTION 'Receiving cross-mailbox metadata write fenced';
    END IF;
  ELSIF TG_TABLE_NAME='message_contents' THEN
    SELECT m.account_id INTO account_uuid FROM messages m WHERE m.id=(row_data->>'message_id')::uuid;
    SELECT m.id INTO scope FROM mailboxes m JOIN receiving_mailboxes s ON s.mailbox_id=m.id WHERE m.account_id=account_uuid LIMIT 1;
    -- Content publication is not a Stage 1 capability. Do not permit a v1 writer
    -- to publish ready bodies for an enrolled mailbox while routing is unwired.
    IF scope IS NOT NULL THEN RAISE EXCEPTION 'Receiving content capability disabled'; END IF;
  END IF;
  IF EXISTS(SELECT FROM receiving_mailboxes WHERE mailbox_id=scope) THEN
    IF TG_OP='UPDATE' AND TG_TABLE_NAME IN ('messages','mailboxes') THEN
      IF NEW.account_id IS DISTINCT FROM OLD.account_id THEN RAISE EXCEPTION 'Receiving account identity cannot change'; END IF;
    END IF;
    IF scope IS DISTINCT FROM context OR nullif(current_setting('maildock.receiving_revision',true),'') IS NULL THEN
      RAISE EXCEPTION 'Receiving authoritative write context missing';
    END IF;
    IF TG_TABLE_NAME IN ('mailbox_messages','notification_events') AND TG_OP<>'DELETE' THEN
      IF (row_data->>'uid_validity')::bigint <> (SELECT epoch FROM receiving_mailboxes WHERE mailbox_id=scope)
        OR (row_data->>'uid')::bigint NOT BETWEEN 1 AND 4294967295
        OR (row_data->>'modseq')::bigint < 0
        OR (TG_TABLE_NAME='notification_events' AND (row_data->>'account_id')::uuid IS DISTINCT FROM (SELECT account_id FROM mailboxes WHERE id=scope))
        OR (SELECT account_id FROM messages WHERE id=(row_data->>'message_id')::uuid)
          IS DISTINCT FROM (SELECT account_id FROM mailboxes WHERE id=scope) THEN
        RAISE EXCEPTION 'Receiving placement identity fenced';
      END IF;
    END IF;
  END IF;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
-- Existing triggers retain their identities, including the 0036 hint allowlist.
--> statement-breakpoint
CREATE FUNCTION maildock_receiving_attempt_context(actor uuid, term bigint, mailbox uuid, expected jsonb, binding bigint)
RETURNS receiving_mailboxes LANGUAGE plpgsql AS $$
DECLARE s receiving_mailboxes%ROWTYPE;
BEGIN
  IF actor IS NULL OR term IS NULL OR binding IS NULL OR expected IS NULL OR
    expected - ARRAY['epoch','revision','freshThrough','historyBefore','reconcileAfter'] <> '{}'::jsonb THEN
    RAISE EXCEPTION 'Invalid receiving attempt authority'; END IF;
  s:=maildock_receiving_claim(actor,term,mailbox,(expected->>'epoch')::bigint,(expected->>'revision')::bigint,
    (expected->>'freshThrough')::bigint,(expected->>'historyBefore')::bigint,(expected->>'reconcileAfter')::bigint);
  IF s.configuration_binding IS DISTINCT FROM binding OR
    (SELECT configuration_version FROM mail_accounts WHERE id=(SELECT account_id FROM mailboxes WHERE id=mailbox)) IS DISTINCT FROM binding OR
    ROW(s.epoch,s.revision,s.fresh_through,s.history_before,s.reconcile_after) IS DISTINCT FROM
    ROW((expected->>'epoch')::bigint,(expected->>'revision')::bigint,(expected->>'freshThrough')::bigint,(expected->>'historyBefore')::bigint,(expected->>'reconcileAfter')::bigint) THEN
    RAISE EXCEPTION 'Receiving attempt configuration or state fenced'; END IF;
  PERFORM set_config('maildock.receiving_operation','attempt',true);
  PERFORM set_config('maildock.receiving_lifecycle',(SELECT receiving_lifecycle_version::text FROM mail_accounts WHERE id=(SELECT account_id FROM mailboxes WHERE id=mailbox)),true);
  RETURN s;
END $$;
CREATE FUNCTION maildock_receiving_attempt_claim(actor uuid, term bigint, mailbox uuid, expected jsonb,
  binding bigint, kind text, intent uuid, attempt uuid)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE s receiving_mailboxes%ROWTYPE; r jsonb; n jsonb; marker jsonb; relation text; key text; account uuid;
BEGIN
  IF kind IS NULL OR kind NOT IN ('command','content','attachment') OR attempt IS NULL THEN
    RAISE EXCEPTION 'Invalid receiving attempt kind or identity'; END IF;
  s:=maildock_receiving_attempt_context(actor,term,mailbox,expected,binding);
  relation:=CASE kind WHEN 'command' THEN 'message_commands' WHEN 'content' THEN 'message_contents' ELSE 'message_attachments' END;
  key:=CASE kind WHEN 'content' THEN 'message_id' ELSE 'id' END;
  EXECUTE format('SELECT to_jsonb(r) FROM %I r WHERE %I=$1 FOR UPDATE',relation,key) INTO STRICT r USING intent;
  account:=(SELECT account_id FROM mailboxes WHERE id=mailbox);
  IF r->>'status' IS DISTINCT FROM 'pending' OR
    (CASE kind WHEN 'command' THEN r->>'mailbox_id' ELSE r->>'source_mailbox_id' END)::uuid IS DISTINCT FROM mailbox OR
    NOT maildock_receiving_active_source(account,mailbox,(r->>'message_id')::uuid,
      (r->>'source_uid_validity')::bigint,(r->>'source_uid')::bigint,(r->>'source_configuration_binding')::bigint) OR
    (kind='command' AND ((r->>'account_id')::uuid IS DISTINCT FROM account OR
      r->>'source_path' IS DISTINCT FROM (SELECT remote_path FROM mailboxes WHERE id=mailbox) OR
      (r->>'attempts')::integer>=3 OR r->>'action' IN ('archive','trash'))) THEN
    RAISE EXCEPTION 'Receiving pending source or operation fenced'; END IF;
  IF r->'receiving_attempt'->>'id'=attempt::text THEN RAISE EXCEPTION 'Receiving attempt identity cannot repeat'; END IF;
  marker:=jsonb_build_object('id',attempt,'actor',actor,'generation',term::text,'account',account,
    'mailbox',mailbox,'path',(SELECT remote_path FROM mailboxes WHERE id=mailbox),'epoch',s.epoch::text,
    'uid',r->>'source_uid','configuration',binding::text,'claimRevision',(s.revision+1)::text,
    'phase','claimed','kind',kind,'lifecycle',(SELECT receiving_lifecycle_version::text FROM mail_accounts WHERE id=account));
  n:=r || jsonb_build_object('receiving_attempt',marker,'status',CASE kind WHEN 'command' THEN 'executing' ELSE 'fetching' END,
    'error',NULL,'updated_at',clock_timestamp());
  IF kind='command' THEN n:=n || jsonb_build_object('attempts',(r->>'attempts')::integer+1,'started_at',clock_timestamp()); END IF;
  PERFORM set_config('maildock.receiving_attempt_write',jsonb_build_object('relation',relation,'old',r,'new',n)::text,true);
  IF kind='command' THEN
    UPDATE message_commands SET receiving_attempt=marker,status='executing',error=NULL,attempts=attempts+1,
      started_at=(n->>'started_at')::timestamptz,updated_at=(n->>'updated_at')::timestamptz WHERE id=intent;
  ELSIF kind='content' THEN
    UPDATE message_contents SET receiving_attempt=marker,status='fetching',error=NULL,updated_at=(n->>'updated_at')::timestamptz WHERE message_id=intent;
  ELSE
    UPDATE message_attachments SET receiving_attempt=marker,status='fetching',error=NULL,updated_at=(n->>'updated_at')::timestamptz WHERE id=intent;
  END IF;
  PERFORM set_config('maildock.receiving_attempt_write','',true);
  UPDATE receiving_mailboxes SET revision=revision+1 WHERE mailbox_id=mailbox;
  RETURN marker;
END $$;
--> statement-breakpoint
CREATE FUNCTION maildock_receiving_attempt_failure(actor uuid, term bigint, mailbox uuid, expected jsonb,
  binding bigint, kind text, intent uuid, attempt uuid, outcome text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE r jsonb; n jsonb; relation text; key text; s receiving_mailboxes%ROWTYPE;
BEGIN
  IF kind IS NULL OR kind NOT IN ('command','content','attachment') OR outcome IS NULL OR
    outcome NOT IN ('failed_before_execution','uncertain_remote_execution','failed_remote_read') THEN
    RAISE EXCEPTION 'Invalid receiving failure capability'; END IF;
  s:=maildock_receiving_attempt_context(actor,term,mailbox,expected,binding);
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
    r->'receiving_attempt'->>'path' IS DISTINCT FROM (SELECT remote_path FROM mailboxes WHERE id=mailbox) OR
    (kind='command' AND outcome='failed_remote_read') OR
    (kind<>'command' AND outcome='uncertain_remote_execution') THEN
    RAISE EXCEPTION 'Receiving matching failure attempt fenced'; END IF;
  n:=r || jsonb_build_object('status','failed','error',outcome,'updated_at',clock_timestamp(),
    'receiving_attempt',r->'receiving_attempt' || jsonb_build_object('phase',outcome));
  IF kind='command' THEN n:=n || jsonb_build_object('completed_at',clock_timestamp()); END IF;
  PERFORM set_config('maildock.receiving_attempt_write',jsonb_build_object('relation',relation,'old',r,'new',n)::text,true);
  IF kind='command' THEN
    UPDATE message_commands SET status='failed',error=outcome,receiving_attempt=n->'receiving_attempt',
      completed_at=(n->>'completed_at')::timestamptz,updated_at=(n->>'updated_at')::timestamptz WHERE id=intent;
  ELSIF kind='content' THEN
    UPDATE message_contents SET status='failed',error=outcome,receiving_attempt=n->'receiving_attempt',updated_at=(n->>'updated_at')::timestamptz WHERE message_id=intent;
  ELSE
    UPDATE message_attachments SET status='failed',error=outcome,receiving_attempt=n->'receiving_attempt',updated_at=(n->>'updated_at')::timestamptz WHERE id=intent;
  END IF;
  PERFORM set_config('maildock.receiving_attempt_write','',true);
  IF outcome='uncertain_remote_execution' THEN
    PERFORM maildock_receiving_request((r->'receiving_attempt'->>'account')::uuid,mailbox);
  END IF;
  UPDATE receiving_mailboxes SET revision=revision+1 WHERE mailbox_id=mailbox;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER receiving_command_authority AFTER UPDATE ON message_commands
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION maildock_receiving_commit_authority();
REVOKE ALL ON FUNCTION maildock_receiving_attempt_write(text,text,jsonb,jsonb),
  maildock_receiving_attempt_context(uuid,bigint,uuid,jsonb,bigint),
  maildock_receiving_attempt_claim(uuid,bigint,uuid,jsonb,bigint,text,uuid,uuid),
  maildock_receiving_attempt_failure(uuid,bigint,uuid,jsonb,bigint,text,uuid,uuid,text),
  maildock_receiving_command_guard(),maildock_receiving_write_guard() FROM PUBLIC;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION maildock_receiving_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF nullif(current_setting('maildock.receiving_operation',true),'')='attempt' AND
    (TG_OP<>'UPDATE' OR ROW(NEW.epoch,NEW.fresh_through,NEW.history_before,NEW.reconcile_after,NEW.configuration_binding)
      IS DISTINCT FROM ROW(OLD.epoch,OLD.fresh_through,OLD.history_before,OLD.reconcile_after,OLD.configuration_binding)) THEN
    RAISE EXCEPTION 'Receiving attempt cannot change coverage or identity'; END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Receiving revision cannot reset'; END IF;
  IF NEW.mailbox_id::text IS DISTINCT FROM current_setting('maildock.receiving_mailbox',true) THEN
    RAISE EXCEPTION 'Receiving context missing';
  END IF;
  IF TG_OP='UPDATE' AND (NEW.mailbox_id <> OLD.mailbox_id OR NEW.revision <> OLD.revision+1) THEN
    RAISE EXCEPTION 'Receiving revision must increment exactly once';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF nullif(current_setting('maildock.receiving_revision',true),'')::bigint IS DISTINCT FROM OLD.revision THEN
      RAISE EXCEPTION 'Receiving expected revision missing';
    END IF;
    IF NEW.epoch=OLD.epoch AND (NEW.fresh_through<OLD.fresh_through OR NEW.history_before>OLD.history_before) THEN
      RAISE EXCEPTION 'Receiving coverage cannot regress';
    END IF;
    IF NEW.epoch<>OLD.epoch AND (NEW.history_before<>NEW.fresh_through+1 OR NEW.reconcile_after<>0) THEN
      RAISE EXCEPTION 'Receiving epoch reset requires empty coverage';
    END IF;
  END IF;
  IF TG_OP='INSERT' AND (NEW.revision<>0 OR EXISTS(SELECT FROM mailbox_messages WHERE mailbox_id=NEW.mailbox_id)) THEN
    RAISE EXCEPTION 'Receiving enrollment requires an empty new mailbox';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION maildock_receiving_attempt_recover(actor uuid, term bigint, mailbox uuid, kind text, intent uuid)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE s receiving_mailboxes%ROWTYPE; r jsonb; relation text; key text;
BEGIN
  IF actor IS NULL OR term IS NULL OR kind IS NULL OR kind NOT IN ('command','content','attachment') THEN RAISE EXCEPTION 'Invalid recovery kind or owner'; END IF;
  s:=maildock_receiving_recover(actor,term,mailbox);
  relation:=CASE kind WHEN 'command' THEN 'message_commands' WHEN 'content' THEN 'message_contents' ELSE 'message_attachments' END;
  key:=CASE kind WHEN 'content' THEN 'message_id' ELSE 'id' END;
  EXECUTE format('SELECT to_jsonb(r) FROM %I r WHERE %I=$1 FOR UPDATE',relation,key) INTO STRICT r USING intent;
  IF (CASE kind WHEN 'command' THEN r->>'mailbox_id' ELSE r->>'source_mailbox_id' END)::uuid IS DISTINCT FROM mailbox THEN
    RAISE EXCEPTION 'Receiving recovery source fenced'; END IF;
  RETURN jsonb_build_object('state',to_jsonb(s),'intent',r);
END $$;
REVOKE ALL ON FUNCTION maildock_receiving_attempt_recover(uuid,bigint,uuid,text,uuid) FROM PUBLIC;

--> statement-breakpoint
CREATE FUNCTION maildock_receiving_command_result(actor uuid, term bigint, mailbox uuid, expected jsonb,
  binding bigint, intent uuid, attempt uuid, evidence jsonb)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE r jsonb; n jsonb; relation text; key text; s receiving_mailboxes%ROWTYPE; kind text:='command'; p mailbox_messages%ROWTYPE; updated mailbox_messages%ROWTYPE; flags text[]; flag text; desired boolean;
BEGIN
  IF evidence IS NULL OR evidence - ARRAY['complete','epoch','uid','flags','modseq'] <> '{}'::jsonb OR evidence->'complete' IS DISTINCT FROM 'true'::jsonb OR
    jsonb_typeof(evidence->'flags') IS DISTINCT FROM 'array' OR jsonb_array_length(evidence->'flags')>128 OR octet_length(evidence::text)>65536 THEN
    RAISE EXCEPTION 'Invalid complete STORE result evidence'; END IF;
  s:=maildock_receiving_attempt_context(actor,term,mailbox,expected,binding);
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
REVOKE ALL ON FUNCTION maildock_receiving_command_result(uuid,bigint,uuid,jsonb,bigint,uuid,uuid,jsonb) FROM PUBLIC;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION maildock_receiving_commit_authority() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE lease receiving_coordinator%ROWTYPE; state receiving_mailboxes%ROWTYPE;
  folder mailboxes%ROWTYPE; enabled_account boolean; expected bigint;
BEGIN
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
  -- L is this final clock comparison in the last mandatory deferred invocation.
  -- The SHARE lock conflicts with takeover until transaction end, including after L.
  IF lease.expires_at <= clock_timestamp() THEN RAISE EXCEPTION 'Receiving COMMIT lease expired'; END IF;
  RETURN NULL;
END $$;