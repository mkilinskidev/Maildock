-- Original addresses plus local-part/domain aliases in the same indexed FTS document.
CREATE FUNCTION maildock_search_addresses(addresses jsonb) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(string_agg(coalesce(a->>'name', '') || ' ' ||
    coalesce(a->>'address', '') || ' ' ||
    replace(coalesce(a->>'address', ''), '@', ' ') || ' ' ||
    regexp_replace(coalesce(a->>'address', ''), '[^[:alnum:]_]+', ' ', 'g'), ' '), '')
  FROM jsonb_array_elements(addresses) a
$$;
--> statement-breakpoint
CREATE FUNCTION maildock_search_vector(subject text, from_addresses jsonb,
  sender jsonb, recipients jsonb, cc jsonb, body text) RETURNS tsvector
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT setweight(to_tsvector('simple', coalesce(subject, '')), 'A') ||
    setweight(to_tsvector('simple', maildock_search_addresses(from_addresses || sender)), 'B') ||
    setweight(to_tsvector('simple', maildock_search_addresses(recipients || cc)), 'C') ||
    setweight(to_tsvector('simple', coalesce(body, '')), 'D')
$$;
--> statement-breakpoint
ALTER TABLE message_contents ADD COLUMN search_text text;
--> statement-breakpoint
ALTER TABLE messages ADD COLUMN search_body text NOT NULL DEFAULT '';
--> statement-breakpoint
-- Plain text is already local. HTML-only rows are converted by the resumable
-- server-side parser in db:migrate, never by fetching remote message bodies.
UPDATE message_contents SET search_text = plain_text WHERE nullif(btrim(plain_text), '') IS NOT NULL;
--> statement-breakpoint
UPDATE messages m SET search_body = coalesce(c.search_text, '')
FROM message_contents c WHERE c.message_id = m.id;
--> statement-breakpoint
ALTER TABLE messages ADD COLUMN search_vector tsvector GENERATED ALWAYS AS
  (maildock_search_vector(subject, "from", sender, "to", cc, search_body)) STORED;
--> statement-breakpoint
CREATE INDEX messages_search_gin_idx ON messages USING gin(search_vector);
--> statement-breakpoint
CREATE FUNCTION maildock_update_search_body() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE messages SET search_body = '' WHERE id = OLD.message_id;
    RETURN OLD;
  END IF;
  UPDATE messages SET search_body = coalesce(NEW.search_text, NEW.plain_text, '')
    WHERE id = NEW.message_id;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER message_contents_search_body
AFTER INSERT OR UPDATE OF search_text, plain_text, sanitized_html OR DELETE ON message_contents
FOR EACH ROW EXECUTE FUNCTION maildock_update_search_body();
