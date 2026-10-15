-- Positional parameters prevent receiving_mailboxes.epoch from shadowing the
-- requested epoch when the same message/UID has placements in retained epochs.
CREATE OR REPLACE FUNCTION maildock_receiving_active_source(account uuid, mailbox uuid, message uuid, epoch bigint, remote_uid bigint, binding bigint)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT FROM mailbox_messages p JOIN messages m ON m.id=p.message_id
    JOIN mailboxes b ON b.id=p.mailbox_id JOIN mail_accounts a ON a.id=b.account_id
    JOIN receiving_mailboxes s ON s.mailbox_id=b.id
    WHERE a.id=$1 AND m.account_id=$1 AND b.id=$2 AND m.id=$3
      AND b.selectable AND b.lifecycle_status='active' AND p.uid=$5 AND p.uid BETWEEN 1 AND 4294967295
      AND p.uid_validity=$4 AND b.uid_validity=$4 AND s.epoch=$4
      AND p.configuration_binding=$6 AND s.configuration_binding=$6 AND a.configuration_version=$6)
$$;
--> statement-breakpoint
-- Reuse C1's active-source rule and optimistic projection for every resource.
-- Account.enabled is deliberately a remote-admission rule, not a cached-read rule.
CREATE FUNCTION maildock_receiving_visible_resource(message uuid, mailbox uuid, epoch bigint, remote_uid bigint, binding bigint)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT FROM messages m WHERE m.id=$1 AND
    (NOT maildock_receiving_account_enrolled(m.account_id) OR EXISTS(
      SELECT FROM message_placement_projection p
      WHERE p.message_id=m.id AND p.mailbox_id=$2
        AND p.uid_validity=$3 AND p.uid=$4 AND p.configuration_binding=$5
        AND NOT p.action_hidden)))
$$;
--> statement-breakpoint
-- Stage 1 consumers and C1 consumers now share the exact current-source rule.
CREATE OR REPLACE VIEW receiving_current_placements AS
SELECT p.* FROM mailbox_messages p JOIN mailboxes b ON b.id=p.mailbox_id
WHERE maildock_receiving_active_source(b.account_id,b.id,p.message_id,p.uid_validity,p.uid,p.configuration_binding);

--> statement-breakpoint
CREATE OR REPLACE FUNCTION maildock_receiving_content_request(account uuid, mailbox uuid, message uuid)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE p mailbox_messages%ROWTYPE; c message_contents%ROWTYPE;
BEGIN
  p:=maildock_receiving_intent_source(account,mailbox,message);
  IF NOT EXISTS(SELECT FROM message_placement_projection v WHERE v.mailbox_id=$2 AND v.message_id=$3 AND NOT v.action_hidden) THEN
    RAISE EXCEPTION 'Receiving request source hidden'; END IF;
  SELECT * INTO c FROM message_contents WHERE message_id=message FOR UPDATE;
  IF FOUND AND c.status IN ('ready','pending','fetching') THEN
    IF NOT maildock_receiving_visible_resource(c.message_id,c.source_mailbox_id,c.source_uid_validity,c.source_uid,c.source_configuration_binding) THEN
      RAISE EXCEPTION 'Receiving request cached source unavailable'; END IF;
    IF c.status<>'ready' AND ROW(c.source_mailbox_id,c.source_uid_validity,c.source_uid,c.source_configuration_binding)
      IS DISTINCT FROM ROW(mailbox,p.uid_validity,p.uid,p.configuration_binding) THEN
      RAISE EXCEPTION 'Receiving content in-flight source mismatch'; END IF;
    RETURN false;
  END IF;
  IF c.message_id IS NULL THEN
    INSERT INTO message_contents(message_id,status,source_mailbox_id,source_uid_validity,source_uid,source_configuration_binding)
      VALUES(message,'pending',mailbox,p.uid_validity,p.uid,p.configuration_binding);
  ELSE
    UPDATE message_contents SET status='pending',error=NULL,updated_at=clock_timestamp(),source_mailbox_id=mailbox,
      source_uid_validity=p.uid_validity,source_uid=p.uid,source_configuration_binding=p.configuration_binding
      WHERE message_id=message;
  END IF;
  RETURN true;
END $$;
