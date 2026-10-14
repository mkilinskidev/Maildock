-- R04-C: separate bounded data, topology and whole-account terminal capabilities.
ALTER TABLE outgoing_messages ADD COLUMN receiving_attempt jsonb;
CREATE FUNCTION maildock_receiving_identity_json(row_data jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_object_agg(key,CASE WHEN jsonb_typeof(value)='number' THEN to_jsonb(value::text) ELSE value END) FROM jsonb_each(row_data)
$$;
--> statement-breakpoint
CREATE FUNCTION maildock_receiving_bounded_write(relation text, operation text, n jsonb, o jsonb)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE scope jsonb; permit jsonb; identity uuid;
BEGIN
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
CREATE FUNCTION maildock_receiving_destination_flags(evidence jsonb) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF jsonb_typeof(evidence->'flags') IS DISTINCT FROM 'array' OR jsonb_array_length(evidence->'flags')>128 OR
    NOT evidence ? 'modseq' OR jsonb_typeof(evidence->'modseq') NOT IN ('number','string','null') OR (evidence->>'modseq')::bigint<0 OR
    EXISTS(SELECT FROM jsonb_array_elements(evidence->'flags') f WHERE jsonb_typeof(f)<>'string' OR octet_length(f::text)>256) OR
    (SELECT count(DISTINCT f) FROM jsonb_array_elements(evidence->'flags') f)<>jsonb_array_length(evidence->'flags') THEN
    RAISE EXCEPTION 'Invalid evidenced destination flags'; END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION maildock_receiving_terminal_remove(account uuid, binding bigint, lifecycle bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE a mail_accounts%ROWTYPE; scopes jsonb; amount bigint; bytes bigint; terminal_deadline timestamptz:=clock_timestamp()+interval '2 seconds';
BEGIN
  IF account IS NULL OR binding IS NULL OR lifecycle IS NULL OR
    nullif(current_setting('maildock.receiving_mailbox',true),'') IS NOT NULL OR
    nullif(current_setting('maildock.receiving_bounded_scope',true),'') IS NOT NULL THEN RAISE EXCEPTION 'Invalid terminal account scope'; END IF;
  PERFORM 1 FROM receiving_coordinator WHERE singleton FOR SHARE;
  PERFORM pg_advisory_xact_lock(hashtextextended('mailbox-discovery:'||account::text,0));
  SELECT * INTO STRICT a FROM mail_accounts WHERE id=account FOR UPDATE;
  IF a.configuration_version IS DISTINCT FROM binding OR a.receiving_lifecycle_version IS DISTINCT FROM lifecycle OR
    (SELECT count(*) FROM mailboxes WHERE account_id=account)>128 OR
    EXISTS(SELECT FROM drafts WHERE account_id=account) OR EXISTS(SELECT FROM outgoing_messages WHERE account_id=account) THEN
    RAISE EXCEPTION 'Terminal identity bound or retained dependency fenced'; END IF;
  PERFORM 1 FROM mailboxes WHERE account_id=account ORDER BY id FOR UPDATE;
  PERFORM 1 FROM receiving_mailboxes WHERE mailbox_id IN (SELECT id FROM mailboxes WHERE account_id=account) ORDER BY mailbox_id FOR UPDATE;
  SELECT coalesce(jsonb_agg(jsonb_build_object('mailbox',s.mailbox_id,'path',b.remote_path,'state',maildock_receiving_identity_json(to_jsonb(s))) ORDER BY s.mailbox_id),'[]')
    INTO scopes FROM receiving_mailboxes s JOIN mailboxes b ON b.id=s.mailbox_id WHERE b.account_id=account;
  -- Conservative terminal bound, in addition to the executor's unchanged transaction deadline.
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
  ) facts;
  IF amount>4096 OR bytes>2097152 THEN RAISE EXCEPTION 'Terminal transaction bound exceeded'; END IF;
  PERFORM set_config('maildock.receiving_bounded_scope',jsonb_build_object('kind','terminal','account',account,
    'configuration',binding::text,'lifecycle',lifecycle::text,'scopes',scopes,'deadline',terminal_deadline)::text,true);
  DELETE FROM message_commands WHERE account_id=account;
  DELETE FROM message_contents WHERE message_id IN (SELECT id FROM messages WHERE account_id=account);
  DELETE FROM message_attachments WHERE message_id IN (SELECT id FROM messages WHERE account_id=account);
  DELETE FROM mailbox_messages WHERE mailbox_id IN (SELECT id FROM mailboxes WHERE account_id=account);
  DELETE FROM messages WHERE account_id=account;
  DELETE FROM receiving_mailboxes WHERE mailbox_id IN (SELECT id FROM mailboxes WHERE account_id=account);
  DELETE FROM mailboxes WHERE account_id=account;
  DELETE FROM mail_accounts WHERE id=account;
END $$;
CREATE FUNCTION maildock_receiving_bounded_revision(operation text, n jsonb, o jsonb) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE scope jsonb; item jsonb;
BEGIN
  scope:=nullif(current_setting('maildock.receiving_bounded_scope',true),'')::jsonb;
  IF scope IS NULL THEN RETURN false; END IF;
  SELECT value INTO STRICT item FROM jsonb_array_elements(scope->'scopes') WHERE value->>'mailbox'=coalesce(n->>'mailbox_id',o->>'mailbox_id');
  IF scope->>'kind'='terminal' THEN
    IF operation<>'DELETE' OR maildock_receiving_identity_json(o) IS DISTINCT FROM item->'state' THEN RAISE EXCEPTION 'Terminal state deletion fenced'; END IF;
  ELSIF operation<>'UPDATE' OR (n-'revision') IS DISTINCT FROM (o-'revision') OR maildock_receiving_identity_json(o) IS DISTINCT FROM item->'state' OR
    (n->>'revision')::bigint<>(o->>'revision')::bigint+1 THEN RAISE EXCEPTION 'Bounded revision must advance exactly once'; END IF;
  RETURN true;
END $$;
CREATE FUNCTION maildock_receiving_bounded_commit() RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE scope jsonb; item jsonb; lease receiving_coordinator%ROWTYPE; a mail_accounts%ROWTYPE;
  b mailboxes%ROWTYPE; s receiving_mailboxes%ROWTYPE; roles jsonb;
BEGIN
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
CREATE FUNCTION maildock_receiving_roles_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF nullif(current_setting('maildock.receiving_bounded_scope',true),'') IS NOT NULL THEN
    PERFORM maildock_receiving_bounded_write(TG_TABLE_NAME,TG_OP,to_jsonb(NEW),to_jsonb(OLD));
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER receiving_roles_guard BEFORE INSERT OR UPDATE OR DELETE ON mailbox_roles FOR EACH ROW EXECUTE FUNCTION maildock_receiving_roles_guard();
CREATE CONSTRAINT TRIGGER receiving_roles_authority AFTER INSERT OR UPDATE OR DELETE ON mailbox_roles DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION maildock_receiving_commit_authority();
CREATE CONSTRAINT TRIGGER receiving_terminal_state_authority AFTER DELETE ON receiving_mailboxes DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION maildock_receiving_commit_authority();
CREATE CONSTRAINT TRIGGER receiving_terminal_account_authority AFTER DELETE ON mail_accounts DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION maildock_receiving_commit_authority();
--> statement-breakpoint
CREATE FUNCTION maildock_receiving_append_claim(actor uuid, term bigint, account uuid, binding bigint, lifecycle bigint,
  scopes jsonb, intent uuid, attempt uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE scope jsonb; r outgoing_messages%ROWTYPE; n outgoing_messages%ROWTYPE; marker jsonb;
BEGIN
  scope:=maildock_receiving_data_scope(actor,term,account,binding,lifecycle,scopes);
  SELECT * INTO STRICT r FROM outgoing_messages WHERE id=intent FOR UPDATE;
  IF attempt IS NULL OR jsonb_array_length(scopes)<>1 OR r.account_id IS DISTINCT FROM account OR r.status<>'sent' OR
    r.sent_copy_policy<>'maildock' OR r.sent_copy_status<>'pending' OR
    r.receiving_attempt->>'id'=attempt::text OR r.sent_copy_uid IS NOT NULL OR r.sent_copy_uid_validity IS NOT NULL OR
    NOT EXISTS(SELECT FROM jsonb_array_elements(scopes) x WHERE x->>'mailbox'=r.sent_copy_mailbox_id::text AND x->>'path'=r.sent_copy_path) THEN
    RAISE EXCEPTION 'Receiving APPEND claim fenced'; END IF;
  marker:=scope || jsonb_build_object('id',attempt,'phase','claimed','operation','append','destination',r.sent_copy_mailbox_id,
    'messageId',r.message_id,'mimeBlob',r.mime_blob_id,'mimeSha256',encode(sha256(convert_to(r.mime_base64,'UTF8')),'hex'));
  n:=r; n.receiving_attempt:=marker; n.sent_copy_status:='saving'; n.sent_copy_error:=NULL;
  n.sent_copy_started_at:=clock_timestamp(); n.updated_at:=clock_timestamp();
  PERFORM maildock_receiving_bounded_permit('outgoing_messages','UPDATE',to_jsonb(n),to_jsonb(r));
  UPDATE outgoing_messages SET receiving_attempt=n.receiving_attempt,sent_copy_status=n.sent_copy_status,sent_copy_error=n.sent_copy_error,
    sent_copy_started_at=n.sent_copy_started_at,updated_at=n.updated_at WHERE id=intent;
  PERFORM maildock_receiving_bounded_advance(); RETURN marker;
END $$;
CREATE FUNCTION maildock_receiving_append_result(actor uuid, term bigint, account uuid, binding bigint, lifecycle bigint,
  scopes jsonb, intent uuid, attempt uuid, evidence jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE scope jsonb; r outgoing_messages%ROWTYPE; n outgoing_messages%ROWTYPE; marker jsonb; dest mailbox_messages%ROWTYPE; existing_dest mailbox_messages%ROWTYPE;
  m messages%ROWTYPE; uid bigint; epoch bigint;
BEGIN
  scope:=maildock_receiving_data_scope(actor,term,account,binding,lifecycle,scopes);
  SELECT * INTO STRICT r FROM outgoing_messages WHERE id=intent FOR UPDATE; marker:=r.receiving_attempt;
  IF attempt IS NULL OR marker->>'id' IS DISTINCT FROM attempt::text OR marker->>'actor' IS DISTINCT FROM actor::text OR
    marker->>'generation' IS DISTINCT FROM term::text OR marker->>'operation' IS DISTINCT FROM 'append' OR
    NOT ((marker->>'phase'='claimed' AND r.sent_copy_status='saving') OR (marker->>'phase'='awaiting_metadata' AND r.sent_copy_status='saved' AND r.sent_copy_sync_pending)) OR
    r.status<>'sent' OR r.sent_copy_policy<>'maildock' OR marker->>'account' IS DISTINCT FROM account::text OR marker->>'configuration' IS DISTINCT FROM binding::text OR
    marker->>'lifecycle' IS DISTINCT FROM lifecycle::text OR jsonb_array_length(scopes)<>1 OR
    marker->>'destination' IS DISTINCT FROM r.sent_copy_mailbox_id::text OR marker->>'messageId' IS DISTINCT FROM r.message_id OR
    marker->'mimeBlob' IS DISTINCT FROM coalesce(to_jsonb(r.mime_blob_id),'null'::jsonb) OR
    marker->>'mimeSha256' IS DISTINCT FROM encode(sha256(convert_to(r.mime_base64,'UTF8')),'hex') OR
    NOT EXISTS(SELECT FROM jsonb_array_elements(scopes) x WHERE x->>'mailbox'=r.sent_copy_mailbox_id::text AND x->>'path'=r.sent_copy_path) OR
    marker->'scopes'->0->'state'->>'epoch' IS DISTINCT FROM scope->'scopes'->0->'state'->>'epoch' THEN
    RAISE EXCEPTION 'Receiving APPEND result attempt fenced'; END IF;
  IF evidence IS NULL OR evidence - ARRAY['kind','complete','taggedOk','destinationEpoch','destinationUid','message','flags','modseq'] <> '{}'::jsonb OR
    evidence->'complete' IS DISTINCT FROM 'true'::jsonb OR evidence->'taggedOk' IS DISTINCT FROM 'true'::jsonb OR
    evidence->>'kind' IS DISTINCT FROM (CASE marker->>'phase' WHEN 'claimed' THEN 'append' ELSE 'lookup' END) OR
    octet_length(evidence::text)>65536 THEN RAISE EXCEPTION 'Invalid APPEND evidence'; END IF;
  PERFORM maildock_receiving_destination_flags(evidence);
  uid:=(evidence->>'destinationUid')::bigint; epoch:=(evidence->>'destinationEpoch')::bigint;
  n:=r; n.updated_at:=clock_timestamp();
  IF uid IS NULL THEN
    IF marker->>'phase'<>'claimed' OR epoch IS NOT NULL OR evidence->>'message' IS NOT NULL THEN RAISE EXCEPTION 'Partial APPEND mapping'; END IF;
    n.sent_copy_status:='uncertain'; n.sent_copy_error:='uncertain_remote_execution';
    n.receiving_attempt:=marker || jsonb_build_object('phase','uncertain_remote_execution');
    PERFORM maildock_receiving_request(account,r.sent_copy_mailbox_id);
  ELSE
    IF uid NOT BETWEEN 1 AND 4294967295 OR epoch IS DISTINCT FROM (SELECT s.epoch FROM receiving_mailboxes s WHERE mailbox_id=r.sent_copy_mailbox_id) THEN
      RAISE EXCEPTION 'Invalid known APPEND destination'; END IF;
    IF marker->>'phase'='awaiting_metadata' AND (uid IS DISTINCT FROM r.sent_copy_uid OR epoch IS DISTINCT FROM r.sent_copy_uid_validity) THEN
      RAISE EXCEPTION 'APPEND lookup cannot replace a saved mapping'; END IF;
    n.sent_copy_status:='saved'; n.sent_copy_error:=NULL; n.sent_copy_uid:=uid; n.sent_copy_uid_validity:=epoch;
    n.sent_copy_saved_at:=coalesce(r.sent_copy_saved_at,clock_timestamp());
    IF evidence->>'message' IS NULL THEN
      IF marker->>'phase'<>'claimed' THEN RAISE EXCEPTION 'Incomplete APPEND metadata lookup'; END IF;
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
CREATE FUNCTION maildock_receiving_terminal_recover(account uuid, binding bigint, lifecycle bigint) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE a mail_accounts%ROWTYPE;
BEGIN
  IF account IS NULL OR binding IS NULL OR lifecycle IS NULL THEN RAISE EXCEPTION 'Invalid terminal recovery identity'; END IF;
  PERFORM 1 FROM receiving_coordinator WHERE singleton FOR SHARE;
  PERFORM pg_advisory_xact_lock(hashtextextended('mailbox-discovery:'||account::text,0));
  SELECT * INTO a FROM mail_accounts WHERE id=account FOR UPDATE;
  IF FOUND THEN
    IF a.configuration_version IS DISTINCT FROM binding OR a.receiving_lifecycle_version IS DISTINCT FROM lifecycle THEN
      RAISE EXCEPTION 'Terminal recovery identity changed'; END IF;
    RETURN false;
  END IF;
  IF EXISTS(SELECT FROM mailboxes WHERE account_id=account) OR EXISTS(SELECT FROM messages WHERE account_id=account) THEN
    RAISE EXCEPTION 'Terminal recovery found partial identity'; END IF;
  RETURN true;
END $$;
CREATE FUNCTION maildock_receiving_outgoing_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF maildock_receiving_bounded_write(TG_TABLE_NAME,TG_OP,to_jsonb(NEW),to_jsonb(OLD)) THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.receiving_attempt IS NOT NULL OR (maildock_receiving_account_enrolled(NEW.account_id) AND
      (NEW.sent_copy_status NOT IN ('not_required','pending') OR NEW.sent_copy_uid IS NOT NULL OR NEW.sent_copy_uid_validity IS NOT NULL OR
       NEW.sent_copy_started_at IS NOT NULL OR NEW.sent_copy_saved_at IS NOT NULL OR NEW.sent_copy_sync_pending)) THEN
      RAISE EXCEPTION 'Receiving sent-copy insert is intent-only'; END IF;
    RETURN NEW;
  END IF;
  IF (maildock_receiving_account_enrolled(OLD.account_id) OR maildock_receiving_account_enrolled(NEW.account_id)) AND
    (OLD.receiving_attempt IS NOT NULL OR OLD.sent_copy_status IN ('saving','saved','uncertain')) AND
    (to_jsonb(NEW)-ARRAY['status','attempts','error','accepted_count','rejected_count','next_attempt_at','started_at','smtp_accepted_at','updated_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['status','attempts','error','accepted_count','rejected_count','next_attempt_at','started_at','smtp_accepted_at','updated_at']) THEN
    RAISE EXCEPTION 'Receiving claimed sent-copy facts are owner-controlled'; END IF;
  IF NEW.receiving_attempt IS DISTINCT FROM OLD.receiving_attempt OR
    (maildock_receiving_account_enrolled(NEW.account_id) AND
      ((to_jsonb(NEW)-ARRAY['status','attempts','error','accepted_count','rejected_count','next_attempt_at','started_at','smtp_accepted_at','updated_at']) IS DISTINCT FROM
       (to_jsonb(OLD)-ARRAY['status','attempts','error','accepted_count','rejected_count','next_attempt_at','started_at','smtp_accepted_at','updated_at']) AND
       NEW.sent_copy_status NOT IN ('pending','not_required'))) THEN
    RAISE EXCEPTION 'Receiving sent-copy authority fenced'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER receiving_outgoing_guard BEFORE INSERT OR UPDATE ON outgoing_messages FOR EACH ROW EXECUTE FUNCTION maildock_receiving_outgoing_guard();
CREATE CONSTRAINT TRIGGER receiving_outgoing_authority AFTER UPDATE ON outgoing_messages DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION maildock_receiving_commit_authority();
--> statement-breakpoint
CREATE FUNCTION maildock_receiving_topology_capture(actor uuid, term bigint, account uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE lease receiving_coordinator%ROWTYPE; a mail_accounts%ROWTYPE; captured jsonb; folders jsonb; states jsonb; roles jsonb;
BEGIN
  IF nullif(current_setting('maildock.receiving_mailbox',true),'') IS NOT NULL OR
    nullif(current_setting('maildock.receiving_bounded_scope',true),'') IS NOT NULL THEN RAISE EXCEPTION 'Topology scope already claimed'; END IF;
  SELECT * INTO STRICT lease FROM receiving_coordinator WHERE singleton FOR SHARE;
  IF actor IS NULL OR term IS NULL OR lease.owner IS DISTINCT FROM actor OR lease.generation IS DISTINCT FROM term OR lease.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'Topology owner fenced'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('mailbox-discovery:'||account::text,0));
  SELECT * INTO STRICT a FROM mail_accounts WHERE id=account FOR UPDATE;
  IF NOT a.enabled OR (SELECT count(*) FROM mailboxes WHERE account_id=account)>128 THEN RAISE EXCEPTION 'Topology account or bound fenced'; END IF;
  PERFORM 1 FROM mailboxes WHERE account_id=account ORDER BY id FOR UPDATE;
  PERFORM 1 FROM receiving_mailboxes WHERE mailbox_id IN (SELECT id FROM mailboxes WHERE account_id=account) ORDER BY mailbox_id FOR UPDATE;
  PERFORM 1 FROM mailbox_roles WHERE account_id=account ORDER BY role FOR UPDATE;
  SELECT coalesce(jsonb_agg(maildock_receiving_identity_json(to_jsonb(b))-ARRAY['receiving_due_at','receiving_request_generation'] ORDER BY id),'[]') INTO folders FROM mailboxes b WHERE account_id=account;
  SELECT coalesce(jsonb_agg(maildock_receiving_identity_json(to_jsonb(s)) ORDER BY mailbox_id),'[]') INTO states FROM receiving_mailboxes s WHERE mailbox_id IN (SELECT id FROM mailboxes WHERE account_id=account);
  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY role),'[]') INTO roles FROM mailbox_roles r WHERE account_id=account;
  captured:=jsonb_build_object('account',account,'configuration',a.configuration_version::text,'lifecycle',a.receiving_lifecycle_version::text,
    'mailboxes',folders,'states',states,'roles',roles);
  IF octet_length(captured::text)>2097152 THEN RAISE EXCEPTION 'Topology captured identity overflow'; END IF;
  RETURN captured;
END $$;
CREATE FUNCTION maildock_receiving_topology_result(actor uuid, term bigint, account uuid, expected jsonb, evidence jsonb)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE captured jsonb; scope jsonb; item jsonb; r mailboxes%ROWTYPE; n mailboxes%ROWTYPE; observed boolean; role_name text;
  old_role mailbox_roles%ROWTYPE; new_role mailbox_roles%ROWTYPE; matches uuid[]; scopes jsonb; final_roles jsonb;
BEGIN
  IF evidence IS NULL OR jsonb_typeof(evidence) IS DISTINCT FROM 'object' OR octet_length(evidence::text)>2097152 OR
    evidence - ARRAY['complete','taggedOk','namespace','subscribedOnly','requestId','completedRequestId','entries'] <> '{}'::jsonb OR
    evidence->'complete' IS DISTINCT FROM 'true'::jsonb OR evidence->'taggedOk' IS DISTINCT FROM 'true'::jsonb OR
    evidence->>'namespace' IS DISTINCT FROM '*' OR evidence->'subscribedOnly' IS DISTINCT FROM 'false'::jsonb OR
    evidence->>'requestId' IS NULL OR (evidence->>'requestId')::uuid IS DISTINCT FROM (evidence->>'completedRequestId')::uuid OR
    jsonb_typeof(evidence->'entries') IS DISTINCT FROM 'array' OR jsonb_array_length(evidence->'entries')>128 OR
    (SELECT count(DISTINCT x->>'id') FROM jsonb_array_elements(evidence->'entries') x)<>jsonb_array_length(evidence->'entries') OR
    (SELECT count(DISTINCT CASE WHEN lower(x->>'path')='inbox' THEN 'INBOX' ELSE x->>'path' END) FROM jsonb_array_elements(evidence->'entries') x)<>jsonb_array_length(evidence->'entries') THEN
    RAISE EXCEPTION 'Invalid complete topology evidence'; END IF;
  captured:=maildock_receiving_topology_capture(actor,term,account);
  IF captured IS DISTINCT FROM expected OR
    (SELECT count(*) FROM (SELECT id FROM mailboxes WHERE account_id=account UNION SELECT (x->>'id')::uuid FROM jsonb_array_elements(evidence->'entries') x) affected)>128 THEN
    RAISE EXCEPTION 'Topology captured identity or union bound fenced'; END IF;
  IF EXISTS(SELECT FROM jsonb_array_elements(evidence->'entries') x JOIN mailboxes b ON b.id=(x->>'id')::uuid WHERE b.account_id<>account) THEN
    RAISE EXCEPTION 'Topology cross-account identity'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('mailbox',s.mailbox_id,'path',b.remote_path,'state',maildock_receiving_identity_json(to_jsonb(s))) ORDER BY s.mailbox_id),'[]')
    INTO scopes FROM receiving_mailboxes s JOIN mailboxes b ON b.id=s.mailbox_id WHERE b.account_id=account;
  scope:=jsonb_build_object('kind','topology','actor',actor,'generation',term::text,'account',account,
    'configuration',captured->>'configuration','lifecycle',captured->>'lifecycle','scopes',scopes);
  PERFORM set_config('maildock.receiving_bounded_scope',scope::text,true);
  -- All observed fields are topology only. LIST STATUS never changes enrolled identity or remote cache facts.
  FOR item IN SELECT value FROM jsonb_array_elements(evidence->'entries') ORDER BY (value->>'id')::uuid LOOP
    IF item - ARRAY['id','path','name','delimiter','attributes','specialUse','selectable','subscribed','providerMailboxId'] <> '{}'::jsonb OR
      jsonb_typeof(item->'path') IS DISTINCT FROM 'string' OR jsonb_typeof(item->'name') IS DISTINCT FROM 'string' OR
      nullif(item->>'path','') IS NULL OR octet_length(item->>'path')>4096 OR nullif(item->>'name','') IS NULL OR
      jsonb_typeof(item->'selectable') IS DISTINCT FROM 'boolean' OR jsonb_typeof(item->'attributes') IS DISTINCT FROM 'array' OR
      jsonb_typeof(item->'specialUse') IS DISTINCT FROM 'array' OR jsonb_array_length(item->'attributes')>128 OR jsonb_array_length(item->'specialUse')>128 OR
      EXISTS(SELECT FROM jsonb_array_elements(item->'attributes'||item->'specialUse') x WHERE jsonb_typeof(x)<>'string' OR octet_length(x::text)>256) OR
      NOT item ?& ARRAY['delimiter','subscribed','providerMailboxId'] OR jsonb_typeof(item->'subscribed') NOT IN ('boolean','null') OR
      jsonb_typeof(item->'delimiter') NOT IN ('string','null') OR jsonb_typeof(item->'providerMailboxId') NOT IN ('string','null') THEN
      RAISE EXCEPTION 'Invalid normalized topology entry'; END IF;
    SELECT * INTO r FROM mailboxes WHERE id=(item->>'id')::uuid;
    observed:=FOUND;
    IF observed THEN
      IF (r.provider_mailbox_id IS NOT NULL AND r.provider_mailbox_id IS DISTINCT FROM item->>'providerMailboxId') OR
        (r.provider_mailbox_id IS NULL AND r.remote_path IS DISTINCT FROM item->>'path') THEN
        RAISE EXCEPTION 'Topology stable provider identity fenced'; END IF;
      n:=r;
    ELSE
      n:=NULL::mailboxes; n.id:=(item->>'id')::uuid; n.account_id:=account;
      n.first_discovered_at:=clock_timestamp(); n.created_at:=clock_timestamp();
      n.uid_validity_change_count:=0; n.recent_sync_status:='not_started'; n.recent_sync_message_count:=0;
      n.backfill_status:='not_started'; n.delta_sync_status:='not_started'; n.receiving_due_at:=clock_timestamp(); n.receiving_request_generation:=0;
    END IF;
    n.remote_path:=item->>'path'; n.name:=item->>'name'; n.delimiter:=item->>'delimiter';
    n.attributes:=ARRAY(SELECT jsonb_array_elements_text(item->'attributes')); n.special_use:=ARRAY(SELECT jsonb_array_elements_text(item->'specialUse'));
    n.selectable:=(item->>'selectable')::boolean; n.subscribed:=(item->>'subscribed')::boolean; n.provider_mailbox_id:=item->>'providerMailboxId';
    n.lifecycle_status:='active'; n.missing_since:=NULL; n.last_discovered_at:=clock_timestamp(); n.updated_at:=clock_timestamp();
    IF observed THEN
      PERFORM maildock_receiving_bounded_permit('mailboxes','UPDATE',to_jsonb(n),to_jsonb(r));
      UPDATE mailboxes SET remote_path=n.remote_path,name=n.name,delimiter=n.delimiter,attributes=n.attributes,special_use=n.special_use,
        selectable=n.selectable,subscribed=n.subscribed,provider_mailbox_id=n.provider_mailbox_id,lifecycle_status=n.lifecycle_status,
        missing_since=n.missing_since,last_discovered_at=n.last_discovered_at,updated_at=n.updated_at WHERE id=n.id;
    ELSE
      PERFORM maildock_receiving_bounded_permit('mailboxes','INSERT',to_jsonb(n),NULL);
      INSERT INTO mailboxes SELECT (jsonb_populate_record(NULL::mailboxes,to_jsonb(n))).*;
    END IF;
  END LOOP;
  FOR r IN SELECT * FROM mailboxes WHERE account_id=account AND NOT EXISTS(SELECT FROM jsonb_array_elements(evidence->'entries') x WHERE x->>'id'=mailboxes.id::text) ORDER BY id LOOP
    n:=r; n.lifecycle_status:='missing'; n.missing_since:=coalesce(r.missing_since,clock_timestamp()); n.updated_at:=clock_timestamp();
    PERFORM maildock_receiving_bounded_permit('mailboxes','UPDATE',to_jsonb(n),to_jsonb(r));
    UPDATE mailboxes SET lifecycle_status=n.lifecycle_status,missing_since=n.missing_since,updated_at=n.updated_at WHERE id=r.id;
  END LOOP;
  FOREACH role_name IN ARRAY ARRAY['archive','trash','sent','drafts','junk'] LOOP
    SELECT * INTO old_role FROM mailbox_roles WHERE account_id=account AND role=role_name;
    IF FOUND AND old_role.source='manual' THEN CONTINUE; END IF;
    SELECT array_agg(id ORDER BY id) INTO matches FROM mailboxes WHERE account_id=account AND selectable AND lifecycle_status='active'
      AND special_use @> ARRAY[CASE role_name WHEN 'archive' THEN E'\\Archive' WHEN 'trash' THEN E'\\Trash' WHEN 'sent' THEN E'\\Sent' WHEN 'drafts' THEN E'\\Drafts' ELSE E'\\Junk' END];
    IF old_role.account_id IS NOT NULL THEN
      PERFORM maildock_receiving_bounded_permit('mailbox_roles','DELETE',NULL,to_jsonb(old_role));
      DELETE FROM mailbox_roles WHERE account_id=account AND role=role_name;
    END IF;
    IF cardinality(matches)=1 THEN
      new_role.account_id:=account; new_role.role:=role_name; new_role.mailbox_id:=matches[1]; new_role.source:='special_use';
      new_role.created_at:=coalesce(old_role.created_at,clock_timestamp()); new_role.updated_at:=clock_timestamp();
      PERFORM maildock_receiving_bounded_permit('mailbox_roles','INSERT',to_jsonb(new_role),NULL);
      INSERT INTO mailbox_roles SELECT (jsonb_populate_record(NULL::mailbox_roles,to_jsonb(new_role))).*;
    END IF;
  END LOOP;
  SELECT coalesce(jsonb_agg(to_jsonb(role_row) ORDER BY role),'[]') INTO final_roles FROM mailbox_roles role_row WHERE account_id=account;
  scope:=scope || jsonb_build_object('roles',final_roles);
  PERFORM set_config('maildock.receiving_bounded_scope',scope::text,true);
  PERFORM maildock_receiving_bounded_advance();
END $$;
CREATE FUNCTION maildock_receiving_bounded_permit(relation text, operation text, n jsonb, o jsonb)
RETURNS void LANGUAGE plpgsql AS $$ BEGIN
  PERFORM set_config('maildock.receiving_bounded_write',jsonb_build_object('relation',relation,'operation',operation,'new',n,'old',o)::text,true);
END $$;
--> statement-breakpoint
CREATE FUNCTION maildock_receiving_data_scope(actor uuid, term bigint, account uuid, binding bigint, lifecycle bigint, scopes jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE lease receiving_coordinator%ROWTYPE; a mail_accounts%ROWTYPE; b mailboxes%ROWTYPE; s receiving_mailboxes%ROWTYPE;
  item jsonb; captured jsonb:='[]';
BEGIN
  IF nullif(current_setting('maildock.receiving_mailbox',true),'') IS NOT NULL OR
    nullif(current_setting('maildock.receiving_bounded_scope',true),'') IS NOT NULL OR
    scopes IS NULL OR jsonb_typeof(scopes) IS DISTINCT FROM 'array' OR jsonb_array_length(scopes) NOT BETWEEN 1 AND 2 OR
    (SELECT count(DISTINCT x->>'mailbox') FROM jsonb_array_elements(scopes) x)<>jsonb_array_length(scopes) OR
    octet_length(scopes::text)>65536 THEN RAISE EXCEPTION 'Invalid bounded data scope'; END IF;
  SELECT * INTO STRICT lease FROM receiving_coordinator WHERE singleton FOR SHARE;
  IF actor IS NULL OR term IS NULL OR lease.owner IS DISTINCT FROM actor OR lease.generation IS DISTINCT FROM term OR
    lease.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Receiving data owner fenced'; END IF;
  -- Same existing discovery/role serialization key, before any account/mailbox lock.
  PERFORM pg_advisory_xact_lock(hashtextextended('mailbox-discovery:'||account::text,0));
  SELECT * INTO STRICT a FROM mail_accounts WHERE id=account FOR SHARE;
  IF NOT a.enabled OR a.configuration_version IS DISTINCT FROM binding OR a.receiving_lifecycle_version IS DISTINCT FROM lifecycle THEN
    RAISE EXCEPTION 'Receiving data account fenced'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(scopes) ORDER BY (value->>'mailbox')::uuid LOOP
    IF item - ARRAY['mailbox','path','state'] <> '{}'::jsonb THEN RAISE EXCEPTION 'Invalid data scope fields'; END IF;
    SELECT * INTO STRICT b FROM mailboxes WHERE id=(item->>'mailbox')::uuid FOR UPDATE;
    IF b.account_id IS DISTINCT FROM account OR NOT b.selectable OR b.lifecycle_status<>'active' OR b.remote_path IS DISTINCT FROM item->>'path' THEN
      RAISE EXCEPTION 'Receiving data mailbox fenced'; END IF;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(scopes) ORDER BY (value->>'mailbox')::uuid LOOP
    SELECT * INTO STRICT s FROM receiving_mailboxes WHERE mailbox_id=(item->>'mailbox')::uuid FOR UPDATE;
    IF s.configuration_binding IS DISTINCT FROM binding OR
      (SELECT uid_validity FROM mailboxes WHERE id=s.mailbox_id) IS DISTINCT FROM s.epoch OR
      item->'state' IS DISTINCT FROM jsonb_build_object('epoch',s.epoch::text,'revision',s.revision::text,
        'freshThrough',s.fresh_through::text,'historyBefore',s.history_before::text,'reconcileAfter',s.reconcile_after::text) THEN
      RAISE EXCEPTION 'Receiving data epoch revision fenced'; END IF;
    captured:=captured || jsonb_build_array(jsonb_build_object('mailbox',s.mailbox_id,'path',item->>'path','state',maildock_receiving_identity_json(to_jsonb(s))));
  END LOOP;
  captured:=jsonb_build_object('kind','data','actor',actor,'generation',term::text,'account',account,
    'configuration',binding::text,'lifecycle',lifecycle::text,'scopes',captured);
  PERFORM set_config('maildock.receiving_bounded_scope',captured::text,true);
  RETURN captured;
END $$;
CREATE FUNCTION maildock_receiving_bounded_advance() RETURNS void LANGUAGE plpgsql AS $$
DECLARE item jsonb;
BEGIN
  PERFORM set_config('maildock.receiving_bounded_write','',true);
  FOR item IN SELECT value FROM jsonb_array_elements(nullif(current_setting('maildock.receiving_bounded_scope',true),'')::jsonb->'scopes') LOOP
    UPDATE receiving_mailboxes SET revision=revision+1 WHERE mailbox_id=(item->>'mailbox')::uuid;
  END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION maildock_receiving_move_claim(actor uuid, term bigint, account uuid, binding bigint, lifecycle bigint,
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
    c.receiving_attempt->>'id'=attempt::text OR
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
CREATE FUNCTION maildock_receiving_move_result(actor uuid, term bigint, account uuid, binding bigint, lifecycle bigint,
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
    jsonb_array_length(scopes)<>2 OR marker->>'source' IS DISTINCT FROM c.mailbox_id::text OR
    marker->>'destination' IS DISTINCT FROM c.destination_mailbox_id::text OR
    NOT EXISTS(SELECT FROM jsonb_array_elements(scopes) x WHERE x->>'mailbox'=c.mailbox_id::text AND x->>'path'=c.source_path) OR
    NOT EXISTS(SELECT FROM jsonb_array_elements(scopes) x WHERE x->>'mailbox'=c.destination_mailbox_id::text AND x->>'path'=c.destination_path) OR
    EXISTS(SELECT FROM jsonb_array_elements(marker->'scopes') x JOIN jsonb_array_elements(scope->'scopes') y ON x->>'mailbox'=y->>'mailbox'
      WHERE x->>'path' IS DISTINCT FROM y->>'path' OR x->'state'->>'epoch' IS DISTINCT FROM y->'state'->>'epoch') OR
    NOT maildock_receiving_active_source(account,c.mailbox_id,c.message_id,c.source_uid_validity,c.source_uid,binding) THEN
    RAISE EXCEPTION 'Receiving MOVE result attempt fenced'; END IF;
  IF evidence IS NULL OR evidence - ARRAY['complete','taggedOk','sourceEpoch','sourceUid','destinationEpoch','destinationUid','sourceRemoved','flags','modseq'] <> '{}'::jsonb OR
    evidence->'complete' IS DISTINCT FROM 'true'::jsonb OR evidence->'taggedOk' IS DISTINCT FROM 'true'::jsonb OR
    evidence->>'sourceEpoch' IS DISTINCT FROM c.source_uid_validity::text OR evidence->>'sourceUid' IS DISTINCT FROM c.source_uid::text OR
    octet_length(evidence::text)>65536 THEN RAISE EXCEPTION 'Invalid MOVE evidence'; END IF;
  PERFORM maildock_receiving_destination_flags(evidence);
  destination_uid:=(evidence->>'destinationUid')::bigint;
  destination_epoch:=(evidence->>'destinationEpoch')::bigint;
  n:=c; n.updated_at:=clock_timestamp(); n.completed_at:=clock_timestamp();
  IF destination_uid IS NULL THEN
    -- Missing COPYUID is uncertainty, never permission to invent a placement or retry MOVE.
    IF destination_epoch IS NOT NULL THEN RAISE EXCEPTION 'Partial destination mapping'; END IF;
    n.status:='failed'; n.error:='uncertain_remote_execution';
    n.receiving_attempt:=marker || jsonb_build_object('phase','uncertain_remote_execution');
    PERFORM maildock_receiving_request(account,c.mailbox_id);
    PERFORM maildock_receiving_request(account,c.destination_mailbox_id);
  ELSE
    IF destination_uid NOT BETWEEN 1 AND 4294967295 OR destination_epoch IS DISTINCT FROM
      (SELECT epoch FROM receiving_mailboxes WHERE mailbox_id=c.destination_mailbox_id) OR evidence->'sourceRemoved' IS DISTINCT FROM 'true'::jsonb THEN
      RAISE EXCEPTION 'Invalid known MOVE destination'; END IF;
    SELECT * INTO STRICT p FROM mailbox_messages WHERE id=c.placement_id FOR UPDATE;
    IF ROW(p.mailbox_id,p.message_id,p.uid_validity,p.uid,p.configuration_binding) IS DISTINCT FROM
      ROW(c.mailbox_id,c.message_id,c.source_uid_validity,c.source_uid,binding) THEN RAISE EXCEPTION 'MOVE placement identity fenced'; END IF;
    dest:=p; dest.id:=gen_random_uuid(); dest.mailbox_id:=c.destination_mailbox_id; dest.uid_validity:=destination_epoch; dest.uid:=destination_uid;
    dest.flags:=ARRAY(SELECT jsonb_array_elements_text(evidence->'flags')); dest.modseq:=(evidence->>'modseq')::bigint; dest.action_hidden:=false; dest.created_at:=clock_timestamp(); dest.updated_at:=clock_timestamp();
    dest.first_synchronized_at:=clock_timestamp(); dest.last_synchronized_at:=clock_timestamp();
    PERFORM maildock_receiving_bounded_permit('mailbox_messages','INSERT',to_jsonb(dest),NULL);
    INSERT INTO mailbox_messages SELECT (jsonb_populate_record(NULL::mailbox_messages,to_jsonb(dest))).*;
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
    n.receiving_attempt:=marker || jsonb_build_object('phase','succeeded');
  END IF;
  PERFORM maildock_receiving_bounded_permit('message_commands','UPDATE',to_jsonb(n),to_jsonb(c));
  UPDATE message_commands SET status=n.status,error=n.error,receiving_attempt=n.receiving_attempt,updated_at=n.updated_at,completed_at=n.completed_at,
    destination_uid=n.destination_uid,destination_uid_validity=n.destination_uid_validity WHERE id=intent;
  PERFORM maildock_receiving_bounded_advance();
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION maildock_receiving_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_data jsonb; scope uuid; context uuid; account_uuid uuid; previous boolean;
BEGIN
  IF maildock_receiving_bounded_write(TG_TABLE_NAME,TG_OP,to_jsonb(NEW),to_jsonb(OLD)) THEN IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END IF;
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

--> statement-breakpoint
CREATE OR REPLACE FUNCTION maildock_receiving_command_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p mailbox_messages%ROWTYPE; b mailboxes%ROWTYPE; dest mailboxes%ROWTYPE;
BEGIN
  IF maildock_receiving_bounded_write(TG_TABLE_NAME,TG_OP,to_jsonb(NEW),to_jsonb(OLD)) THEN IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END IF;
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
  -- L is this final clock comparison in the last mandatory deferred invocation.
  -- The SHARE lock conflicts with takeover until transaction end, including after L.
  IF lease.expires_at <= clock_timestamp() THEN RAISE EXCEPTION 'Receiving COMMIT lease expired'; END IF;
  RETURN NULL;
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION maildock_update_search_body() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m jsonb; permit text;
BEGIN
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
CREATE FUNCTION maildock_receiving_data_recover(actor uuid, term bigint, account uuid, binding bigint, lifecycle bigint,
  scopes jsonb, operation text, intent uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE item jsonb; current_scopes jsonb:='[]'; s receiving_mailboxes%ROWTYPE; scope jsonb; r jsonb;
BEGIN
  IF scopes IS NULL OR jsonb_typeof(scopes) IS DISTINCT FROM 'array' OR jsonb_array_length(scopes) NOT BETWEEN 1 AND 2 OR
    operation IS NULL OR operation NOT IN ('move','append') THEN RAISE EXCEPTION 'Invalid data recovery scope'; END IF;
  PERFORM 1 FROM receiving_coordinator WHERE singleton FOR SHARE;
  PERFORM pg_advisory_xact_lock(hashtextextended('mailbox-discovery:'||account::text,0));
  PERFORM 1 FROM mail_accounts WHERE id=account FOR SHARE;
  FOR item IN SELECT value FROM jsonb_array_elements(scopes) ORDER BY (value->>'mailbox')::uuid LOOP
    PERFORM 1 FROM mailboxes WHERE id=(item->>'mailbox')::uuid AND account_id=account FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Recovery account source fenced'; END IF;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(scopes) ORDER BY (value->>'mailbox')::uuid LOOP
    SELECT * INTO STRICT s FROM receiving_mailboxes WHERE mailbox_id=(item->>'mailbox')::uuid FOR UPDATE;
    current_scopes:=current_scopes || jsonb_build_array(jsonb_build_object('mailbox',s.mailbox_id,'path',item->>'path',
      'state',jsonb_build_object('epoch',s.epoch::text,'revision',s.revision::text,'freshThrough',s.fresh_through::text,
        'historyBefore',s.history_before::text,'reconcileAfter',s.reconcile_after::text)));
  END LOOP;
  scope:=maildock_receiving_data_scope(actor,term,account,binding,lifecycle,current_scopes);
  IF operation='move' THEN SELECT to_jsonb(c) INTO STRICT r FROM message_commands c WHERE id=intent AND account_id=account FOR UPDATE;
  ELSE SELECT to_jsonb(c) INTO STRICT r FROM outgoing_messages c WHERE id=intent AND account_id=account FOR UPDATE; END IF;
  IF operation='move' AND (jsonb_array_length(current_scopes)<>2 OR r->>'action' NOT IN ('archive','trash') OR
    NOT EXISTS(SELECT FROM jsonb_array_elements(current_scopes) x WHERE x->>'mailbox'=r->>'mailbox_id') OR
    NOT EXISTS(SELECT FROM jsonb_array_elements(current_scopes) x WHERE x->>'mailbox'=r->>'destination_mailbox_id')) THEN
    RAISE EXCEPTION 'MOVE recovery requires both original mailbox scopes'; END IF;
  IF operation='append' AND (jsonb_array_length(current_scopes)<>1 OR current_scopes->0->>'mailbox' IS DISTINCT FROM r->>'sent_copy_mailbox_id') THEN
    RAISE EXCEPTION 'APPEND recovery requires its original destination scope'; END IF;
  RETURN jsonb_build_object('scope',scope,'intent',r);
END $$;
CREATE FUNCTION maildock_receiving_data_failure(actor uuid, term bigint, account uuid, binding bigint, lifecycle bigint,
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
    marker->>'generation' IS DISTINCT FROM term::text OR marker->>'phase' IS DISTINCT FROM 'claimed' OR marker->>'operation' IS DISTINCT FROM operation OR
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
    nr.sent_copy_error:=outcome; nr.updated_at:=clock_timestamp(); nr.receiving_attempt:=marker || jsonb_build_object('phase',outcome);
    PERFORM maildock_receiving_bounded_permit('outgoing_messages','UPDATE',to_jsonb(nr),to_jsonb(r));
    UPDATE outgoing_messages SET sent_copy_status=nr.sent_copy_status,sent_copy_error=nr.sent_copy_error,updated_at=nr.updated_at,receiving_attempt=nr.receiving_attempt WHERE id=intent;
    IF outcome='uncertain_remote_execution' THEN PERFORM maildock_receiving_request(account,r.sent_copy_mailbox_id); END IF;
  END IF;
  PERFORM maildock_receiving_bounded_advance();
END $$;
DO $$ DECLARE fn regprocedure; BEGIN
  FOR fn IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN (
    'maildock_receiving_bounded_write','maildock_receiving_bounded_permit','maildock_receiving_data_scope',
    'maildock_receiving_bounded_advance','maildock_receiving_move_claim','maildock_receiving_move_result',
    'maildock_receiving_append_claim','maildock_receiving_append_result','maildock_receiving_outgoing_guard',
    'maildock_receiving_topology_capture','maildock_receiving_topology_result','maildock_receiving_terminal_remove',
    'maildock_receiving_bounded_revision','maildock_receiving_bounded_commit','maildock_receiving_roles_guard','maildock_receiving_data_recover',
    'maildock_receiving_identity_json','maildock_receiving_destination_flags','maildock_receiving_data_failure','maildock_receiving_terminal_recover') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn);
  END LOOP;
END $$;


--> statement-breakpoint
CREATE OR REPLACE FUNCTION maildock_receiving_lock(actor uuid, term bigint, mailbox uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE lease receiving_coordinator%ROWTYPE; folder mailboxes%ROWTYPE; enabled_account boolean; account_identity uuid;
BEGIN
  IF nullif(current_setting('maildock.receiving_bounded_scope',true),'') IS NOT NULL THEN RAISE EXCEPTION 'Bounded operation cannot acquire a legacy scope'; END IF;
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
