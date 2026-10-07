ALTER TABLE "mail_accounts" ADD COLUMN "sent_copy_policy" text DEFAULT 'server' NOT NULL;--> statement-breakpoint
ALTER TABLE "outgoing_messages" ADD COLUMN "sent_copy_policy" text DEFAULT 'server' NOT NULL;--> statement-breakpoint
ALTER TABLE "outgoing_messages" ADD COLUMN "sent_copy_status" text DEFAULT 'not_required' NOT NULL;--> statement-breakpoint
ALTER TABLE "outgoing_messages" ADD COLUMN "sent_copy_error" text;--> statement-breakpoint
ALTER TABLE "outgoing_messages" ADD COLUMN "sent_copy_mailbox_id" uuid;--> statement-breakpoint
ALTER TABLE "outgoing_messages" ADD COLUMN "sent_copy_path" text;--> statement-breakpoint
ALTER TABLE "outgoing_messages" ADD COLUMN "sent_copy_uid_validity" bigint;--> statement-breakpoint
ALTER TABLE "outgoing_messages" ADD COLUMN "sent_copy_uid" bigint;--> statement-breakpoint
ALTER TABLE "outgoing_messages" ADD COLUMN "sent_copy_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outgoing_messages" ADD COLUMN "sent_copy_saved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outgoing_messages" ADD COLUMN "sent_copy_sync_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "outgoing_messages" ADD CONSTRAINT "outgoing_messages_sent_copy_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("sent_copy_mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outgoing_messages_sent_copy_pending_idx" ON "outgoing_messages" USING btree ("sent_copy_status","sent_copy_sync_pending");--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD CONSTRAINT "mail_accounts_sent_copy_policy" CHECK ("mail_accounts"."sent_copy_policy" in ('server', 'maildock'));--> statement-breakpoint
ALTER TABLE "outgoing_messages" ADD CONSTRAINT "outgoing_messages_sent_copy_policy" CHECK ("outgoing_messages"."sent_copy_policy" in ('server', 'maildock'));--> statement-breakpoint
ALTER TABLE "outgoing_messages" ADD CONSTRAINT "outgoing_messages_sent_copy_status" CHECK ("outgoing_messages"."sent_copy_status" in ('not_required', 'pending', 'saving', 'saved', 'failed', 'uncertain'));--> statement-breakpoint
ALTER TABLE "outgoing_messages" ADD CONSTRAINT "outgoing_messages_sent_copy_delivery" CHECK ("outgoing_messages"."sent_copy_status" = 'not_required' or ("outgoing_messages"."status" = 'sent' and "outgoing_messages"."sent_copy_policy" = 'maildock'));--> statement-breakpoint
ALTER TABLE "outgoing_messages" ADD CONSTRAINT "outgoing_messages_sent_copy_sync" CHECK (not "outgoing_messages"."sent_copy_sync_pending" or "outgoing_messages"."sent_copy_status" = 'saved');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION maildock_outgoing_snapshot_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.account_id, NEW."from", NEW."to", NEW.cc, NEW.bcc,
         NEW.subject, NEW.plain_text, NEW.message_id, NEW.mime_base64, NEW.created_at, NEW.sent_copy_policy)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.account_id, OLD."from", OLD."to", OLD.cc, OLD.bcc,
         OLD.subject, OLD.plain_text, OLD.message_id, OLD.mime_base64, OLD.created_at, OLD.sent_copy_policy) THEN
    RAISE EXCEPTION 'Outgoing message snapshot is immutable';
  END IF;
  RETURN NEW;
END;
$$;
