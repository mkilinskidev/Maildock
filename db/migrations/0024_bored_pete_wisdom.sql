CREATE TABLE "notification_events" (
	"sequence" bigint PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"mailbox_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"uid_validity" bigint NOT NULL,
	"uid" bigint NOT NULL,
	"sender" text NOT NULL,
	"subject" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "instance_state" ADD COLUMN "notification_preferences" jsonb DEFAULT '{"enabled":false,"folders":"inbox","accountIds":null,"backgroundOnly":true}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "instance_state" ADD COLUMN "notification_sequence" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "instance_state" ADD COLUMN "notification_checkpoint" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_events_remote_identity" ON "notification_events" USING btree ("mailbox_id","uid_validity","uid");--> statement-breakpoint
CREATE INDEX "notification_events_created_idx" ON "notification_events" USING btree ("created_at");