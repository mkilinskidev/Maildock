CREATE TABLE "mail_publications" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
-- This marker commits with each materialized change, including local command
-- overlays. It is deliberately separate from account authority row locks.
CREATE FUNCTION maildock_publish_mail() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE scope uuid;
        publication bigint := pg_current_xact_id()::text::bigint;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD IS NOT DISTINCT FROM NEW THEN RETURN NULL; END IF;
  IF TG_TABLE_NAME = 'mail_accounts' THEN
    IF TG_OP = 'DELETE' THEN
      DELETE FROM mail_publications WHERE account_id = OLD.id;
      RETURN NULL;
    END IF;
    scope := NEW.id;
  ELSIF TG_TABLE_NAME = 'message_contents' THEN
    SELECT account_id INTO scope FROM messages
      WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.message_id ELSE NEW.message_id END;
  ELSE
    scope := CASE WHEN TG_OP = 'DELETE' THEN OLD.account_id ELSE NEW.account_id END;
  END IF;
  IF scope IS NOT NULL AND EXISTS (SELECT 1 FROM mail_accounts WHERE id = scope) THEN
    -- Full transaction IDs never repeat; equality is the only API operation.
    -- Deferred row triggers publish at most one row version per account/commit.
    IF EXISTS (SELECT 1 FROM mail_publications WHERE account_id = scope AND revision = publication) THEN
      RETURN NULL;
    END IF;
    INSERT INTO mail_publications(account_id, revision) VALUES (scope, publication)
      ON CONFLICT (account_id) DO UPDATE SET revision = EXCLUDED.revision;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER mail_publication AFTER INSERT OR UPDATE OR DELETE ON mail_accounts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION maildock_publish_mail();
CREATE CONSTRAINT TRIGGER mail_publication AFTER INSERT OR UPDATE OR DELETE ON mailboxes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION maildock_publish_mail();
CREATE CONSTRAINT TRIGGER mail_publication AFTER INSERT OR UPDATE OR DELETE ON messages
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION maildock_publish_mail();
CREATE CONSTRAINT TRIGGER mail_publication AFTER INSERT OR UPDATE OR DELETE ON mailbox_messages
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION maildock_publish_mail();
CREATE CONSTRAINT TRIGGER mail_publication AFTER INSERT OR UPDATE OR DELETE ON mailbox_roles
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION maildock_publish_mail();
CREATE CONSTRAINT TRIGGER mail_publication AFTER INSERT OR UPDATE OR DELETE ON conversation_members
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION maildock_publish_mail();
CREATE CONSTRAINT TRIGGER mail_publication AFTER INSERT OR UPDATE OR DELETE ON message_contents
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION maildock_publish_mail();
CREATE CONSTRAINT TRIGGER mail_publication AFTER INSERT OR UPDATE OR DELETE ON gmail_account_sync_state
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION maildock_publish_mail();
