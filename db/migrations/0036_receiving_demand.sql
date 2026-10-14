-- New-install scheduling hints, not a second work ledger or coverage proof.
ALTER TABLE mail_accounts ADD COLUMN receiving_due_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE mail_accounts ADD COLUMN receiving_request_generation bigint NOT NULL DEFAULT 0 CHECK (receiving_request_generation >= 0);
ALTER TABLE mailboxes ADD COLUMN receiving_due_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE mailboxes ADD COLUMN receiving_request_generation bigint NOT NULL DEFAULT 0 CHECK (receiving_request_generation >= 0);
--> statement-breakpoint
-- Only hint-only updates may bypass the existing authoritative mailbox guard.
-- Every other column (including any future column) stays guarded.
DROP TRIGGER receiving_write_guard ON mailboxes;
CREATE TRIGGER receiving_write_guard BEFORE INSERT OR DELETE ON mailboxes
FOR EACH ROW EXECUTE FUNCTION maildock_receiving_write_guard();
CREATE TRIGGER receiving_update_guard BEFORE UPDATE ON mailboxes
FOR EACH ROW WHEN (
  (to_jsonb(NEW)-ARRAY['receiving_due_at','receiving_request_generation']) IS DISTINCT FROM
  (to_jsonb(OLD)-ARRAY['receiving_due_at','receiving_request_generation'])
) EXECUTE FUNCTION maildock_receiving_write_guard();
--> statement-breakpoint
-- One row, in the same transaction as account creation/enablement/credentials.
-- No mailbox fanout under an account lock; the repair reader reconstructs work.
CREATE FUNCTION maildock_receiving_account_demand() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.enabled AND (NOT OLD.enabled OR
    ROW(NEW.imap_host,NEW.imap_port,NEW.imap_security,NEW.imap_username,NEW.imap_password,NEW.auth_method,NEW.oauth_status,NEW.oauth_provider_id,NEW.oauth_home_account_id)
    IS DISTINCT FROM ROW(OLD.imap_host,OLD.imap_port,OLD.imap_security,OLD.imap_username,OLD.imap_password,OLD.auth_method,OLD.oauth_status,OLD.oauth_provider_id,OLD.oauth_home_account_id)) THEN
    NEW.receiving_due_at := least(OLD.receiving_due_at,clock_timestamp());
    NEW.receiving_request_generation := OLD.receiving_request_generation+1;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER receiving_account_demand BEFORE UPDATE ON mail_accounts
FOR EACH ROW EXECUTE FUNCTION maildock_receiving_account_demand();
REVOKE ALL ON FUNCTION maildock_receiving_account_demand() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION maildock_receiving_request(account uuid, mailbox uuid DEFAULT NULL)
RETURNS TABLE(accepted boolean, inbox boolean) LANGUAGE plpgsql AS $$
DECLARE folder mailboxes%ROWTYPE;
BEGIN
  -- Bound producer lock/statement waits. No IMAP or job send in this transaction.
  PERFORM set_config('lock_timeout','2000',true);
  IF mailbox IS NULL THEN
    UPDATE mail_accounts SET receiving_due_at=least(receiving_due_at,clock_timestamp()),
      receiving_request_generation=receiving_request_generation+1 WHERE id=account AND enabled;
    RETURN QUERY SELECT FOUND,true; RETURN;
  END IF;
  IF NOT EXISTS(SELECT FROM mail_accounts WHERE id=account AND enabled FOR SHARE) THEN
    RETURN QUERY SELECT false,false; RETURN;
  END IF;
  SELECT * INTO folder FROM mailboxes WHERE id=mailbox AND account_id=account FOR UPDATE;
  IF NOT FOUND OR NOT folder.selectable OR folder.lifecycle_status<>'active' THEN
    RETURN QUERY SELECT false,false; RETURN;
  END IF;
  UPDATE mailboxes SET receiving_due_at=least(receiving_due_at,clock_timestamp()),
    receiving_request_generation=receiving_request_generation+1 WHERE id=mailbox;
  RETURN QUERY SELECT true,folder.remote_path='INBOX';
END $$;
REVOKE ALL ON FUNCTION maildock_receiving_request(uuid,uuid) FROM PUBLIC;
