-- R11 read-only restart on the existing intent. Never retargets its source.
CREATE FUNCTION maildock_receiving_content_claim(actor uuid, term bigint, mailbox uuid, expected jsonb,
  binding bigint, intent uuid, attempt uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE s receiving_mailboxes%ROWTYPE; r jsonb; n jsonb; marker jsonb; account uuid; reads integer;
BEGIN
  IF attempt IS NULL THEN RAISE EXCEPTION 'Missing content attempt'; END IF;
  s:=maildock_receiving_attempt_context(actor,term,mailbox,expected,binding);
  SELECT to_jsonb(c) INTO STRICT r FROM message_contents c WHERE message_id=intent FOR UPDATE;
  account:=(SELECT account_id FROM mailboxes WHERE id=mailbox);
  IF r->>'status' NOT IN ('pending','fetching') OR r->>'source_mailbox_id' IS DISTINCT FROM mailbox::text OR
    r->>'source_configuration_binding' IS DISTINCT FROM binding::text OR
    NOT maildock_receiving_visible_resource((r->>'message_id')::uuid,mailbox,
      (r->>'source_uid_validity')::bigint,(r->>'source_uid')::bigint,binding) OR
    NOT maildock_receiving_active_source(account,mailbox,(r->>'message_id')::uuid,
      (r->>'source_uid_validity')::bigint,(r->>'source_uid')::bigint,binding) THEN
    RAISE EXCEPTION 'Content source fenced'; END IF;
  reads:=1;
  IF r->>'status'='fetching' THEN
    IF r->'receiving_attempt'->>'kind' IS DISTINCT FROM 'content' OR
      r->'receiving_attempt'->>'phase' IS DISTINCT FROM 'claimed' OR
      r->'receiving_attempt'->>'account' IS DISTINCT FROM account::text OR
      r->'receiving_attempt'->>'mailbox' IS DISTINCT FROM mailbox::text OR
      r->'receiving_attempt'->>'epoch' IS DISTINCT FROM r->>'source_uid_validity' OR
      r->'receiving_attempt'->>'uid' IS DISTINCT FROM r->>'source_uid' OR
      r->'receiving_attempt'->>'configuration' IS DISTINCT FROM binding::text OR
      r->'receiving_attempt'->>'path' IS DISTINCT FROM (SELECT remote_path FROM mailboxes WHERE id=mailbox) THEN
      RAISE EXCEPTION 'Content restart source fenced'; END IF;
    reads:=coalesce((r->'receiving_attempt'->>'reads')::integer,1)+1;
  END IF;
  IF reads>3 OR r->'receiving_attempt'->>'id'=attempt::text THEN RAISE EXCEPTION 'Content restart bound exceeded'; END IF;
  marker:=jsonb_build_object('id',attempt,'actor',actor,'generation',term::text,'account',account,
    'mailbox',mailbox,'path',(SELECT remote_path FROM mailboxes WHERE id=mailbox),'epoch',s.epoch::text,
    'uid',r->>'source_uid','configuration',binding::text,'claimRevision',(s.revision+1)::text,
    'phase','claimed','kind','content','reads',reads::text,'previousAttempt',r->'receiving_attempt'->>'id',
    'lifecycle',(SELECT receiving_lifecycle_version::text FROM mail_accounts WHERE id=account));
  n:=r || jsonb_build_object('receiving_attempt',marker,'status','fetching','error',NULL,'updated_at',clock_timestamp());
  PERFORM set_config('maildock.receiving_attempt_write',jsonb_build_object('relation','message_contents','old',r,'new',n)::text,true);
  UPDATE message_contents SET receiving_attempt=marker,status='fetching',error=NULL,updated_at=(n->>'updated_at')::timestamptz WHERE message_id=intent;
  PERFORM set_config('maildock.receiving_attempt_write','',true);
  UPDATE receiving_mailboxes SET revision=revision+1 WHERE mailbox_id=mailbox;
  RETURN marker;
END $$;
REVOKE ALL ON FUNCTION maildock_receiving_content_claim(uuid,bigint,uuid,jsonb,bigint,uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE INDEX message_contents_receiving_pending_idx ON message_contents(updated_at,message_id)
  WHERE status IN ('pending','fetching') AND source_configuration_binding IS NOT NULL;
