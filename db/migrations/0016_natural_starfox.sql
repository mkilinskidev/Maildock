CREATE TABLE "draft_attachments" (
	"draft_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"kind" text NOT NULL,
	"blob_id" uuid,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "draft_attachments_draft_id_id_pk" PRIMARY KEY("draft_id","id"),
	CONSTRAINT "draft_attachments_kind" CHECK ("draft_attachments"."kind" in ('staged', 'incoming'))
);
--> statement-breakpoint
CREATE TABLE "drafts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"compose_mode" text NOT NULL,
	"source" jsonb,
	"to" text DEFAULT '' NOT NULL,
	"cc" text DEFAULT '' NOT NULL,
	"bcc" text DEFAULT '' NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"plain_text" text DEFAULT '' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"outgoing_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drafts_mode" CHECK ("drafts"."compose_mode" in ('new', 'reply', 'reply_all', 'forward')),
	CONSTRAINT "drafts_status" CHECK ("drafts"."status" in ('active', 'consumed')),
	CONSTRAINT "drafts_revision" CHECK ("drafts"."revision" > 0),
	CONSTRAINT "drafts_handoff" CHECK (("drafts"."status" = 'consumed') = ("drafts"."outgoing_message_id" is not null)),
	CONSTRAINT "drafts_source" CHECK (("drafts"."compose_mode" = 'new' and "drafts"."source" is null) or ("drafts"."compose_mode" <> 'new' and "drafts"."source" is not null and "drafts"."source"->>'mode' = "drafts"."compose_mode"))
);
--> statement-breakpoint
ALTER TABLE "draft_attachments" ADD CONSTRAINT "draft_attachments_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_attachments" ADD CONSTRAINT "draft_attachments_blob_id_blobs_id_fk" FOREIGN KEY ("blob_id") REFERENCES "public"."blobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_outgoing_message_id_outgoing_messages_id_fk" FOREIGN KEY ("outgoing_message_id") REFERENCES "public"."outgoing_messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "draft_attachments_position" ON "draft_attachments" USING btree ("draft_id","position");--> statement-breakpoint
CREATE INDEX "draft_attachments_blob_idx" ON "draft_attachments" USING btree ("blob_id");--> statement-breakpoint
CREATE INDEX "drafts_active_updated_idx" ON "drafts" USING btree ("status","updated_at");