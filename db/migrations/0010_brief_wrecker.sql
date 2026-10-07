CREATE TABLE "message_commands" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"mailbox_id" uuid NOT NULL,
	"placement_id" uuid,
	"message_id" uuid NOT NULL,
	"action" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"source_path" text NOT NULL,
	"source_uid_validity" bigint NOT NULL,
	"source_uid" bigint NOT NULL,
	"destination_mailbox_id" uuid,
	"destination_path" text,
	"destination_uid_validity" bigint,
	"destination_uid" bigint,
	"original_flags" text[] DEFAULT '{}' NOT NULL,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_commands_action" CHECK ("message_commands"."action" in ('mark_read', 'mark_unread', 'flag', 'unflag', 'archive', 'trash')),
	CONSTRAINT "message_commands_status" CHECK ("message_commands"."status" in ('pending', 'executing', 'succeeded', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "mailbox_messages" ADD COLUMN "action_hidden" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "message_commands" ADD CONSTRAINT "message_commands_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_commands" ADD CONSTRAINT "message_commands_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_commands" ADD CONSTRAINT "message_commands_placement_id_mailbox_messages_id_fk" FOREIGN KEY ("placement_id") REFERENCES "public"."mailbox_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_commands" ADD CONSTRAINT "message_commands_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_commands" ADD CONSTRAINT "message_commands_destination_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("destination_mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_commands_placement_status_idx" ON "message_commands" USING btree ("placement_id","status");--> statement-breakpoint
CREATE INDEX "message_commands_account_created_idx" ON "message_commands" USING btree ("account_id","created_at");