-- R04-B: complete evidence on the existing claimed business rows only.
CREATE FUNCTION maildock_receiving_cache_attempt(actor uuid, term bigint, mailbox uuid,
  expected jsonb, binding bigint, kind text, intent uuid, attempt uuid)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb; relation text; key text;
BEGIN
  IF kind IS NULL OR kind NOT IN ('content','attachment') THEN RAISE EXCEPTION 'Invalid cache capability'; END IF;
  PERFORM maildock_receiving_attempt_context(actor,term,mailbox,expected,binding);
  relation:=CASE kind WHEN 'content' THEN 'message_contents' ELSE 'message_attachments' END;
  key:=CASE kind WHEN 'content' THEN 'message_id' ELSE 'id' END;
  EXECUTE format('SELECT to_jsonb(r) FROM %I r WHERE %I=$1 FOR UPDATE',relation,key) INTO STRICT r USING intent;
  IF attempt IS NULL OR r->>'status' IS DISTINCT FROM 'fetching' OR
    r->'receiving_attempt'->>'id' IS DISTINCT FROM attempt::text OR
    r->'receiving_attempt'->>'actor' IS DISTINCT FROM actor::text OR
    r->'receiving_attempt'->>'generation' IS DISTINCT FROM term::text OR
    r->'receiving_attempt'->>'kind' IS DISTINCT FROM kind OR
    r->'receiving_attempt'->>'phase' IS DISTINCT FROM 'claimed' OR
    r->'receiving_attempt'->>'mailbox' IS DISTINCT FROM mailbox::text OR
    r->'receiving_attempt'->>'configuration' IS DISTINCT FROM binding::text OR
    r->'receiving_attempt'->>'lifecycle' IS DISTINCT FROM current_setting('maildock.receiving_lifecycle',true) OR
    r->'receiving_attempt'->>'path' IS DISTINCT FROM (SELECT remote_path FROM mailboxes WHERE id=mailbox) OR
    r->>'source_mailbox_id' IS DISTINCT FROM mailbox::text OR
    r->>'source_uid' IS DISTINCT FROM r->'receiving_attempt'->>'uid' OR
    r->>'source_uid_validity' IS DISTINCT FROM r->'receiving_attempt'->>'epoch' OR
    r->>'source_configuration_binding' IS DISTINCT FROM binding::text OR
    NOT maildock_receiving_active_source((r->'receiving_attempt'->>'account')::uuid,mailbox,
      (r->>'message_id')::uuid,(r->>'source_uid_validity')::bigint,(r->>'source_uid')::bigint,binding) THEN
    RAISE EXCEPTION 'Receiving cache attempt fenced'; END IF;
  RETURN r;
END $$;
CREATE FUNCTION maildock_receiving_complete_read(evidence jsonb, r jsonb) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF evidence IS NULL OR jsonb_typeof(evidence) IS DISTINCT FROM 'object' OR octet_length(evidence::text)>2097152 OR
    evidence->'complete' IS DISTINCT FROM 'true'::jsonb OR evidence->'taggedOk' IS DISTINCT FROM 'true'::jsonb OR
    evidence->'streamComplete' IS DISTINCT FROM 'true'::jsonb OR evidence->'decoded' IS DISTINCT FROM 'true'::jsonb OR
    evidence->'eof' IS DISTINCT FROM 'true'::jsonb OR evidence->>'method' IS DISTINCT FROM 'BODY.PEEK' OR
    evidence->>'origin' IS DISTINCT FROM '0' OR evidence->>'encodedBytes' IS NULL OR
    (evidence->>'encodedBytes')::bigint<0 OR nullif(evidence->>'part','') IS NULL OR
    evidence->>'epoch' IS DISTINCT FROM r->>'source_uid_validity' OR
    evidence->>'uid' IS DISTINCT FROM r->>'source_uid' THEN
    RAISE EXCEPTION 'Invalid completed read evidence'; END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION maildock_receiving_content_result(actor uuid, term bigint, mailbox uuid, expected jsonb,
  binding bigint, intent uuid, attempt uuid, evidence jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r jsonb; n jsonb;
BEGIN
  r:=maildock_receiving_cache_attempt(actor,term,mailbox,expected,binding,'content',intent,attempt);
  PERFORM maildock_receiving_complete_read(evidence,r);
  IF evidence - ARRAY['complete','taggedOk','streamComplete','decoded','eof','method','origin','encodedBytes','part','epoch','uid',
    'plainText','sanitizedHtml','searchText','policyVersion','remoteContentBlocked','sanitized'] <> '{}'::jsonb OR
    evidence->'sanitized' IS DISTINCT FROM 'true'::jsonb OR evidence->>'part' IS DISTINCT FROM 'TEXT' OR
    evidence->>'policyVersion' IS DISTINCT FROM 'email-html-v2' OR
    jsonb_typeof(evidence->'searchText') IS DISTINCT FROM 'string' OR
    jsonb_typeof(evidence->'remoteContentBlocked') IS DISTINCT FROM 'boolean' OR
    NOT evidence ?& ARRAY['plainText','sanitizedHtml'] OR
    jsonb_typeof(evidence->'plainText') NOT IN ('string','null') OR
    jsonb_typeof(evidence->'sanitizedHtml') NOT IN ('string','null') THEN
    RAISE EXCEPTION 'Invalid complete content payload'; END IF;
  n:=r || jsonb_build_object('status','ready','error',NULL,'plain_text',evidence->'plainText',
    'sanitized_html',evidence->'sanitizedHtml','search_text',evidence->'searchText',
    'policy_version',evidence->>'policyVersion','remote_content_blocked',evidence->'remoteContentBlocked',
    'fetched_at',clock_timestamp(),'updated_at',clock_timestamp(),
    'receiving_attempt',r->'receiving_attempt' || jsonb_build_object('phase','succeeded'));
  PERFORM set_config('maildock.receiving_content_search',intent::text,true);
  PERFORM set_config('maildock.receiving_attempt_write',jsonb_build_object('relation','message_contents','old',r,'new',n)::text,true);
  UPDATE message_contents SET status='ready',error=NULL,plain_text=n->>'plain_text',sanitized_html=n->>'sanitized_html',
    search_text=n->>'search_text',policy_version=n->>'policy_version',remote_content_blocked=(n->>'remote_content_blocked')::boolean,
    fetched_at=(n->>'fetched_at')::timestamptz,updated_at=(n->>'updated_at')::timestamptz,
    receiving_attempt=n->'receiving_attempt' WHERE message_id=intent;
  PERFORM set_config('maildock.receiving_attempt_write','',true);
  PERFORM set_config('maildock.receiving_content_search','',true);
  UPDATE receiving_mailboxes SET revision=revision+1 WHERE mailbox_id=mailbox;
END $$;
--> statement-breakpoint
CREATE FUNCTION maildock_receiving_attachment_result(actor uuid, term bigint, mailbox uuid, expected jsonb,
  binding bigint, intent uuid, attempt uuid, evidence jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r jsonb; n jsonb; blob uuid; b blobs%ROWTYPE;
BEGIN
  r:=maildock_receiving_cache_attempt(actor,term,mailbox,expected,binding,'attachment',intent,attempt);
  PERFORM maildock_receiving_complete_read(evidence,r);
  IF evidence - ARRAY['complete','taggedOk','streamComplete','decoded','eof','method','origin','encodedBytes','part','epoch','uid',
    'stored','storageKey','size','sha256'] <> '{}'::jsonb OR evidence->'stored' IS DISTINCT FROM 'true'::jsonb OR
    evidence->>'part' IS DISTINCT FROM r->>'part_id' OR
    evidence->>'storageKey' IS NULL OR evidence->>'storageKey' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' OR
    evidence->>'sha256' IS NULL OR evidence->>'sha256' !~ '^[0-9a-f]{64}$' OR
    evidence->>'size' IS NULL OR (evidence->>'size')::bigint NOT BETWEEN 0 AND 15728640 THEN
    RAISE EXCEPTION 'Invalid finalized attachment evidence'; END IF;
  -- Stored evidence is emitted only after the trusted storage verifier, outside SQL.
  INSERT INTO blobs(id,storage_key,size,sha256) VALUES(gen_random_uuid(),evidence->>'storageKey',
    (evidence->>'size')::bigint,evidence->>'sha256') ON CONFLICT(storage_key) DO NOTHING;
  SELECT * INTO STRICT b FROM blobs WHERE storage_key=evidence->>'storageKey' FOR SHARE;
  IF b.size IS DISTINCT FROM (evidence->>'size')::bigint OR b.sha256 IS DISTINCT FROM evidence->>'sha256' THEN
    RAISE EXCEPTION 'Conflicting finalized blob'; END IF;
  blob:=b.id;
  n:=r || jsonb_build_object('status','ready','blob_id',blob,'error',NULL,'updated_at',clock_timestamp(),
    'receiving_attempt',r->'receiving_attempt' || jsonb_build_object('phase','succeeded'));
  PERFORM set_config('maildock.receiving_attempt_write',jsonb_build_object('relation','message_attachments','old',r,'new',n)::text,true);
  UPDATE message_attachments SET status='ready',blob_id=blob,error=NULL,updated_at=(n->>'updated_at')::timestamptz,
    receiving_attempt=n->'receiving_attempt' WHERE id=intent;
  PERFORM set_config('maildock.receiving_attempt_write','',true);
  PERFORM 1 FROM draft_attachments WHERE id=intent AND kind='incoming' AND blob_id IS NULL ORDER BY draft_id FOR UPDATE;
  UPDATE draft_attachments SET blob_id=blob WHERE id=intent AND kind='incoming' AND blob_id IS NULL;
  UPDATE receiving_mailboxes SET revision=revision+1 WHERE mailbox_id=mailbox;
END $$;
--> statement-breakpoint
-- The existing content trigger alone may update the shared derived field.
CREATE OR REPLACE FUNCTION maildock_update_search_body() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m jsonb; permit text;
BEGIN
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
CREATE OR REPLACE FUNCTION maildock_receiving_attempt_write(relation text, operation text, n jsonb, o jsonb)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE permit jsonb;
BEGIN
  permit:=nullif(current_setting('maildock.receiving_attempt_write',true),'')::jsonb;
  IF permit IS NULL THEN RETURN false; END IF;
  IF relation='messages' THEN
    IF current_setting('maildock.receiving_content_search',true) IS DISTINCT FROM n->>'id' OR
      (n-'search_vector'-'search_body') IS DISTINCT FROM (o-'search_vector'-'search_body') THEN
      RAISE EXCEPTION 'Receiving derived-only write fenced'; END IF;
    n:=n-'search_vector'; o:=o-'search_vector';
  END IF;
  IF operation<>'UPDATE' OR relation IS DISTINCT FROM permit->>'relation'
    OR o IS DISTINCT FROM permit->'old' OR n IS DISTINCT FROM permit->'new' THEN
    RAISE EXCEPTION 'Receiving attempt write scope fenced'; END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION maildock_receiving_cache_attempt(uuid,bigint,uuid,jsonb,bigint,text,uuid,uuid),
  maildock_receiving_complete_read(jsonb,jsonb),
  maildock_receiving_content_result(uuid,bigint,uuid,jsonb,bigint,uuid,uuid,jsonb),
  maildock_receiving_attachment_result(uuid,bigint,uuid,jsonb,bigint,uuid,uuid,jsonb) FROM PUBLIC;
