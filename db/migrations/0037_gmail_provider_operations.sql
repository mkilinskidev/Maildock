ALTER TABLE "gmail_account_sync_state" ADD COLUMN "quota_day" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "gmail_account_sync_state" ADD COLUMN "quota_daily_units" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "gmail_account_sync_state" ADD COLUMN "inventory_page_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "gmail_account_sync_state" ADD COLUMN "inventory_token_trail" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "gmail_account_sync_state" ADD COLUMN "history_page_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "gmail_account_sync_state" ADD COLUMN "history_token_trail" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "gmail_account_sync_state" ADD CONSTRAINT "gmail_sync_budgets" CHECK ("gmail_account_sync_state"."quota_day" >= 0 and "gmail_account_sync_state"."quota_daily_units" >= 0 and "gmail_account_sync_state"."inventory_page_count" between 0 and 100000 and "gmail_account_sync_state"."history_page_count" between 0 and 100000 and cardinality("gmail_account_sync_state"."inventory_token_trail") <= 32 and cardinality("gmail_account_sync_state"."history_token_trail") <= 32);
--> statement-breakpoint
ALTER TABLE "message_commands" DROP CONSTRAINT "message_commands_action";--> statement-breakpoint
ALTER TABLE "message_commands" ADD CONSTRAINT "message_commands_action" CHECK ("message_commands"."action" in ('mark_read', 'mark_unread', 'flag', 'unflag', 'archive', 'trash', 'move'));
--> statement-breakpoint
ALTER TABLE "gmail_account_sync_state" ADD COLUMN "history_page_offset" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "gmail_account_sync_state" ADD COLUMN "history_page_digest" text;
--> statement-breakpoint
ALTER TABLE "gmail_account_sync_state" ADD CONSTRAINT "gmail_sync_fragment" CHECK ("gmail_account_sync_state"."history_page_offset" between 0 and 100000 and (("gmail_account_sync_state"."history_page_offset"=0 and "gmail_account_sync_state"."history_page_digest" is null) or ("gmail_account_sync_state"."history_page_offset">0 and "gmail_account_sync_state"."history_page_digest" is not null and "gmail_account_sync_state"."history_page_digest" ~ '^[a-f0-9]{64}$')));
--> statement-breakpoint
ALTER TABLE "message_commands" DROP CONSTRAINT "message_commands_action";--> statement-breakpoint
ALTER TABLE "message_commands" ADD CONSTRAINT "message_commands_action" CHECK ("message_commands"."action" in ('mark_read', 'mark_unread', 'flag', 'unflag', 'archive', 'trash') or ("message_commands"."action" = 'move' and "message_commands"."receive_transport" = 'gmail' and "message_commands"."destination_mailbox_id" is not null));