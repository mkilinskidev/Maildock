CREATE TABLE "mailbox_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"mailbox_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"uid_validity" bigint NOT NULL,
	"uid" bigint NOT NULL,
	"modseq" bigint,
	"flags" text[] DEFAULT '{}' NOT NULL,
	"first_synchronized_at" timestamp with time zone NOT NULL,
	"last_synchronized_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"provider_message_id" text,
	"rfc_message_id" text,
	"subject" text,
	"sent_at" timestamp with time zone,
	"internal_date" timestamp with time zone NOT NULL,
	"size" bigint NOT NULL,
	"from" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sender" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reply_to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bcc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"in_reply_to" text,
	"mime_structure" jsonb,
	"has_attachments" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "recent_sync_status" text DEFAULT 'not_started' NOT NULL;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "recent_sync_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "recent_sync_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "recent_sync_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "recent_sync_error" text;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "recent_sync_cutoff" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "recent_sync_message_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "last_successful_recent_sync_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mailbox_messages" ADD CONSTRAINT "mailbox_messages_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_messages" ADD CONSTRAINT "mailbox_messages_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_messages_remote_identity_unique" ON "mailbox_messages" USING btree ("mailbox_id","uid_validity","uid");--> statement-breakpoint
CREATE INDEX "mailbox_messages_mailbox_idx" ON "mailbox_messages" USING btree ("mailbox_id");--> statement-breakpoint
CREATE INDEX "mailbox_messages_message_idx" ON "mailbox_messages" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "messages_account_internal_date_idx" ON "messages" USING btree ("account_id","internal_date");--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_recent_sync_status" CHECK ("mailboxes"."recent_sync_status" in ('not_started', 'pending', 'running', 'success', 'failed'));