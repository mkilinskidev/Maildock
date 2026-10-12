-- Disposable experiment database only. No production imports/migrations.
CREATE TABLE IF NOT EXISTS coordinator (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  owner text NOT NULL DEFAULT '',
  generation bigint NOT NULL DEFAULT 0,
  expires timestamptz NOT NULL DEFAULT '-infinity'
);
INSERT INTO coordinator(singleton) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS mailbox (
  account text PRIMARY KEY,
  path text NOT NULL,
  epoch bigint NOT NULL,
  fresh bigint NOT NULL,
  history bigint NOT NULL,
  reconcile bigint NOT NULL DEFAULT 0,
  revision bigint NOT NULL DEFAULT 0,
  wake bigint NOT NULL DEFAULT 0,
  fresh_due timestamptz NOT NULL DEFAULT now(),
  repair_due timestamptz NOT NULL DEFAULT now(),
  CHECK (epoch BETWEEN 1 AND 4294967295),
  CHECK (fresh BETWEEN 0 AND 4294967295),
  CHECK (history BETWEEN 1 AND 4294967296),
  CHECK (history <= fresh + 1)
);
CREATE TABLE IF NOT EXISTS placement (
  account text NOT NULL REFERENCES mailbox(account),
  epoch bigint NOT NULL,
  uid bigint NOT NULL CHECK (uid BETWEEN 1 AND 4294967295),
  message_id text NOT NULL,
  subject text NOT NULL,
  size integer NOT NULL,
  flags jsonb NOT NULL,
  PRIMARY KEY(account, epoch, uid)
);
CREATE OR REPLACE VIEW current_placement AS
  SELECT p.* FROM placement p JOIN mailbox m USING(account) WHERE p.epoch=m.epoch;
-- Check again inside COMMIT, after any client suspension or delayed COMMIT send.
-- Due-only wake updates do not alter authoritative coverage/revision.
CREATE OR REPLACE FUNCTION assert_commit_authority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' OR NEW.revision<>OLD.revision OR NEW.epoch<>OLD.epoch THEN
    PERFORM generation FROM coordinator WHERE singleton
      AND owner=current_setting('phase3.owner',true)
      AND generation=current_setting('phase3.generation',true)::bigint
      AND expires>clock_timestamp() FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'COMMIT authority fenced'; END IF;
  END IF;
  RETURN NULL;
END;
$$;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='mailbox_commit_authority') THEN
    CREATE CONSTRAINT TRIGGER mailbox_commit_authority AFTER INSERT OR UPDATE ON mailbox
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_commit_authority();
  END IF;
END $$;
