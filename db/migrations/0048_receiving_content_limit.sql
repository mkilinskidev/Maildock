-- R11 completion: preserve the exact cache attempt, write permit and COMMIT fences.
CREATE OR REPLACE FUNCTION maildock_receiving_content_result(actor uuid, term bigint, mailbox uuid, expected jsonb,
  binding bigint, intent uuid, attempt uuid, evidence jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r jsonb; n jsonb;
BEGIN
  r:=maildock_receiving_cache_attempt(actor,term,mailbox,expected,binding,'content',intent,attempt);
  -- Content-only envelope; attachment complete-read authority retains 2 MiB.
  IF evidence IS NULL OR octet_length(evidence::text)>67112960 OR
    jsonb_typeof(evidence->'displayBytes') IS DISTINCT FROM 'number' OR
    evidence->>'displayBytes' !~ '^(0|[1-9][0-9]*)$' OR
    (evidence->>'displayBytes')::bigint NOT BETWEEN 0 AND 5242880 OR
    octet_length(coalesce(evidence->>'plainText',''))>(evidence->>'displayBytes')::bigint OR
    (evidence->>'encodedBytes')::bigint NOT BETWEEN 0 AND 5242880 THEN
    RAISE EXCEPTION 'Content exceeds bounded display/publication policy'; END IF;
  -- Only compact transfer metadata enters the shared 2 MiB validator.
  PERFORM maildock_receiving_complete_read(evidence - ARRAY['plainText','sanitizedHtml','searchText'],r);
  IF evidence - ARRAY['complete','taggedOk','streamComplete','decoded','eof','method','origin','encodedBytes','part','epoch','uid',
    'displayBytes','plainText','sanitizedHtml','searchText','policyVersion','remoteContentBlocked','sanitized'] <> '{}'::jsonb OR
    evidence->'sanitized' IS DISTINCT FROM 'true'::jsonb OR evidence->>'part' IS DISTINCT FROM 'TEXT' OR
    evidence->>'policyVersion' IS DISTINCT FROM 'email-html-v2' OR
    jsonb_typeof(evidence->'searchText') IS DISTINCT FROM 'string' OR
    jsonb_typeof(evidence->'remoteContentBlocked') IS DISTINCT FROM 'boolean' OR
    NOT evidence ?& ARRAY['plainText','sanitizedHtml'] OR
    (evidence->'plainText'='null'::jsonb AND evidence->'sanitizedHtml'='null'::jsonb) OR
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
-- Only content failures may carry this fixed, bounded display-policy diagnostic.
CREATE OR REPLACE FUNCTION maildock_receiving_attempt_failure(actor uuid, term bigint, mailbox uuid, expected jsonb,
  binding bigint, kind text, intent uuid, attempt uuid, outcome text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE r jsonb; n jsonb; relation text; key text; s receiving_mailboxes%ROWTYPE;
BEGIN
  IF kind IS NULL OR kind NOT IN ('command','content','attachment') OR outcome IS NULL OR
    (outcome NOT IN ('failed_before_execution','uncertain_remote_execution','failed_remote_read','display_content_limit_exceeded') OR (outcome='display_content_limit_exceeded' AND kind<>'content')) THEN
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
  n:=r || jsonb_build_object('status','failed','error',CASE WHEN outcome='display_content_limit_exceeded' THEN 'Message display content exceeds the supported 5 MiB encoded or decoded limit.' ELSE outcome END,'updated_at',clock_timestamp(),
    'receiving_attempt',r->'receiving_attempt' || jsonb_build_object('phase',outcome));
  IF kind='command' THEN n:=n || jsonb_build_object('completed_at',clock_timestamp()); END IF;
  PERFORM set_config('maildock.receiving_attempt_write',jsonb_build_object('relation',relation,'old',r,'new',n)::text,true);
  IF kind='command' THEN
    UPDATE message_commands SET status='failed',error=outcome,receiving_attempt=n->'receiving_attempt',
      completed_at=(n->>'completed_at')::timestamptz,updated_at=(n->>'updated_at')::timestamptz WHERE id=intent;
  ELSIF kind='content' THEN
    UPDATE message_contents SET status='failed',error=n->>'error',receiving_attempt=n->'receiving_attempt',updated_at=(n->>'updated_at')::timestamptz WHERE message_id=intent;
  ELSE
    UPDATE message_attachments SET status='failed',error=outcome,receiving_attempt=n->'receiving_attempt',updated_at=(n->>'updated_at')::timestamptz WHERE id=intent;
  END IF;
  PERFORM set_config('maildock.receiving_attempt_write','',true);
  IF outcome='uncertain_remote_execution' THEN
    PERFORM maildock_receiving_request((r->'receiving_attempt'->>'account')::uuid,mailbox);
  END IF;
  UPDATE receiving_mailboxes SET revision=revision+1 WHERE mailbox_id=mailbox;
END $$;
