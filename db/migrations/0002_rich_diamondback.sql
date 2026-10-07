CREATE TABLE "mailboxes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"remote_path" text NOT NULL,
	"name" text NOT NULL,
	"delimiter" text,
	"attributes" text[] DEFAULT '{}' NOT NULL,
	"special_use" text[] DEFAULT '{}' NOT NULL,
	"selectable" boolean NOT NULL,
	"subscribed" boolean,
	"provider_mailbox_id" text,
	"uid_validity" bigint,
	"uid_next" bigint,
	"highest_modseq" bigint,
	"reported_message_count" bigint,
	"reported_unseen_count" bigint,
	"lifecycle_status" text DEFAULT 'active' NOT NULL,
	"first_discovered_at" timestamp with time zone NOT NULL,
	"last_discovered_at" timestamp with time zone NOT NULL,
	"missing_since" timestamp with time zone,
	"uid_validity_changed_at" timestamp with time zone,
	"uid_validity_change_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailboxes_lifecycle_status" CHECK ("mailboxes"."lifecycle_status" in ('active', 'missing'))
);
--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD COLUMN "mailbox_discovery_status" text DEFAULT 'not_started' NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD COLUMN "mailbox_discovery_error" text;--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD COLUMN "mailbox_discovery_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD COLUMN "mailbox_discovery_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD COLUMN "last_successful_mailbox_discovery_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD COLUMN "imap_capabilities" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mailboxes_account_idx" ON "mailboxes" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "mailboxes_account_path_idx" ON "mailboxes" USING btree ("account_id","remote_path");--> statement-breakpoint
CREATE UNIQUE INDEX "mailboxes_account_provider_id_unique" ON "mailboxes" USING btree ("account_id","provider_mailbox_id") WHERE "mailboxes"."provider_mailbox_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "mailboxes_account_path_without_provider_id_unique" ON "mailboxes" USING btree ("account_id","remote_path") WHERE "mailboxes"."provider_mailbox_id" is null;--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD CONSTRAINT "mail_accounts_mailbox_discovery_status" CHECK ("mail_accounts"."mailbox_discovery_status" in ('not_started', 'pending', 'running', 'success', 'failed'));