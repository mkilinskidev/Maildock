-- R02: existing rows remain the only business ledger. No execution capability.
ALTER TABLE mail_accounts ADD COLUMN configuration_version bigint NOT NULL DEFAULT 1 CHECK(configuration_version>0);
ALTER TABLE receiving_mailboxes ADD COLUMN configuration_binding bigint NOT NULL DEFAULT 1 CHECK(configuration_binding>0);
ALTER TABLE mailbox_messages ADD COLUMN configuration_binding bigint NOT NULL DEFAULT 1 CHECK(configuration_binding>0);
ALTER TABLE message_commands ADD COLUMN source_configuration_binding bigint;
ALTER TABLE message_contents ADD COLUMN source_mailbox_id uuid CONSTRAINT message_contents_source_mailbox_id_mailboxes_id_fk REFERENCES mailboxes(id) ON DELETE RESTRICT;
ALTER TABLE message_contents ADD COLUMN source_uid_validity bigint;
ALTER TABLE message_contents ADD COLUMN source_uid bigint;
ALTER TABLE message_contents ADD COLUMN source_configuration_binding bigint;
ALTER TABLE message_attachments ADD COLUMN source_configuration_binding bigint;
--> statement-breakpoint
CREATE FUNCTION maildock_receiving_configuration_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.imap_host,NEW.imap_port,NEW.imap_security,NEW.imap_username,NEW.imap_password,NEW.auth_method,NEW.oauth_status,NEW.oauth_provider_id,NEW.oauth_home_account_id)
    IS DISTINCT FROM ROW(OLD.imap_host,OLD.imap_port,OLD.imap_security,OLD.imap_username,OLD.imap_password,OLD.auth_method,OLD.oauth_status,OLD.oauth_provider_id,OLD.oauth_home_account_id) THEN
    NEW.configuration_version := OLD.configuration_version+1;
  ELSIF NEW.configuration_version IS DISTINCT FROM OLD.configuration_version THEN
    RAISE EXCEPTION 'Receiving configuration version is derived';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER receiving_configuration_version BEFORE UPDATE ON mail_accounts
FOR EACH ROW EXECUTE FUNCTION maildock_receiving_configuration_version();
--> statement-breakpoint
CREATE FUNCTION maildock_receiving_bind_metadata() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE scope uuid; binding bigint;
BEGIN
  scope := nullif(current_setting('maildock.receiving_mailbox',true),'')::uuid;
  IF scope IS NOT NULL THEN
    SELECT configuration_binding INTO binding FROM receiving_mailboxes WHERE mailbox_id=scope;
    IF TG_TABLE_NAME='mailbox_messages' THEN NEW.configuration_binding:=binding;
    ELSE NEW.source_configuration_binding:=binding; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER receiving_bind_metadata BEFORE INSERT ON mailbox_messages
FOR EACH ROW EXECUTE FUNCTION maildock_receiving_bind_metadata();
CREATE TRIGGER receiving_bind_metadata BEFORE INSERT ON message_attachments
FOR EACH ROW EXECUTE FUNCTION maildock_receiving_bind_metadata();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION maildock_receiving_initialize(actor uuid, term bigint, mailbox uuid, new_epoch bigint, boundary bigint)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM maildock_receiving_lock(actor,term,mailbox);
  IF EXISTS(SELECT FROM receiving_mailboxes WHERE mailbox_id=mailbox) OR
    (EXISTS(SELECT FROM messages WHERE account_id=(SELECT account_id FROM mailboxes WHERE id=mailbox)) AND
     NOT EXISTS(SELECT FROM receiving_mailboxes s JOIN mailboxes m ON m.id=s.mailbox_id WHERE m.account_id=(SELECT account_id FROM mailboxes WHERE id=mailbox))) THEN
    RAISE EXCEPTION 'Receiving initialization is new-install only';
  END IF;
  PERFORM set_config('maildock.receiving_revision','-1',true);
  UPDATE mailboxes SET uid_validity=new_epoch WHERE id=mailbox;
  INSERT INTO receiving_mailboxes(mailbox_id,epoch,revision,fresh_through,history_before,reconcile_after,configuration_binding)
    VALUES(mailbox,new_epoch,0,boundary-1,boundary,0,(SELECT configuration_version FROM mail_accounts WHERE id=(SELECT account_id FROM mailboxes WHERE id=mailbox)));
END $$;
--> statement-breakpoint
CREATE FUNCTION maildock_receiving_account_enrolled(account uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT FROM receiving_mailboxes s JOIN mailboxes b ON b.id=s.mailbox_id WHERE b.account_id=account)
$$;
CREATE FUNCTION maildock_receiving_active_source(account uuid, mailbox uuid, message uuid, epoch bigint, remote_uid bigint, binding bigint)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT FROM mailbox_messages p JOIN messages m ON m.id=p.message_id
    JOIN mailboxes b ON b.id=p.mailbox_id JOIN mail_accounts a ON a.id=b.account_id
    JOIN receiving_mailboxes s ON s.mailbox_id=b.id
    WHERE a.id=account AND m.account_id=account AND b.id=mailbox AND m.id=message
      AND b.selectable AND b.lifecycle_status='active' AND p.uid=remote_uid AND p.uid BETWEEN 1 AND 4294967295
      AND p.uid_validity=epoch AND b.uid_validity=epoch AND s.epoch=epoch
      AND p.configuration_binding=binding AND s.configuration_binding=binding AND a.configuration_version=binding)
$$;
--> statement-breakpoint
-- Lock account SHARE, mailbox UPDATE, placement UPDATE; never upgrade account
-- SHARE to UPDATE. Demand is recorded on the already locked mailbox, not account.
CREATE FUNCTION maildock_receiving_intent_source(account uuid, mailbox uuid, message uuid)
RETURNS mailbox_messages LANGUAGE plpgsql AS $$
DECLARE p mailbox_messages%ROWTYPE;
BEGIN
  PERFORM set_config('lock_timeout','2000',true);
  IF NOT EXISTS(SELECT FROM mail_accounts WHERE id=account AND enabled FOR SHARE) THEN
    RAISE EXCEPTION 'Receiving request account unavailable'; END IF;
  PERFORM 1 FROM mailboxes WHERE id=mailbox AND account_id=account FOR UPDATE;
  SELECT * INTO p FROM mailbox_messages WHERE mailbox_id=mailbox AND message_id=message FOR UPDATE;
  IF NOT FOUND OR NOT maildock_receiving_active_source(account,mailbox,message,p.uid_validity,p.uid,p.configuration_binding) THEN
    RAISE EXCEPTION 'Receiving request source unavailable'; END IF;
  RETURN p;
END $$;
--> statement-breakpoint
-- Field allowlists compare the entire JSON row: new/future authoritative columns
-- are forbidden by default. No caller-controlled bypass or receiving owner GUC.
CREATE FUNCTION maildock_receiving_intent_guard(relation text, operation text, n jsonb, o jsonb)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE account uuid; p mailbox_messages%ROWTYPE;
BEGIN
  SELECT account_id INTO account FROM messages WHERE id=(n->>'message_id')::uuid;
  IF NOT maildock_receiving_account_enrolled(account) AND
    (o IS NULL OR NOT maildock_receiving_account_enrolled((SELECT account_id FROM messages WHERE id=(o->>'message_id')::uuid))) THEN RETURN false; END IF;
  IF relation='message_attachments' AND (operation='INSERT' OR nullif(current_setting('maildock.receiving_mailbox',true),'') IS NOT NULL) THEN RETURN false; END IF;
  IF n->>'status' IS DISTINCT FROM 'pending' OR n->>'error' IS NOT NULL THEN
    RAISE EXCEPTION 'Receiving intent-only fields required'; END IF;
  IF relation='message_contents' THEN
    IF operation='INSERT' THEN
      IF n - ARRAY['message_id','status','error','source_mailbox_id','source_uid_validity','source_uid','source_configuration_binding','created_at','updated_at']
        IS DISTINCT FROM jsonb_build_object('plain_text',NULL,'search_text',NULL,'sanitized_html',NULL,'remote_content_blocked',false,'policy_version',NULL,'fetched_at',NULL) THEN
        RAISE EXCEPTION 'Receiving content payload forbidden'; END IF;
    ELSIF o->>'status' NOT IN ('not_fetched','failed') OR
      n-ARRAY['status','error','updated_at','source_mailbox_id','source_uid_validity','source_uid','source_configuration_binding'] IS DISTINCT FROM
      o-ARRAY['status','error','updated_at','source_mailbox_id','source_uid_validity','source_uid','source_configuration_binding'] THEN
      RAISE EXCEPTION 'Receiving content result or in-flight identity forbidden';
    END IF;
  ELSIF relation='message_attachments' THEN
    -- Descriptor creation is still Stage 1 fenced metadata, never web intent.
    IF operation='INSERT' THEN RETURN false; END IF;
    IF o->>'status' NOT IN ('not_fetched','failed') OR
      n-ARRAY['status','error','updated_at'] IS DISTINCT FROM o-ARRAY['status','error','updated_at'] THEN
      RAISE EXCEPTION 'Receiving attachment result or identity forbidden'; END IF;
  ELSE RAISE EXCEPTION 'Unsupported receiving intent'; END IF;
  p := maildock_receiving_intent_source(account,(n->>'source_mailbox_id')::uuid,(n->>'message_id')::uuid);
  IF p.uid_validity IS DISTINCT FROM (n->>'source_uid_validity')::bigint OR
    p.uid IS DISTINCT FROM (n->>'source_uid')::bigint OR
    p.configuration_binding IS DISTINCT FROM (n->>'source_configuration_binding')::bigint THEN
    RAISE EXCEPTION 'Receiving request frozen source mismatch'; END IF;
  PERFORM maildock_receiving_request(account,p.mailbox_id);
  RETURN true;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION maildock_receiving_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_data jsonb; scope uuid; context uuid; account_uuid uuid; previous boolean;
BEGIN
  IF TG_TABLE_NAME IN ('message_contents','message_attachments') AND TG_OP <> 'DELETE' THEN
    IF maildock_receiving_intent_guard(TG_TABLE_NAME,TG_OP,to_jsonb(NEW),CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE NULL END) THEN RETURN NEW; END IF;
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
--> statement-breakpoint
CREATE FUNCTION maildock_receiving_command_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p mailbox_messages%ROWTYPE; b mailboxes%ROWTYPE; dest mailboxes%ROWTYPE;
BEGIN
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
CREATE TRIGGER receiving_command_guard BEFORE INSERT OR UPDATE OR DELETE ON message_commands
FOR EACH ROW EXECUTE FUNCTION maildock_receiving_command_guard();
CREATE UNIQUE INDEX message_commands_active_source_unique ON message_commands(mailbox_id,source_uid_validity,source_uid)
WHERE status IN ('pending','executing') AND source_configuration_binding IS NOT NULL;
--> statement-breakpoint
CREATE FUNCTION maildock_receiving_content_request(account uuid, mailbox uuid, message uuid)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE p mailbox_messages%ROWTYPE; c message_contents%ROWTYPE;
BEGIN
  p:=maildock_receiving_intent_source(account,mailbox,message);
  SELECT * INTO c FROM message_contents WHERE message_id=message FOR UPDATE;
  IF FOUND AND c.status IN ('ready','pending','fetching') THEN
    IF c.status<>'ready' AND ROW(c.source_mailbox_id,c.source_uid_validity,c.source_uid,c.source_configuration_binding)
      IS DISTINCT FROM ROW(mailbox,p.uid_validity,p.uid,p.configuration_binding) THEN
      RAISE EXCEPTION 'Receiving content in-flight source mismatch'; END IF;
    RETURN false;
  END IF;
  IF c.message_id IS NULL THEN
    INSERT INTO message_contents(message_id,status,source_mailbox_id,source_uid_validity,source_uid,source_configuration_binding)
      VALUES(message,'pending',mailbox,p.uid_validity,p.uid,p.configuration_binding);
  ELSE
    UPDATE message_contents SET status='pending',error=NULL,updated_at=clock_timestamp(),source_mailbox_id=mailbox,
      source_uid_validity=p.uid_validity,source_uid=p.uid,source_configuration_binding=p.configuration_binding
      WHERE message_id=message;
  END IF;
  RETURN true;
END $$;
CREATE FUNCTION maildock_receiving_attachment_request(account uuid, attachment uuid)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE c message_attachments%ROWTYPE; p mailbox_messages%ROWTYPE;
BEGIN
  SELECT * INTO STRICT c FROM message_attachments WHERE id=attachment;
  p:=maildock_receiving_intent_source(account,c.source_mailbox_id,c.message_id);
  SELECT * INTO STRICT c FROM message_attachments WHERE id=attachment FOR UPDATE;
  IF NOT maildock_receiving_active_source(account,c.source_mailbox_id,c.message_id,c.source_uid_validity,c.source_uid,c.source_configuration_binding) THEN
    RAISE EXCEPTION 'Receiving attachment frozen source mismatch'; END IF;
  IF c.status IN ('ready','pending','fetching') THEN RETURN false; END IF;
  UPDATE message_attachments SET status='pending',error=NULL,updated_at=clock_timestamp() WHERE id=attachment;
  RETURN true;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION maildock_update_search_body() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' AND NEW.status='pending' AND NEW.search_text IS NULL AND NEW.plain_text IS NULL AND NEW.sanitized_html IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND ROW(NEW.search_text,NEW.plain_text,NEW.sanitized_html) IS NOT DISTINCT FROM ROW(OLD.search_text,OLD.plain_text,OLD.sanitized_html) THEN RETURN NEW; END IF;
  IF TG_OP='DELETE' THEN
    UPDATE messages SET search_body='' WHERE id=OLD.message_id; RETURN OLD;
  END IF;
  UPDATE messages SET search_body=coalesce(NEW.search_text,NEW.plain_text,'') WHERE id=NEW.message_id;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- Read projection only. Canonical flags/MODSEQ/hidden/frontiers are untouched.
CREATE VIEW message_placement_projection AS
SELECT p.id,p.mailbox_id,p.message_id,p.uid_validity,p.uid,p.modseq,
  CASE c.action WHEN 'mark_read' THEN array_append(array_remove(p.flags,E'\\Seen'),E'\\Seen')
    WHEN 'mark_unread' THEN array_remove(p.flags,E'\\Seen')
    WHEN 'flag' THEN array_append(array_remove(p.flags,E'\\Flagged'),E'\\Flagged')
    WHEN 'unflag' THEN array_remove(p.flags,E'\\Flagged') ELSE p.flags END AS flags,
  p.action_hidden OR coalesce(c.action IN ('archive','trash'),false) AS action_hidden,
  p.first_synchronized_at,p.last_synchronized_at,p.created_at,p.updated_at,p.configuration_binding
FROM mailbox_messages p JOIN mailboxes b ON b.id=p.mailbox_id JOIN messages m ON m.id=p.message_id
LEFT JOIN message_commands c ON c.placement_id=p.id AND c.mailbox_id=p.mailbox_id AND c.message_id=p.message_id
  AND c.account_id=m.account_id AND c.source_uid_validity=p.uid_validity AND c.source_uid=p.uid
  AND c.source_configuration_binding=p.configuration_binding AND c.status IN ('pending','executing')
WHERE NOT maildock_receiving_account_enrolled(b.account_id) OR
  maildock_receiving_active_source(b.account_id,b.id,p.message_id,p.uid_validity,p.uid,p.configuration_binding);
--> statement-breakpoint
REVOKE ALL ON FUNCTION maildock_receiving_configuration_version(),maildock_receiving_bind_metadata(),
  maildock_receiving_intent_guard(text,text,jsonb,jsonb),maildock_receiving_command_guard(),
  maildock_receiving_intent_source(uuid,uuid,uuid),maildock_receiving_content_request(uuid,uuid,uuid),
  maildock_receiving_attachment_request(uuid,uuid) FROM PUBLIC;
