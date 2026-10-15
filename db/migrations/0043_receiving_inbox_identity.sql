-- R06 account bootstrap and configuration-bound INBOX publication. No new storage.
CREATE FUNCTION maildock_receiving_account_identity(account uuid, binding bigint, lifecycle bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE a mail_accounts%ROWTYPE;
BEGIN
  SELECT * INTO STRICT a FROM mail_accounts WHERE id=account FOR SHARE;
  IF NOT a.enabled OR a.configuration_version IS DISTINCT FROM binding OR a.receiving_lifecycle_version IS DISTINCT FROM lifecycle THEN
    RAISE EXCEPTION 'Receiving account configuration or lifecycle fenced'; END IF;
  PERFORM set_config('maildock.receiving_configuration',binding::text,true);
  PERFORM set_config('maildock.receiving_lifecycle',lifecycle::text,true);
END $$;
--> statement-breakpoint
CREATE FUNCTION maildock_receiving_bootstrap(actor uuid, term bigint, account uuid, binding bigint, lifecycle bigint,
  mailbox uuid, new_epoch bigint, boundary bigint) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF new_epoch IS NULL OR new_epoch NOT BETWEEN 1 AND 4294967295 OR boundary IS NULL OR boundary NOT BETWEEN 1 AND 4294967296 THEN
    RAISE EXCEPTION 'Invalid bootstrap SELECT evidence'; END IF;
  IF NOT maildock_receiving_validate(actor,term) THEN RAISE EXCEPTION 'Receiving bootstrap owner fenced'; END IF;
  -- Same discovery lock order as the approved account topology capability.
  PERFORM pg_advisory_xact_lock(hashtextextended('mailbox-discovery:'||account::text,0));
  PERFORM 1 FROM mail_accounts WHERE id=account FOR UPDATE;
  PERFORM maildock_receiving_account_identity(account,binding,lifecycle);
  IF EXISTS(SELECT FROM mailboxes WHERE account_id=account AND remote_path='INBOX') OR
    EXISTS(SELECT FROM messages WHERE account_id=account) OR EXISTS(SELECT FROM mailboxes WHERE id=mailbox) THEN
    RAISE EXCEPTION 'Bootstrap identity changed; recover before retry'; END IF;
  INSERT INTO mailboxes(id,account_id,remote_path,name,selectable,first_discovered_at,last_discovered_at,uid_next)
    VALUES(mailbox,account,'INBOX','INBOX',true,clock_timestamp(),clock_timestamp(),boundary);
  PERFORM maildock_receiving_initialize(actor,term,mailbox,new_epoch,boundary);
  -- Account and mailbox demand remain intact; settlement belongs to R15.
END $$;
REVOKE ALL ON FUNCTION maildock_receiving_account_identity(uuid,bigint,bigint),
  maildock_receiving_bootstrap(uuid,bigint,uuid,bigint,bigint,uuid,bigint,bigint) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION maildock_receiving_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF maildock_receiving_bounded_revision(TG_OP,to_jsonb(NEW),to_jsonb(OLD)) THEN IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END IF;
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
  IF TG_OP='UPDATE' AND NEW.configuration_binding<>OLD.configuration_binding AND
    (NEW.configuration_binding IS DISTINCT FROM (SELECT configuration_version FROM mail_accounts WHERE id=(SELECT account_id FROM mailboxes WHERE id=NEW.mailbox_id)) OR
      nullif(current_setting('maildock.receiving_configuration',true),'')::bigint IS DISTINCT FROM NEW.configuration_binding) THEN
    RAISE EXCEPTION 'Receiving configuration replacement fenced'; END IF;
  IF TG_OP='UPDATE' THEN
    IF nullif(current_setting('maildock.receiving_revision',true),'')::bigint IS DISTINCT FROM OLD.revision THEN
      RAISE EXCEPTION 'Receiving expected revision missing';
    END IF;
    IF NEW.epoch=OLD.epoch AND NEW.configuration_binding=OLD.configuration_binding AND (NEW.fresh_through<OLD.fresh_through OR NEW.history_before>OLD.history_before) THEN
      RAISE EXCEPTION 'Receiving coverage cannot regress';
    END IF;
    IF (NEW.epoch<>OLD.epoch OR NEW.configuration_binding<>OLD.configuration_binding) AND (NEW.history_before<>NEW.fresh_through+1 OR NEW.reconcile_after<>0) THEN
      RAISE EXCEPTION 'Receiving epoch reset requires empty coverage';
    END IF;
  END IF;
  IF TG_OP='INSERT' AND (NEW.revision<>0 OR EXISTS(SELECT FROM mailbox_messages WHERE mailbox_id=NEW.mailbox_id)) THEN
    RAISE EXCEPTION 'Receiving enrollment requires an empty new mailbox';
  END IF;
  RETURN NEW;
END $$;


--> statement-breakpoint
CREATE OR REPLACE FUNCTION maildock_receiving_commit_authority() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE lease receiving_coordinator%ROWTYPE; state receiving_mailboxes%ROWTYPE;
  folder mailboxes%ROWTYPE; enabled_account boolean; expected bigint;
BEGIN
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


--> statement-breakpoint
-- Preserve physical facts when a different configuration repeats epoch/UID.
DROP INDEX mailbox_messages_remote_identity_unique;
CREATE UNIQUE INDEX mailbox_messages_remote_identity_unique ON mailbox_messages(mailbox_id,uid_validity,uid,configuration_binding);
