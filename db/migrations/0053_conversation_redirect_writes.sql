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
    (SELECT count(*) FROM conversation_members WHERE account_id = msg.account_id AND normalized_message_id = own_id) > 1)) THEN
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

--> statement-breakpoint
-- Topology demand survives a crash before account/OAuth wake delivery.
CREATE OR REPLACE FUNCTION maildock_receiving_account_demand() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.enabled AND NOT OLD.enabled) OR
    ROW(NEW.imap_host,NEW.imap_port,NEW.imap_security,NEW.imap_username,NEW.imap_password,NEW.auth_method,NEW.provider_type,NEW.oauth_provider_id,NEW.oauth_home_account_id,NEW.configuration_version)
    IS DISTINCT FROM ROW(OLD.imap_host,OLD.imap_port,OLD.imap_security,OLD.imap_username,OLD.imap_password,OLD.auth_method,OLD.provider_type,OLD.oauth_provider_id,OLD.oauth_home_account_id,OLD.configuration_version) THEN
    NEW.receiving_due_at:=least(OLD.receiving_due_at,clock_timestamp());
    NEW.receiving_request_generation:=OLD.receiving_request_generation+1;
    NEW.mailbox_discovery_status:='pending';
    NEW.mailbox_discovery_error:=NULL;
    NEW.mailbox_discovery_requested_at:=clock_timestamp();
  END IF;
  RETURN NEW;
END $$;
