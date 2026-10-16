-- Quiet, empty-page observation settles a scheduling hint without fabricating
-- a frontier/revision change. No new fact-writing authority is introduced.
CREATE OR REPLACE FUNCTION maildock_receiving_observation_due(actor uuid, term bigint, mailbox uuid,
  account uuid, binding bigint, lifecycle bigint, expected jsonb, request_generation bigint, poll_ms integer)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE s receiving_mailboxes%ROWTYPE; b mailboxes%ROWTYPE; certificate jsonb;
BEGIN
  IF nullif(current_setting('maildock.receiving_observation_due',true),'') IS NOT NULL
    OR actor IS NULL OR term IS NULL OR request_generation IS NULL OR request_generation<0
    OR poll_ms IS NULL OR poll_ms<1 OR poll_ms>2147483647 THEN RAISE EXCEPTION 'Invalid observation settlement'; END IF;
  PERFORM maildock_receiving_lock(actor,term,mailbox);
  PERFORM maildock_receiving_account_identity(account,binding,lifecycle);
  SELECT * INTO STRICT s FROM receiving_mailboxes WHERE mailbox_id=mailbox FOR UPDATE;
  SELECT * INTO STRICT b FROM mailboxes WHERE id=mailbox;
  IF b.account_id IS DISTINCT FROM account OR s.configuration_binding IS DISTINCT FROM binding
    OR b.uid_validity IS DISTINCT FROM s.epoch
    OR expected IS DISTINCT FROM jsonb_build_object('epoch',s.epoch::text,'revision',s.revision::text,
      'freshThrough',s.fresh_through::text,'historyBefore',s.history_before::text,'reconcileAfter',s.reconcile_after::text)
    OR s.reconcile_after<>0 OR EXISTS(SELECT FROM mailbox_messages WHERE mailbox_id=mailbox
      AND configuration_binding=binding AND uid_validity=s.epoch LIMIT 1)
    THEN RAISE EXCEPTION 'Empty observation identity or page fenced'; END IF;
  IF b.receiving_request_generation<>request_generation THEN RETURN; END IF;
  certificate:=jsonb_build_object('actor',actor,'term',term,'account',account,'binding',binding,'lifecycle',lifecycle,
    'state',to_jsonb(s),'old',to_jsonb(b),'new',to_jsonb(b) || jsonb_build_object('receiving_due_at',clock_timestamp()+poll_ms*interval '1 millisecond'));
  PERFORM set_config('maildock.receiving_observation_due',certificate::text,true);
  UPDATE mailboxes SET receiving_due_at=(certificate->'new'->>'receiving_due_at')::timestamptz WHERE id=mailbox;
END $$;
REVOKE ALL ON FUNCTION maildock_receiving_observation_due(uuid,bigint,uuid,uuid,bigint,bigint,jsonb,bigint,integer) FROM PUBLIC;

--> statement-breakpoint

-- Preserve historical/pending command provenance when exact membership evidence
-- removes a placement. Reuse exact OLD/NEW attempt permits, not an intent bypass.
CREATE OR REPLACE FUNCTION maildock_receiving_membership_references(mailbox uuid, expected_revision bigint, epoch bigint, binding bigint, absent jsonb)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE s receiving_mailboxes%ROWTYPE; b mailboxes%ROWTYPE; r message_commands%ROWTYPE; n message_commands%ROWTYPE;
  certificates jsonb:='[]'; total integer:=0;
BEGIN
  IF current_setting('maildock.receiving_mailbox',true) IS DISTINCT FROM mailbox::text
    OR current_setting('maildock.receiving_revision',true) IS DISTINCT FROM expected_revision::text
    OR nullif(current_setting('maildock.receiving_bounded_scope',true),'') IS NOT NULL
    OR nullif(current_setting('maildock.receiving_operation',true),'') IS NOT NULL
    OR nullif(current_setting('maildock.receiving_removed_references',true),'') IS NOT NULL
    OR jsonb_typeof(absent) IS DISTINCT FROM 'array' OR jsonb_array_length(absent)>128
    THEN RAISE EXCEPTION 'Membership reference scope required'; END IF;
  SELECT * INTO STRICT s FROM receiving_mailboxes WHERE mailbox_id=mailbox FOR UPDATE;
  SELECT * INTO STRICT b FROM mailboxes WHERE id=mailbox;
  IF s.revision IS DISTINCT FROM expected_revision OR s.epoch IS DISTINCT FROM epoch
    OR s.configuration_binding IS DISTINCT FROM binding OR b.uid_validity IS DISTINCT FROM epoch
    OR NOT maildock_receiving_validate(
      current_setting('maildock.receiving_owner',true)::uuid,current_setting('maildock.receiving_generation',true)::bigint)
    THEN RAISE EXCEPTION 'Membership reference authority fenced'; END IF;
  FOR r IN SELECT c.* FROM message_commands c JOIN mailbox_messages p ON p.id=c.placement_id
    WHERE p.mailbox_id=mailbox AND p.uid_validity=epoch AND p.configuration_binding=binding
      AND p.uid=ANY(ARRAY(SELECT jsonb_array_elements_text(absent))::bigint[])
    ORDER BY c.id LIMIT 129 FOR UPDATE OF c LOOP
    total:=total+1;
    IF total>128 OR r.account_id IS DISTINCT FROM b.account_id OR r.mailbox_id IS DISTINCT FROM mailbox
      THEN RAISE EXCEPTION 'Membership reference bound or identity fenced'; END IF;
    n:=r; n.placement_id:=NULL;
    PERFORM set_config('maildock.receiving_attempt_write',jsonb_build_object('relation','message_commands','old',to_jsonb(r),'new',to_jsonb(n))::text,true);
    UPDATE message_commands SET placement_id=NULL WHERE id=r.id;
    PERFORM set_config('maildock.receiving_attempt_write','',true);
    certificates:=certificates || jsonb_build_array(jsonb_build_object('placement',r.placement_id,'new',to_jsonb(n)));
    IF octet_length(certificates::text)>2097152 THEN RAISE EXCEPTION 'Membership reference certificate bound'; END IF;
  END LOOP;
  IF certificates<>'[]'::jsonb THEN PERFORM set_config('maildock.receiving_removed_references',certificates::text,true); END IF;
END $$;
REVOKE ALL ON FUNCTION maildock_receiving_membership_references(uuid,bigint,bigint,bigint,jsonb) FROM PUBLIC;


--> statement-breakpoint
-- R17: a new Message-ID collision retracts graph evidence only when an
-- existing reference used that ID. Shared ancestry alone needs no rebuild.
-- R16: retain the existing conversation graph and all receiving authority.
-- A redirect already pointing at the winner needs no rewrite when another
-- member arrives. Rewriting every retained redirect makes dense windows quadratic
-- in writes, including account-removal guards, indexes and deferred triggers.
CREATE OR REPLACE FUNCTION maildock_reconcile_conversation(message_uuid uuid, rebuilding boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  msg messages%ROWTYPE;
  own_id text;
  refs text[];
  groups uuid[];
  winner uuid;
  token text;
  existing boolean;
  affected uuid[];
  member_ids uuid[];
  member_uuid uuid;
BEGIN
  SELECT * INTO STRICT msg FROM messages WHERE id = message_uuid;
  -- Serialize mailbox workers in the same account, including ancestor discovery.
  PERFORM pg_advisory_xact_lock(hashtextextended(msg.account_id::text, 271));
  own_id := CASE WHEN cardinality(maildock_thread_ids(msg.rfc_message_id)) = 1
    THEN (maildock_thread_ids(msg.rfc_message_id))[1] END;
  refs := maildock_thread_ids(coalesce(msg.in_reply_to, '') || ' ' || coalesce(msg."references", ''));
  existing := EXISTS(SELECT 1 FROM conversation_members WHERE message_id = msg.id);
  INSERT INTO conversations(id, account_id) VALUES (msg.id, msg.account_id) ON CONFLICT DO NOTHING;
  INSERT INTO conversation_members(message_id, account_id, conversation_id, normalized_message_id)
    VALUES(msg.id, msg.account_id, msg.id, own_id)
    ON CONFLICT (message_id) DO UPDATE SET normalized_message_id = excluded.normalized_message_id;
  -- A late ID collision invalidates earlier unique-parent evidence. Rebuild only
  -- its affected component(s), using all currently known headers. Header edits
  -- likewise retract stale evidence rather than permanently retaining a merge.
  IF NOT rebuilding AND (existing OR (own_id IS NOT NULL AND
    (SELECT count(*) FROM conversation_members WHERE account_id = msg.account_id AND normalized_message_id = own_id) > 1
    AND EXISTS(SELECT FROM conversation_references WHERE account_id = msg.account_id AND header_id = own_id))) THEN
    SELECT array_agg(DISTINCT conversation_id) INTO affected FROM (
      SELECT conversation_id FROM conversation_members WHERE message_id = msg.id
      UNION ALL
      SELECT conversation_id FROM conversation_members WHERE account_id = msg.account_id AND normalized_message_id = own_id
      UNION ALL
      SELECT conversation_id FROM conversation_references WHERE account_id = msg.account_id AND header_id = own_id
    ) candidates;
    SELECT array_agg(message_id ORDER BY message_id) INTO member_ids FROM conversation_members
      WHERE account_id = msg.account_id AND conversation_id = ANY(affected);
    DELETE FROM conversation_references WHERE account_id = msg.account_id AND conversation_id = ANY(affected);
    UPDATE conversation_members SET conversation_id = message_id WHERE message_id = ANY(member_ids);
    UPDATE conversations SET merged_into = NULL, updated_at = now() WHERE account_id = msg.account_id AND id = ANY(member_ids);
    FOREACH member_uuid IN ARRAY member_ids LOOP
      PERFORM maildock_reconcile_conversation(member_uuid, true);
    END LOOP;
    RETURN;
  END IF;
  -- A known collision also makes a shared reference token ambiguous: two
  -- children may be replies to different messages that reused the same ID.
  SELECT coalesce(array_agg(r), ARRAY[]::text[]) INTO refs FROM unnest(refs) r
    WHERE (SELECT count(*) FROM conversation_members p
      WHERE p.account_id = msg.account_id AND p.normalized_message_id = r) <= 1;
  -- A Message-ID alone is not an identity or a reason to merge two local messages.
  -- Resolve a referenced existing message only when that ID is unambiguous.
  SELECT array_agg(DISTINCT conversation_id) INTO groups FROM (
    SELECT conversation_id FROM conversation_members WHERE message_id = msg.id
    UNION ALL
    SELECT conversation_id FROM conversation_references
      WHERE account_id = msg.account_id AND header_id = ANY(refs)
    UNION ALL
    SELECT conversation_id FROM conversation_references
      WHERE account_id = msg.account_id AND header_id = own_id
      AND (SELECT count(*) FROM conversation_members WHERE account_id = msg.account_id AND normalized_message_id = own_id) = 1
    UNION ALL
    SELECT conversation_id FROM conversation_members m
      WHERE m.account_id = msg.account_id AND normalized_message_id = ANY(refs)
      AND (SELECT count(*) FROM conversation_members p WHERE p.account_id = msg.account_id AND p.normalized_message_id = m.normalized_message_id) = 1
  ) candidates;
  SELECT g INTO winner FROM unnest(groups) g ORDER BY g LIMIT 1;
  UPDATE conversation_members SET conversation_id = winner
    WHERE account_id = msg.account_id AND conversation_id = ANY(groups) AND conversation_id <> winner;
  UPDATE conversation_references SET conversation_id = winner
    WHERE account_id = msg.account_id AND conversation_id = ANY(groups) AND conversation_id <> winner;
  -- Retain losing IDs as redirects; no message rows or placements are copied.
  UPDATE conversations SET merged_into = winner, updated_at = now()
    WHERE account_id = msg.account_id AND (id = ANY(groups) OR merged_into = ANY(groups)) AND id <> winner
      AND merged_into IS DISTINCT FROM winner;
  UPDATE conversations SET updated_at = now() WHERE id = winner;
  FOREACH token IN ARRAY refs LOOP
    INSERT INTO conversation_references(account_id, header_id, conversation_id)
      VALUES(msg.account_id, token, winner) ON CONFLICT DO NOTHING;
  END LOOP;
END $$;
