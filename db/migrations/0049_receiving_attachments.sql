-- R12: incoming attachment-only ceiling and bounded restart claims.
CREATE OR REPLACE FUNCTION maildock_receiving_attachment_result(actor uuid, term bigint, mailbox uuid, expected jsonb,
  binding bigint, intent uuid, attempt uuid, evidence jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r jsonb; n jsonb; blob uuid; b blobs%ROWTYPE;
BEGIN
  r:=maildock_receiving_cache_attempt(actor,term,mailbox,expected,binding,'attachment',intent,attempt);
  PERFORM maildock_receiving_complete_read(evidence,r);
  IF evidence - ARRAY['complete','taggedOk','streamComplete','decoded','eof','method','origin','encodedBytes','part','epoch','uid',
    'stored','storageKey','size','sha256'] <> '{}'::jsonb OR evidence->'stored' IS DISTINCT FROM 'true'::jsonb OR
    evidence->>'part' IS DISTINCT FROM r->>'part_id' OR
    (evidence->>'encodedBytes')::bigint > 419430400 OR
    (r->>'declared_size' IS NOT NULL AND (evidence->>'encodedBytes')::bigint IS DISTINCT FROM (r->>'declared_size')::bigint) OR
    evidence->>'storageKey' IS NULL OR evidence->>'storageKey' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' OR
    evidence->>'sha256' IS NULL OR evidence->>'sha256' !~ '^[0-9a-f]{64}$' OR
    evidence->>'size' IS NULL OR (evidence->>'size')::bigint NOT BETWEEN 0 AND 104857600 THEN
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
-- R12 read-only restart follows R11 on the existing intent. Never retargets its source.
CREATE FUNCTION maildock_receiving_attachment_claim(actor uuid, term bigint, mailbox uuid, expected jsonb,
  binding bigint, intent uuid, attempt uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE s receiving_mailboxes%ROWTYPE; r jsonb; n jsonb; marker jsonb; account uuid; reads integer;
BEGIN
  IF attempt IS NULL THEN RAISE EXCEPTION 'Missing attachment attempt'; END IF;
  s:=maildock_receiving_attempt_context(actor,term,mailbox,expected,binding);
  SELECT to_jsonb(c) INTO STRICT r FROM message_attachments c WHERE id=intent FOR UPDATE;
  account:=(SELECT account_id FROM mailboxes WHERE id=mailbox);
  IF r->>'status' NOT IN ('pending','fetching') OR r->>'source_mailbox_id' IS DISTINCT FROM mailbox::text OR
    r->>'source_configuration_binding' IS DISTINCT FROM binding::text OR
    NOT maildock_receiving_visible_resource((r->>'message_id')::uuid,mailbox,
      (r->>'source_uid_validity')::bigint,(r->>'source_uid')::bigint,binding) OR
    NOT maildock_receiving_active_source(account,mailbox,(r->>'message_id')::uuid,
      (r->>'source_uid_validity')::bigint,(r->>'source_uid')::bigint,binding) THEN
    RAISE EXCEPTION 'Attachment source fenced'; END IF;
  reads:=1;
  IF r->>'status'='fetching' THEN
    IF r->'receiving_attempt'->>'kind' IS DISTINCT FROM 'attachment' OR
      r->'receiving_attempt'->>'part' IS DISTINCT FROM r->>'part_id' OR
      r->'receiving_attempt'->>'phase' IS DISTINCT FROM 'claimed' OR
      r->'receiving_attempt'->>'account' IS DISTINCT FROM account::text OR
      r->'receiving_attempt'->>'mailbox' IS DISTINCT FROM mailbox::text OR
      r->'receiving_attempt'->>'epoch' IS DISTINCT FROM r->>'source_uid_validity' OR
      r->'receiving_attempt'->>'uid' IS DISTINCT FROM r->>'source_uid' OR
      r->'receiving_attempt'->>'configuration' IS DISTINCT FROM binding::text OR
      r->'receiving_attempt'->>'path' IS DISTINCT FROM (SELECT remote_path FROM mailboxes WHERE id=mailbox) THEN
      RAISE EXCEPTION 'Attachment restart source fenced'; END IF;
    reads:=coalesce((r->'receiving_attempt'->>'reads')::integer,1)+1;
  END IF;
  IF reads>3 OR r->'receiving_attempt'->>'id'=attempt::text THEN RAISE EXCEPTION 'Attachment restart bound exceeded'; END IF;
  marker:=jsonb_build_object('id',attempt,'actor',actor,'generation',term::text,'account',account,
    'mailbox',mailbox,'path',(SELECT remote_path FROM mailboxes WHERE id=mailbox),'epoch',s.epoch::text,
    'uid',r->>'source_uid','part',r->>'part_id','configuration',binding::text,'claimRevision',(s.revision+1)::text,
    'phase','claimed','kind','attachment','reads',reads::text,'previousAttempt',r->'receiving_attempt'->>'id',
    'lifecycle',(SELECT receiving_lifecycle_version::text FROM mail_accounts WHERE id=account));
  n:=r || jsonb_build_object('receiving_attempt',marker,'status','fetching','error',NULL,'updated_at',clock_timestamp());
  PERFORM set_config('maildock.receiving_attempt_write',jsonb_build_object('relation','message_attachments','old',r,'new',n)::text,true);
  UPDATE message_attachments SET receiving_attempt=marker,status='fetching',error=NULL,updated_at=(n->>'updated_at')::timestamptz WHERE id=intent;
  PERFORM set_config('maildock.receiving_attempt_write','',true);
  UPDATE receiving_mailboxes SET revision=revision+1 WHERE mailbox_id=mailbox;
  RETURN marker;
END $$;
REVOKE ALL ON FUNCTION maildock_receiving_attachment_claim(uuid,bigint,uuid,jsonb,bigint,uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE INDEX message_attachments_receiving_pending_idx ON message_attachments(updated_at,id)
  WHERE status IN ('pending','fetching') AND source_configuration_binding IS NOT NULL;
