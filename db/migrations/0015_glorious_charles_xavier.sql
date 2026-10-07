CREATE TABLE "blobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"storage_key" text NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blobs_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "blobs_size" CHECK ("blobs"."size" >= 0),
	CONSTRAINT "blobs_sha256" CHECK ("blobs"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "message_attachments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"message_id" uuid NOT NULL,
	"source_mailbox_id" uuid,
	"source_uid_validity" bigint NOT NULL,
	"source_uid" bigint NOT NULL,
	"part_id" text NOT NULL,
	"filename" text,
	"content_type" text NOT NULL,
	"disposition" text,
	"content_id" text,
	"inline" boolean NOT NULL,
	"visible" boolean NOT NULL,
	"declared_size" bigint,
	"blob_id" uuid,
	"status" text DEFAULT 'not_fetched' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_attachments_status" CHECK ("message_attachments"."status" in ('not_fetched', 'pending', 'fetching', 'ready', 'failed')),
	CONSTRAINT "message_attachments_ready" CHECK (("message_attachments"."status" = 'ready') = ("message_attachments"."blob_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "outgoing_message_attachments" (
	"outgoing_message_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"blob_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text NOT NULL,
	CONSTRAINT "outgoing_message_attachments_outgoing_message_id_position_pk" PRIMARY KEY("outgoing_message_id","position"),
	CONSTRAINT "outgoing_attachment_position" CHECK ("outgoing_message_attachments"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "staged_attachments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"blob_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "staged_attachments_status" CHECK ("staged_attachments"."status" in ('ready', 'removed', 'consumed'))
);
--> statement-breakpoint
ALTER TABLE "outgoing_messages" ALTER COLUMN "mime_base64" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "outgoing_messages" ADD COLUMN "mime_blob_id" uuid;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_source_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("source_mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_blob_id_blobs_id_fk" FOREIGN KEY ("blob_id") REFERENCES "public"."blobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outgoing_message_attachments" ADD CONSTRAINT "outgoing_message_attachments_outgoing_message_id_outgoing_messages_id_fk" FOREIGN KEY ("outgoing_message_id") REFERENCES "public"."outgoing_messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outgoing_message_attachments" ADD CONSTRAINT "outgoing_message_attachments_blob_id_blobs_id_fk" FOREIGN KEY ("blob_id") REFERENCES "public"."blobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staged_attachments" ADD CONSTRAINT "staged_attachments_blob_id_blobs_id_fk" FOREIGN KEY ("blob_id") REFERENCES "public"."blobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_attachments_part_unique" ON "message_attachments" USING btree ("message_id","part_id");--> statement-breakpoint
CREATE INDEX "message_attachments_pending_idx" ON "message_attachments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "staged_attachments_expiry_idx" ON "staged_attachments" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "outgoing_messages" ADD CONSTRAINT "outgoing_messages_mime_blob_id_blobs_id_fk" FOREIGN KEY ("mime_blob_id") REFERENCES "public"."blobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outgoing_messages" ADD CONSTRAINT "outgoing_messages_mime_source" CHECK (("outgoing_messages"."mime_blob_id" is not null and "outgoing_messages"."mime_base64" is null) or ("outgoing_messages"."mime_blob_id" is null and "outgoing_messages"."mime_base64" is not null));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION maildock_outgoing_snapshot_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.account_id, NEW."from", NEW."to", NEW.cc, NEW.bcc,
         NEW.subject, NEW.plain_text, NEW.message_id, NEW.mime_base64, NEW.mime_blob_id, NEW.created_at, NEW.sent_copy_policy, NEW.in_reply_to, NEW."references")
     IS DISTINCT FROM
     ROW(OLD.id, OLD.account_id, OLD."from", OLD."to", OLD.cc, OLD.bcc,
         OLD.subject, OLD.plain_text, OLD.message_id, OLD.mime_base64, OLD.mime_blob_id, OLD.created_at, OLD.sent_copy_policy, OLD.in_reply_to, OLD."references") THEN
    RAISE EXCEPTION 'Outgoing message snapshot is immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION maildock_blob_snapshot_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Blob and outgoing attachment snapshots are immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER blob_snapshot_immutable BEFORE UPDATE ON blobs
FOR EACH ROW EXECUTE FUNCTION maildock_blob_snapshot_immutable();
--> statement-breakpoint
CREATE TRIGGER outgoing_attachment_snapshot_immutable BEFORE UPDATE ON outgoing_message_attachments
FOR EACH ROW EXECUTE FUNCTION maildock_blob_snapshot_immutable();
