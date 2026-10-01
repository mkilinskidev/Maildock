ALTER TABLE "messages" ADD COLUMN "references" text;--> statement-breakpoint
ALTER TABLE "outgoing_messages" ADD COLUMN "in_reply_to" text;--> statement-breakpoint
ALTER TABLE "outgoing_messages" ADD COLUMN "references" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION maildock_outgoing_snapshot_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.account_id, NEW."from", NEW."to", NEW.cc, NEW.bcc,
         NEW.subject, NEW.plain_text, NEW.message_id, NEW.mime_base64, NEW.created_at, NEW.sent_copy_policy, NEW.in_reply_to, NEW."references")
     IS DISTINCT FROM
     ROW(OLD.id, OLD.account_id, OLD."from", OLD."to", OLD.cc, OLD.bcc,
         OLD.subject, OLD.plain_text, OLD.message_id, OLD.mime_base64, OLD.created_at, OLD.sent_copy_policy, OLD.in_reply_to, OLD."references") THEN
    RAISE EXCEPTION 'Outgoing message snapshot is immutable';
  END IF;
  RETURN NEW;
END;
$$;
