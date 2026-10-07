-- Only bracketed, case-preserving RFC identifiers are accepted. Subjects and
-- provider IDs deliberately play no role in this graph.
CREATE FUNCTION maildock_thread_ids(value text) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(array_agg(DISTINCT match[1]), ARRAY[]::text[])
  FROM regexp_matches(left(coalesce(value, ''), 65536), '(<[^<>[:space:]]+@[^<>[:space:]]+>)', 'g') AS match
  WHERE octet_length(match[1]) <= 254
$$;
--> statement-breakpoint
ALTER TABLE instance_state ADD COLUMN conversation_view boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE TABLE conversations (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL CONSTRAINT conversations_account_id_mail_accounts_id_fk REFERENCES mail_accounts(id) ON DELETE CASCADE,
  merged_into uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversations_account_id_unique UNIQUE (account_id, id),
  CONSTRAINT conversations_account_id_merged_into_conversations_account_id_id_fk FOREIGN KEY (account_id, merged_into) REFERENCES conversations(account_id, id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX messages_account_id_unique ON messages(account_id, id);
CREATE TABLE conversation_members (
  message_id uuid PRIMARY KEY,
  account_id uuid NOT NULL CONSTRAINT conversation_members_account_id_mail_accounts_id_fk REFERENCES mail_accounts(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  normalized_message_id text,
  CONSTRAINT conversation_members_account_id_conversation_id_conversations_account_id_id_fk FOREIGN KEY (account_id, conversation_id) REFERENCES conversations(account_id, id),
  CONSTRAINT conversation_members_account_id_message_id_messages_account_id_id_fk FOREIGN KEY (account_id, message_id) REFERENCES messages(account_id, id) ON DELETE CASCADE
);
CREATE INDEX conversation_members_group_idx ON conversation_members(account_id, conversation_id);
CREATE INDEX conversation_members_header_idx ON conversation_members(account_id, normalized_message_id);
--> statement-breakpoint
CREATE TABLE conversation_references (
  account_id uuid NOT NULL CONSTRAINT conversation_references_account_id_mail_accounts_id_fk REFERENCES mail_accounts(id) ON DELETE CASCADE,
  header_id text NOT NULL,
  conversation_id uuid NOT NULL,
  CONSTRAINT conversation_references_account_id_header_id_pk PRIMARY KEY (account_id, header_id),
  CONSTRAINT conversation_references_account_id_conversation_id_conversations_account_id_id_fk FOREIGN KEY (account_id, conversation_id) REFERENCES conversations(account_id, id)
);
CREATE INDEX conversation_references_group_idx ON conversation_references(account_id, conversation_id);
--> statement-breakpoint
CREATE FUNCTION maildock_reconcile_conversation(message_uuid uuid, rebuilding boolean DEFAULT false) RETURNS void
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
    WHERE account_id = msg.account_id AND (id = ANY(groups) OR merged_into = ANY(groups)) AND id <> winner;
  UPDATE conversations SET updated_at = now() WHERE id = winner;
  FOREACH token IN ARRAY refs LOOP
    INSERT INTO conversation_references(account_id, header_id, conversation_id)
      VALUES(msg.account_id, token, winner) ON CONFLICT DO NOTHING;
  END LOOP;
END $$;
--> statement-breakpoint
-- Seed all identities before resolving existing mail, so migration order does
-- not make a duplicate header appear temporarily unambiguous.
INSERT INTO conversations(id, account_id) SELECT id, account_id FROM messages;
INSERT INTO conversation_members(message_id, account_id, conversation_id, normalized_message_id)
  SELECT id, account_id, id, CASE WHEN cardinality(maildock_thread_ids(rfc_message_id)) = 1
    THEN (maildock_thread_ids(rfc_message_id))[1] END FROM messages;
DO $$ DECLARE m uuid; BEGIN
  FOR m IN SELECT id FROM messages ORDER BY account_id, id LOOP
    PERFORM maildock_reconcile_conversation(m, true);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION maildock_conversation_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.rfc_message_id IS DISTINCT FROM OLD.rfc_message_id
    OR NEW.in_reply_to IS DISTINCT FROM OLD.in_reply_to
    OR NEW."references" IS DISTINCT FROM OLD."references" THEN
    PERFORM maildock_reconcile_conversation(NEW.id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER messages_conversation AFTER INSERT OR UPDATE OF rfc_message_id, in_reply_to, "references"
  ON messages FOR EACH ROW EXECUTE FUNCTION maildock_conversation_trigger();
