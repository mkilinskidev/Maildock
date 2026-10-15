-- R08: terminal removal is durable on the existing account, never a remote DELETE.
ALTER TABLE mail_accounts ADD COLUMN removal_requested_at timestamptz;
CREATE INDEX mail_accounts_removal_pending_idx ON mail_accounts(id) WHERE removal_requested_at IS NOT NULL;
ALTER TABLE mail_accounts ADD CONSTRAINT mail_accounts_removal_disabled CHECK(removal_requested_at IS NULL OR NOT enabled);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION maildock_receiving_configuration_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.imap_host,NEW.imap_port,NEW.imap_security,NEW.imap_username,NEW.imap_password,NEW.auth_method,NEW.provider_type,NEW.oauth_provider_id,NEW.oauth_home_account_id)
    IS DISTINCT FROM ROW(OLD.imap_host,OLD.imap_port,OLD.imap_security,OLD.imap_username,OLD.imap_password,OLD.auth_method,OLD.provider_type,OLD.oauth_provider_id,OLD.oauth_home_account_id)
    OR NEW.configuration_version=OLD.configuration_version+1 THEN
    NEW.configuration_version:=OLD.configuration_version+1;
  ELSIF NEW.configuration_version IS DISTINCT FROM OLD.configuration_version THEN
    RAISE EXCEPTION 'Receiving configuration version must advance exactly once';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION maildock_receiving_account_demand() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.enabled AND NOT OLD.enabled) OR
    ROW(NEW.imap_host,NEW.imap_port,NEW.imap_security,NEW.imap_username,NEW.imap_password,NEW.auth_method,NEW.provider_type,NEW.oauth_provider_id,NEW.oauth_home_account_id,NEW.configuration_version)
    IS DISTINCT FROM ROW(OLD.imap_host,OLD.imap_port,OLD.imap_security,OLD.imap_username,OLD.imap_password,OLD.auth_method,OLD.provider_type,OLD.oauth_provider_id,OLD.oauth_home_account_id,OLD.configuration_version) THEN
    NEW.receiving_due_at:=least(OLD.receiving_due_at,clock_timestamp());
    NEW.receiving_request_generation:=OLD.receiving_request_generation+1;
  END IF;
  RETURN NEW;
END $$;
-- Demand trigger precedes configuration derivation alphabetically and compares raw fields too.
CREATE OR REPLACE FUNCTION maildock_receiving_lifecycle_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.removal_requested_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Account removal is terminal' USING ERRCODE='55000';
  END IF;
  IF NEW.removal_requested_at IS DISTINCT FROM OLD.removal_requested_at THEN
    IF OLD.removal_requested_at IS NOT NULL OR NEW.removal_requested_at IS NULL OR NEW.enabled OR
      current_setting('maildock.account_removal_start',true) IS DISTINCT FROM OLD.id::text THEN
      RAISE EXCEPTION 'Invalid terminal removal transition';
    END IF;
    NEW.receiving_lifecycle_version:=OLD.receiving_lifecycle_version+1;
  ELSIF NEW.enabled IS DISTINCT FROM OLD.enabled THEN
    NEW.receiving_lifecycle_version:=OLD.receiving_lifecycle_version+1;
  ELSIF NEW.receiving_lifecycle_version IS DISTINCT FROM OLD.receiving_lifecycle_version THEN
    RAISE EXCEPTION 'Receiving lifecycle version is derived';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- Every cleanup mutation has a single exact-row certificate. No general DELETE escape.
CREATE FUNCTION maildock_account_cleanup_write(relation text, operation text, n jsonb, o jsonb)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE scope jsonb; permit jsonb;
BEGIN
  scope:=nullif(current_setting('maildock.account_cleanup_scope',true),'')::jsonb;
  IF scope IS NULL THEN RETURN false; END IF;
  permit:=nullif(current_setting('maildock.account_cleanup_write',true),'')::jsonb;
  IF permit IS NULL OR relation IS DISTINCT FROM permit->>'relation' OR operation IS DISTINCT FROM permit->>'operation'
    OR coalesce(n,'null'::jsonb) IS DISTINCT FROM permit->'new' OR coalesce(o,'null'::jsonb) IS DISTINCT FROM permit->'old' THEN
    RAISE EXCEPTION 'Terminal cleanup exact write fenced';
  END IF;
  RETURN true;
END $$;
CREATE FUNCTION maildock_account_cleanup_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE scope jsonb; a mail_accounts%ROWTYPE;
BEGIN
  scope:=nullif(current_setting('maildock.account_cleanup_scope',true),'')::jsonb;
  IF scope IS NULL THEN RETURN NULL; END IF;
  PERFORM 1 FROM receiving_coordinator WHERE singleton FOR SHARE;
  SELECT * INTO STRICT a FROM mail_accounts WHERE id=(scope->>'account')::uuid FOR UPDATE;
  IF a.enabled OR a.removal_requested_at IS NULL OR a.configuration_version::text IS DISTINCT FROM scope->>'configuration'
    OR a.receiving_lifecycle_version::text IS DISTINCT FROM scope->>'lifecycle'
    OR (scope->>'deadline')::timestamptz IS NULL OR (scope->>'deadline')::timestamptz<=clock_timestamp() THEN
    RAISE EXCEPTION 'Terminal cleanup COMMIT fenced';
  END IF;
  IF scope ? 'mailbox' AND EXISTS(SELECT FROM mailboxes WHERE id=(scope->>'mailbox')::uuid) THEN
    RAISE EXCEPTION 'Cleanup must remove the complete folder identity';
  END IF;
  RETURN NULL;
END $$;
CREATE FUNCTION maildock_account_removing_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE data jsonb; account uuid; a mail_accounts%ROWTYPE;
BEGIN
  IF maildock_account_cleanup_write(TG_TABLE_NAME,TG_OP,to_jsonb(NEW),to_jsonb(OLD)) THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  data:=to_jsonb(NEW);
  IF TG_TABLE_NAME IN ('message_contents','message_attachments') THEN
    SELECT account_id INTO account FROM messages WHERE id=(data->>'message_id')::uuid;
  ELSIF TG_TABLE_NAME IN ('mailbox_messages','receiving_mailboxes') THEN
    SELECT account_id INTO account FROM mailboxes WHERE id=(data->>'mailbox_id')::uuid;
  ELSE account:=(data->>'account_id')::uuid; END IF;
  SELECT * INTO a FROM mail_accounts WHERE id=account FOR SHARE;
  IF a.removal_requested_at IS NOT NULL THEN RAISE EXCEPTION 'Account removal is terminal' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['messages','mailboxes','receiving_mailboxes','mailbox_messages','message_contents','message_attachments',
    'message_commands','mailbox_roles','drafts','outgoing_messages','conversation_members','conversation_references','conversations',
    'notification_events','account_signature_defaults'] LOOP
    EXECUTE format('CREATE TRIGGER aaa_account_removing BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION maildock_account_removing_guard()',relation);
    EXECUTE format('CREATE CONSTRAINT TRIGGER account_cleanup_commit AFTER INSERT OR UPDATE OR DELETE ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION maildock_account_cleanup_commit()',relation);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION maildock_receiving_bounded_write(relation text, operation text, n jsonb, o jsonb)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE scope jsonb; permit jsonb; identity uuid;
BEGIN
  IF maildock_account_cleanup_write(relation,operation,n,o) THEN RETURN true; END IF;
  scope:=nullif(current_setting('maildock.receiving_bounded_scope',true),'')::jsonb;
  IF scope IS NULL THEN RETURN false; END IF;
  IF scope->>'kind'='terminal' THEN
    IF operation<>'DELETE' THEN RAISE EXCEPTION 'Terminal removal cannot publish facts'; END IF;
    IF relation IN ('messages','mailboxes','message_commands','mailbox_roles') THEN identity:=(o->>'account_id')::uuid;
    ELSIF relation IN ('message_contents','message_attachments') THEN identity:=(SELECT account_id FROM messages WHERE id=(o->>'message_id')::uuid);
    ELSIF relation='mailbox_messages' THEN identity:=(SELECT account_id FROM mailboxes WHERE id=(o->>'mailbox_id')::uuid);
    ELSE RAISE EXCEPTION 'Terminal relation forbidden'; END IF;
    IF identity IS DISTINCT FROM (scope->>'account')::uuid THEN RAISE EXCEPTION 'Terminal account identity fenced'; END IF;
    RETURN true;
  END IF;
  permit:=nullif(current_setting('maildock.receiving_bounded_write',true),'')::jsonb;
  IF permit IS NULL OR relation IS DISTINCT FROM permit->>'relation' OR operation IS DISTINCT FROM permit->>'operation' OR
    coalesce(n,'null'::jsonb) IS DISTINCT FROM permit->'new' OR coalesce(o,'null'::jsonb) IS DISTINCT FROM permit->'old' THEN
    RAISE EXCEPTION 'Receiving bounded exact write fenced'; END IF;
  RETURN true;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION maildock_receiving_bounded_revision(operation text, n jsonb, o jsonb) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE scope jsonb; item jsonb;
BEGIN
  IF maildock_account_cleanup_write('receiving_mailboxes',operation,n,o) THEN RETURN true; END IF;
  scope:=nullif(current_setting('maildock.receiving_bounded_scope',true),'')::jsonb;
  IF scope IS NULL THEN RETURN false; END IF;
  SELECT value INTO STRICT item FROM jsonb_array_elements(scope->'scopes') WHERE value->>'mailbox'=coalesce(n->>'mailbox_id',o->>'mailbox_id');
  IF scope->>'kind'='terminal' THEN
    IF operation<>'DELETE' OR maildock_receiving_identity_json(o) IS DISTINCT FROM item->'state' THEN RAISE EXCEPTION 'Terminal state deletion fenced'; END IF;
  ELSIF operation<>'UPDATE' OR (n-'revision') IS DISTINCT FROM (o-'revision') OR maildock_receiving_identity_json(o) IS DISTINCT FROM item->'state' OR
    (n->>'revision')::bigint<>(o->>'revision')::bigint+1 THEN RAISE EXCEPTION 'Bounded revision must advance exactly once'; END IF;
  RETURN true;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION maildock_receiving_bounded_commit() RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE scope jsonb; item jsonb; lease receiving_coordinator%ROWTYPE; a mail_accounts%ROWTYPE;
  b mailboxes%ROWTYPE; s receiving_mailboxes%ROWTYPE; roles jsonb;
BEGIN
  IF nullif(current_setting('maildock.account_cleanup_scope',true),'') IS NOT NULL THEN PERFORM maildock_account_cleanup_validate(); RETURN true; END IF;
  scope:=nullif(current_setting('maildock.receiving_bounded_scope',true),'')::jsonb;
  IF scope IS NULL THEN RETURN false; END IF;
  SELECT * INTO STRICT lease FROM receiving_coordinator WHERE singleton FOR SHARE;
  IF scope->>'kind'='terminal' THEN
    IF EXISTS(SELECT FROM mail_accounts WHERE id=(scope->>'account')::uuid) OR
      EXISTS(SELECT FROM mailboxes WHERE account_id=(scope->>'account')::uuid) OR
      EXISTS(SELECT FROM messages WHERE account_id=(scope->>'account')::uuid) OR
      EXISTS(SELECT FROM receiving_mailboxes WHERE mailbox_id IN (SELECT (x->>'mailbox')::uuid FROM jsonb_array_elements(scope->'scopes') x)) THEN
      RAISE EXCEPTION 'Terminal COMMIT requires complete removed identity'; END IF;
    -- Terminal L: final DB-clock budget comparison under conflicting locks, without requiring a live worker owner.
    IF (scope->>'deadline')::timestamptz IS NULL OR (scope->>'deadline')::timestamptz<=clock_timestamp() THEN
      RAISE EXCEPTION 'Terminal COMMIT transaction budget expired'; END IF;
    RETURN true;
  END IF;
  SELECT * INTO STRICT a FROM mail_accounts WHERE id=(scope->>'account')::uuid FOR SHARE;
  IF NOT a.enabled OR a.configuration_version::text IS DISTINCT FROM scope->>'configuration' OR
    a.receiving_lifecycle_version::text IS DISTINCT FROM scope->>'lifecycle' OR
    lease.owner::text IS DISTINCT FROM scope->>'actor' OR lease.generation::text IS DISTINCT FROM scope->>'generation' THEN
    RAISE EXCEPTION 'Bounded COMMIT account or actor fenced'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(scope->'scopes') ORDER BY (value->>'mailbox')::uuid LOOP
    SELECT * INTO STRICT b FROM mailboxes WHERE id=(item->>'mailbox')::uuid FOR UPDATE;
    SELECT * INTO STRICT s FROM receiving_mailboxes WHERE mailbox_id=b.id FOR UPDATE;
    IF b.account_id IS DISTINCT FROM a.id OR (maildock_receiving_identity_json(to_jsonb(s))-'revision') IS DISTINCT FROM ((item->'state')-'revision') OR
      s.revision<>(item->'state'->>'revision')::bigint+1 OR b.uid_validity IS DISTINCT FROM s.epoch OR
      (scope->>'kind'='data' AND (NOT b.selectable OR b.lifecycle_status<>'active' OR b.remote_path IS DISTINCT FROM item->>'path')) THEN
      RAISE EXCEPTION 'Bounded COMMIT scope fenced'; END IF;
  END LOOP;
  IF scope->>'kind'='topology' THEN
    SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY role),'[]') INTO roles FROM mailbox_roles r WHERE account_id=a.id;
    IF roles IS DISTINCT FROM scope->'roles' THEN RAISE EXCEPTION 'Topology COMMIT role mapping fenced'; END IF;
  END IF;
  -- L is the final DB-clock comparison in the last mandatory deferred event.
  IF lease.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Bounded COMMIT lease expired'; END IF;
  RETURN true;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION maildock_update_search_body() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m jsonb; permit text;
BEGIN
  IF TG_OP='DELETE' AND nullif(current_setting('maildock.account_cleanup_scope',true),'') IS NOT NULL THEN RETURN OLD; END IF;
  IF TG_OP='DELETE' AND nullif(current_setting('maildock.receiving_bounded_scope',true),'')::jsonb->>'kind'='terminal' THEN RETURN OLD; END IF;
  IF TG_OP='INSERT' AND NEW.status='pending' AND NEW.search_text IS NULL AND NEW.plain_text IS NULL AND NEW.sanitized_html IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND ROW(NEW.search_text,NEW.plain_text,NEW.sanitized_html) IS NOT DISTINCT FROM ROW(OLD.search_text,OLD.plain_text,OLD.sanitized_html) THEN RETURN NEW; END IF;
  IF TG_OP='DELETE' THEN UPDATE messages SET search_body='' WHERE id=OLD.message_id; RETURN OLD; END IF;
  IF current_setting('maildock.receiving_content_search',true)=NEW.message_id::text THEN
    IF NEW.status<>'ready' OR NOT maildock_receiving_active_source((SELECT account_id FROM messages WHERE id=NEW.message_id),
      NEW.source_mailbox_id,NEW.message_id,NEW.source_uid_validity,NEW.source_uid,NEW.source_configuration_binding) THEN
      RAISE EXCEPTION 'Obsolete derived content source'; END IF;
    SELECT to_jsonb(r)-'search_vector' INTO STRICT m FROM messages r WHERE id=NEW.message_id FOR UPDATE;
    permit:=current_setting('maildock.receiving_attempt_write',true);
    PERFORM set_config('maildock.receiving_attempt_write',jsonb_build_object('relation','messages','old',m,
      'new',m || jsonb_build_object('search_body',coalesce(NEW.search_text,NEW.plain_text,'')))::text,true);
    UPDATE messages SET search_body=coalesce(NEW.search_text,NEW.plain_text,'') WHERE id=NEW.message_id;
    PERFORM set_config('maildock.receiving_attempt_write',coalesce(permit,''),true);
  ELSE
    UPDATE messages SET search_body=coalesce(NEW.search_text,NEW.plain_text,'') WHERE id=NEW.message_id;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION maildock_account_cleanup_validate() RETURNS void LANGUAGE plpgsql AS $$
DECLARE scope jsonb; a mail_accounts%ROWTYPE;
BEGIN
  scope:=nullif(current_setting('maildock.account_cleanup_scope',true),'')::jsonb;
  SELECT * INTO STRICT a FROM mail_accounts WHERE id=(scope->>'account')::uuid FOR UPDATE;
  IF a.enabled OR a.removal_requested_at IS NULL OR a.configuration_version::text IS DISTINCT FROM scope->>'configuration'
    OR a.receiving_lifecycle_version::text IS DISTINCT FROM scope->>'lifecycle'
    OR (scope->>'deadline')::timestamptz IS NULL OR (scope->>'deadline')::timestamptz<=clock_timestamp()
    OR (scope ? 'mailbox' AND EXISTS(SELECT FROM mailboxes WHERE id=(scope->>'mailbox')::uuid)) THEN
    RAISE EXCEPTION 'Terminal cleanup COMMIT fenced'; END IF;
END $$;
--> statement-breakpoint
-- Bounded probe before using unchanged R04 whole-account removal. Never enumerate a large account.
CREATE FUNCTION maildock_account_removal_small(account uuid) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE amount bigint; bytes bigint;
BEGIN
  IF (SELECT count(*) FROM (SELECT 1 FROM mailboxes WHERE account_id=account LIMIT 129) f)>128 THEN RETURN false; END IF;
  SELECT count(*),coalesce(sum(size),0) INTO amount,bytes FROM (
    SELECT pg_column_size(m) size FROM messages m WHERE account_id=account
    UNION ALL SELECT pg_column_size(p) FROM mailbox_messages p JOIN mailboxes b ON b.id=p.mailbox_id WHERE b.account_id=account
    UNION ALL SELECT pg_column_size(c) FROM message_contents c JOIN messages m ON m.id=c.message_id WHERE m.account_id=account
    UNION ALL SELECT pg_column_size(c) FROM message_attachments c JOIN messages m ON m.id=c.message_id WHERE m.account_id=account
    UNION ALL SELECT pg_column_size(c) FROM message_commands c WHERE c.account_id=account
    UNION ALL SELECT pg_column_size(e) FROM notification_events e WHERE e.account_id=account
    UNION ALL SELECT pg_column_size(c) FROM conversations c WHERE c.account_id=account
    UNION ALL SELECT pg_column_size(c) FROM conversation_members c WHERE c.account_id=account
    UNION ALL SELECT pg_column_size(c) FROM conversation_references c WHERE c.account_id=account
    UNION ALL SELECT pg_column_size(e) FROM application_events e WHERE e.account_id=account OR e.mailbox_id IN (SELECT id FROM mailboxes WHERE account_id=account)
    LIMIT 4097
  ) facts;
  RETURN amount<=4096 AND bytes<=2097152;
END $$;
CREATE FUNCTION maildock_account_remove_start(account uuid) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE a mail_accounts%ROWTYPE;
BEGIN
  PERFORM set_config('statement_timeout','2000',true);
  PERFORM set_config('lock_timeout','1000',true);
  PERFORM 1 FROM receiving_coordinator WHERE singleton FOR SHARE;
  PERFORM pg_advisory_xact_lock(hashtextextended('mailbox-discovery:'||account::text,0));
  SELECT * INTO STRICT a FROM mail_accounts WHERE id=account FOR UPDATE;
  IF EXISTS(SELECT FROM drafts WHERE account_id=account) OR EXISTS(SELECT FROM outgoing_messages WHERE account_id=account) THEN
    RAISE EXCEPTION 'Remove retained drafts and outgoing messages before removing this account' USING ERRCODE='23503'; END IF;
  IF a.removal_requested_at IS NOT NULL THEN RETURN false; END IF;
  IF maildock_account_removal_small(account) THEN
    PERFORM maildock_receiving_terminal_remove(account,a.configuration_version,a.receiving_lifecycle_version);
    RETURN true;
  END IF;
  PERFORM set_config('maildock.account_removal_start',account::text,true);
  UPDATE mail_accounts SET enabled=false,removal_requested_at=clock_timestamp() WHERE id=account;
  RETURN false;
END $$;
--> statement-breakpoint
-- One leaf-table batch per transaction. ctid selection is local to the locked transaction;
-- no offset, cursor ledger, whole-account JSON or Node-side row collection.
CREATE FUNCTION maildock_account_remove_batch(account uuid) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE a mail_accounts%ROWTYPE; folder mailboxes%ROWTYPE; state receiving_mailboxes%ROWTYPE;
  relation text; predicate text; r record; count integer:=0; scope jsonb; new_row jsonb; deadline timestamptz:=clock_timestamp()+interval '2 seconds';
BEGIN
  PERFORM set_config('statement_timeout','2000',true);
  PERFORM set_config('lock_timeout','1000',true);
  PERFORM 1 FROM receiving_coordinator WHERE singleton FOR SHARE;
  PERFORM pg_advisory_xact_lock(hashtextextended('mailbox-discovery:'||account::text,0));
  IF nullif(current_setting('maildock.account_cleanup_scope',true),'') IS NOT NULL OR
    nullif(current_setting('maildock.receiving_bounded_scope',true),'') IS NOT NULL OR
    nullif(current_setting('maildock.receiving_mailbox',true),'') IS NOT NULL THEN RAISE EXCEPTION 'Mixed cleanup transaction forbidden'; END IF;
  SELECT * INTO a FROM mail_accounts WHERE id=account FOR UPDATE;
  IF NOT FOUND THEN RETURN -1; END IF;
  IF a.removal_requested_at IS NULL OR a.enabled THEN RAISE EXCEPTION 'Cleanup requires terminal account'; END IF;
  IF EXISTS(SELECT FROM drafts WHERE account_id=account) OR EXISTS(SELECT FROM outgoing_messages WHERE account_id=account) THEN
    RAISE EXCEPTION 'Retained account dependencies' USING ERRCODE='23503'; END IF;
  scope:=jsonb_build_object('account',account,'configuration',a.configuration_version::text,
    'lifecycle',a.receiving_lifecycle_version::text,'deadline',deadline);
  PERFORM set_config('maildock.account_cleanup_scope',scope::text,true);
  FOREACH relation IN ARRAY ARRAY['message_commands','message_contents','message_attachments','mailbox_messages',
    'conversation_members','conversation_references','notification_events','messages','conversations','application_events','mailbox_roles'] LOOP
    predicate:=CASE
      WHEN relation IN ('message_contents','message_attachments') THEN 'message_id IN (SELECT id FROM messages WHERE account_id=$1)'
      WHEN relation='mailbox_messages' THEN 'mailbox_id IN (SELECT id FROM mailboxes WHERE account_id=$1)'
      WHEN relation='application_events' THEN 'account_id=$1 OR mailbox_id IN (SELECT id FROM mailboxes WHERE account_id=$1)'
      ELSE 'account_id=$1' END;
    -- Clear self-references in bounded batches before deleting any conversations.
    IF relation='conversations' THEN
      FOR r IN SELECT ctid AS tid,to_jsonb(c) AS data FROM conversations c WHERE account_id=account AND merged_into IS NOT NULL LIMIT 32 FOR UPDATE LOOP
        new_row:=jsonb_set(r.data,'{merged_into}','null');
        PERFORM set_config('maildock.account_cleanup_write',jsonb_build_object('relation',relation,'operation','UPDATE','old',r.data,'new',new_row)::text,true);
        UPDATE conversations SET merged_into=NULL WHERE ctid=r.tid; count:=count+1;
      END LOOP;
      IF count>0 THEN RETURN count; END IF;
    END IF;
    FOR r IN EXECUTE format('SELECT ctid AS tid,to_jsonb(t) AS data FROM %I t WHERE %s LIMIT 32 FOR UPDATE',relation,predicate) USING account LOOP
      IF relation='application_events' THEN
        new_row:=r.data || jsonb_build_object('account_id',NULL,'mailbox_id',NULL);
        -- Preserve diagnostics with detached references, as the original FK actions do.
        UPDATE application_events SET account_id=NULL,mailbox_id=NULL WHERE ctid=r.tid;
      ELSE
        PERFORM set_config('maildock.account_cleanup_write',jsonb_build_object('relation',relation,'operation','DELETE','old',r.data,'new','null'::jsonb)::text,true);
        EXECUTE format('DELETE FROM %I WHERE ctid=$1',relation) USING r.tid;
      END IF;
      count:=count+1;
    END LOOP;
    IF count>0 THEN RETURN count; END IF;
  END LOOP;
  -- All data/reference leaves are gone. Remove one complete folder per transaction,
  -- allowing accounts with more than the R04 128-folder atomic budget to finish.
  SELECT * INTO folder FROM mailboxes WHERE account_id=account ORDER BY id LIMIT 1 FOR UPDATE;
  IF FOUND THEN
    SELECT * INTO state FROM receiving_mailboxes WHERE mailbox_id=folder.id FOR UPDATE;
    scope:=scope || jsonb_build_object('mailbox',folder.id);
    PERFORM set_config('maildock.account_cleanup_scope',scope::text,true);
    IF state.mailbox_id IS NOT NULL THEN
      PERFORM set_config('maildock.account_cleanup_write',jsonb_build_object('relation','receiving_mailboxes','operation','DELETE','old',to_jsonb(state),'new','null'::jsonb)::text,true);
      DELETE FROM receiving_mailboxes WHERE mailbox_id=folder.id;
      count:=1;
    END IF;
    PERFORM set_config('maildock.account_cleanup_write',jsonb_build_object('relation','mailboxes','operation','DELETE','old',to_jsonb(folder),'new','null'::jsonb)::text,true);
    DELETE FROM mailboxes WHERE id=folder.id;
    RETURN count+1;
  END IF;
  PERFORM set_config('maildock.account_cleanup_scope','',true);
  PERFORM set_config('maildock.account_cleanup_write','',true);
  PERFORM maildock_receiving_terminal_remove(account,a.configuration_version,a.receiving_lifecycle_version);
  RETURN -1;
END $$;
--> statement-breakpoint
-- Cleanup lookup indexes also bound FK probes at final parent removal.
CREATE INDEX message_contents_cleanup_source_idx ON message_contents(source_mailbox_id);
CREATE INDEX message_attachments_cleanup_source_idx ON message_attachments(source_mailbox_id);
CREATE INDEX application_events_cleanup_mailbox_idx ON application_events(mailbox_id);
CREATE INDEX conversations_cleanup_redirect_idx ON conversations(account_id,id) WHERE merged_into IS NOT NULL;
DO $$ DECLARE fn regprocedure; BEGIN
  FOR fn IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'maildock_account_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn);
  END LOOP;
END $$;

CREATE INDEX drafts_cleanup_account_idx ON drafts(account_id);
CREATE INDEX outgoing_messages_cleanup_account_idx ON outgoing_messages(account_id);
CREATE INDEX notification_events_cleanup_account_idx ON notification_events(account_id,sequence);
CREATE INDEX notification_events_cleanup_message_idx ON notification_events(message_id);
