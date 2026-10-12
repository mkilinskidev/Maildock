-- Disabled Stage 1 state; no v1 cursor conversion and no runtime enrollment.
CREATE TABLE receiving_coordinator (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  owner uuid,
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  expires_at timestamptz NOT NULL DEFAULT '-infinity'
);
INSERT INTO receiving_coordinator(singleton) VALUES(true);
--> statement-breakpoint
CREATE TABLE receiving_mailboxes (
  mailbox_id uuid PRIMARY KEY CONSTRAINT receiving_mailboxes_mailbox_id_mailboxes_id_fk REFERENCES mailboxes(id) ON DELETE RESTRICT,
  epoch bigint NOT NULL CHECK (epoch BETWEEN 1 AND 4294967295),
  revision bigint NOT NULL CHECK (revision >= 0),
  fresh_through bigint NOT NULL CHECK (fresh_through BETWEEN 0 AND 4294967295),
  history_before bigint NOT NULL CHECK (history_before BETWEEN 1 AND 4294967296),
  reconcile_after bigint NOT NULL CHECK (reconcile_after BETWEEN 0 AND 4294967295),
  CHECK (history_before <= fresh_through + 1)
);
--> statement-breakpoint
CREATE FUNCTION maildock_receiving_takeover(actor uuid, ttl_ms integer) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE lease receiving_coordinator%ROWTYPE;
BEGIN
  IF ttl_ms <= 0 OR ttl_ms > 60000 THEN RAISE EXCEPTION 'Invalid receiving lease'; END IF;
  -- Re-read current DB time AFTER obtaining the conflicting lock.
  SELECT * INTO STRICT lease FROM receiving_coordinator WHERE singleton FOR UPDATE;
  IF lease.expires_at > clock_timestamp() THEN RAISE EXCEPTION 'Receiving owner still active'; END IF;
  UPDATE receiving_coordinator SET owner=actor, generation=generation+1,
    expires_at=clock_timestamp()+ttl_ms*interval '1 millisecond' WHERE singleton
    RETURNING generation INTO lease.generation;
  RETURN lease.generation;
END $$;
--> statement-breakpoint
CREATE FUNCTION maildock_receiving_lock(actor uuid, term bigint, mailbox uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE lease receiving_coordinator%ROWTYPE; folder mailboxes%ROWTYPE; enabled_account boolean; account_identity uuid;
BEGIN
  -- Single mailbox per Stage 1 transaction. Reject changing scope, not silently
  -- locking a second mailbox in an inconsistent order.
  IF nullif(current_setting('maildock.receiving_mailbox', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'Receiving scope already claimed';
  END IF;
  SELECT * INTO STRICT lease FROM receiving_coordinator WHERE singleton FOR SHARE;
  IF lease.owner IS DISTINCT FROM actor OR lease.generation <> term OR lease.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'Receiving owner fenced';
  END IF;
  SELECT a.id,a.enabled INTO STRICT account_identity,enabled_account FROM mail_accounts a JOIN mailboxes m ON m.account_id=a.id
    WHERE m.id=mailbox FOR SHARE OF a;
  SELECT * INTO STRICT folder FROM mailboxes WHERE id=mailbox FOR UPDATE;
  IF folder.account_id<>account_identity OR NOT enabled_account OR NOT folder.selectable OR folder.lifecycle_status <> 'active' THEN
    RAISE EXCEPTION 'Receiving lifecycle fenced';
  END IF;
  PERFORM set_config('maildock.receiving_owner', actor::text, true);
  PERFORM set_config('maildock.receiving_generation', term::text, true);
  PERFORM set_config('maildock.receiving_mailbox', mailbox::text, true);
END $$;
--> statement-breakpoint
CREATE FUNCTION maildock_receiving_claim(actor uuid, term bigint, mailbox uuid,
  expected_epoch bigint, expected_revision bigint, expected_f bigint, expected_e bigint, expected_r bigint)
RETURNS receiving_mailboxes LANGUAGE plpgsql AS $$
DECLARE state receiving_mailboxes%ROWTYPE;
BEGIN
  PERFORM maildock_receiving_lock(actor,term,mailbox);
  SELECT * INTO STRICT state FROM receiving_mailboxes WHERE mailbox_id=mailbox FOR UPDATE;
  IF state.epoch <> expected_epoch OR state.revision <> expected_revision OR state.fresh_through <> expected_f
    OR state.history_before <> expected_e OR state.reconcile_after <> expected_r
    OR (SELECT uid_validity FROM mailboxes WHERE id=mailbox) IS DISTINCT FROM expected_epoch THEN
    RAISE EXCEPTION 'Receiving epoch revision progress fenced';
  END IF;
  PERFORM set_config('maildock.receiving_revision', state.revision::text, true);
  RETURN state;
END $$;
--> statement-breakpoint
CREATE FUNCTION maildock_receiving_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
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
CREATE TRIGGER receiving_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON receiving_mailboxes
FOR EACH ROW EXECUTE FUNCTION maildock_receiving_revision_guard();
--> statement-breakpoint
CREATE FUNCTION maildock_receiving_commit_authority() RETURNS trigger LANGUAGE plpgsql AS $$
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
  -- L is this final clock comparison in the last mandatory deferred invocation.
  -- The SHARE lock conflicts with takeover until transaction end, including after L.
  IF lease.expires_at <= clock_timestamp() THEN RAISE EXCEPTION 'Receiving COMMIT lease expired'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER receiving_commit_authority AFTER INSERT OR UPDATE ON receiving_mailboxes
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION maildock_receiving_commit_authority();
--> statement-breakpoint
REVOKE ALL ON receiving_coordinator, receiving_mailboxes FROM PUBLIC;
REVOKE ALL ON FUNCTION maildock_receiving_takeover(uuid,integer), maildock_receiving_lock(uuid,bigint,uuid),
  maildock_receiving_claim(uuid,bigint,uuid,bigint,bigint,bigint,bigint,bigint),
  maildock_receiving_revision_guard(), maildock_receiving_commit_authority() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION maildock_receiving_initialize(actor uuid, term bigint, mailbox uuid, new_epoch bigint, boundary bigint)
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
  INSERT INTO receiving_mailboxes VALUES(mailbox,new_epoch,0,boundary-1,boundary,0);
END $$;
CREATE FUNCTION maildock_receiving_recover(actor uuid, term bigint, mailbox uuid)
RETURNS receiving_mailboxes LANGUAGE plpgsql AS $$
DECLARE state receiving_mailboxes%ROWTYPE;
BEGIN
  PERFORM maildock_receiving_lock(actor,term,mailbox);
  -- This conflicts with ALL authoritative writers, including an old live backend.
  -- An unlocked snapshot or a SHARE lease alone is not a recovery observation.
  SELECT * INTO STRICT state FROM receiving_mailboxes WHERE mailbox_id=mailbox FOR UPDATE;
  RETURN state;
END $$;
REVOKE ALL ON FUNCTION maildock_receiving_initialize(uuid,bigint,uuid,bigint,bigint),
  maildock_receiving_recover(uuid,bigint,uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION maildock_receiving_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_data jsonb; scope uuid; context uuid; account_uuid uuid; previous boolean;
BEGIN
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
-- Insert publication events are authoritative; local event retention remains
-- compatible with NotificationService.consume(), without a receiving turn.
CREATE TRIGGER receiving_notification_guard BEFORE INSERT OR UPDATE ON notification_events
FOR EACH ROW EXECUTE FUNCTION maildock_receiving_write_guard();
CREATE CONSTRAINT TRIGGER receiving_notification_authority AFTER INSERT OR UPDATE ON notification_events
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION maildock_receiving_commit_authority();
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['messages','mailbox_messages','message_attachments','mailboxes','message_contents'] LOOP
    EXECUTE format('CREATE TRIGGER receiving_write_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION maildock_receiving_write_guard()',relation);
    EXECUTE format('CREATE CONSTRAINT TRIGGER receiving_write_authority AFTER INSERT OR UPDATE OR DELETE ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION maildock_receiving_commit_authority()',relation);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION maildock_receiving_write_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE VIEW receiving_current_placements AS SELECT p.* FROM mailbox_messages p
JOIN receiving_mailboxes s ON s.mailbox_id=p.mailbox_id AND s.epoch=p.uid_validity;
--> statement-breakpoint
CREATE FUNCTION maildock_receiving_generation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Receiving generation cannot reset'; END IF;
  IF NEW.singleton IS DISTINCT FROM OLD.singleton OR NEW.generation<OLD.generation OR NEW.generation>OLD.generation+1
    OR (NEW.owner IS DISTINCT FROM OLD.owner AND NEW.generation<>OLD.generation+1)
    OR (NEW.generation>OLD.generation AND OLD.expires_at>clock_timestamp())
    OR (NEW.generation=OLD.generation AND NEW.expires_at>OLD.expires_at AND OLD.expires_at<=clock_timestamp()) THEN
    RAISE EXCEPTION 'Receiving generation transition fenced';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER receiving_generation_guard BEFORE UPDATE OR DELETE ON receiving_coordinator
FOR EACH ROW EXECUTE FUNCTION maildock_receiving_generation_guard();
REVOKE ALL ON FUNCTION maildock_receiving_generation_guard() FROM PUBLIC;
