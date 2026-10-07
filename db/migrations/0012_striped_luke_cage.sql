CREATE TABLE "outgoing_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"from" jsonb NOT NULL,
	"to" jsonb NOT NULL,
	"cc" jsonb NOT NULL,
	"bcc" jsonb NOT NULL,
	"subject" text NOT NULL,
	"plain_text" text NOT NULL,
	"message_id" text NOT NULL,
	"mime_base64" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"accepted_count" integer,
	"rejected_count" integer,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"smtp_accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outgoing_messages_status" CHECK ("outgoing_messages"."status" in ('queued', 'sending', 'sent', 'failed', 'uncertain')),
	CONSTRAINT "outgoing_messages_attempts" CHECK ("outgoing_messages"."attempts" between 0 and 3),
	CONSTRAINT "outgoing_messages_mime_size" CHECK (octet_length("outgoing_messages"."mime_base64") <= 1333336),
	CONSTRAINT "outgoing_messages_recipients" CHECK (jsonb_array_length("outgoing_messages"."to") + jsonb_array_length("outgoing_messages"."cc") + jsonb_array_length("outgoing_messages"."bcc") between 1 and 100)
);
--> statement-breakpoint
ALTER TABLE "outgoing_messages" ADD CONSTRAINT "outgoing_messages_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "outgoing_messages_message_id_unique" ON "outgoing_messages" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "outgoing_messages_pending_idx" ON "outgoing_messages" USING btree ("status","next_attempt_at");
--> statement-breakpoint
-- All compose data and the final MIME bytes are immutable from creation.
CREATE FUNCTION maildock_outgoing_snapshot_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.account_id, NEW."from", NEW."to", NEW.cc, NEW.bcc,
         NEW.subject, NEW.plain_text, NEW.message_id, NEW.mime_base64, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.account_id, OLD."from", OLD."to", OLD.cc, OLD.bcc,
         OLD.subject, OLD.plain_text, OLD.message_id, OLD.mime_base64, OLD.created_at) THEN
    RAISE EXCEPTION 'Outgoing message snapshot is immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER outgoing_snapshot_immutable BEFORE UPDATE ON outgoing_messages
FOR EACH ROW EXECUTE FUNCTION maildock_outgoing_snapshot_immutable();
