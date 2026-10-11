ALTER TABLE "gmail_account_sync_state" ADD COLUMN "inbox_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gmail_account_sync_state" ADD COLUMN "inbox_next_page_token" text;--> statement-breakpoint
ALTER TABLE "gmail_account_sync_state" ADD COLUMN "inbox_pages_complete" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "gmail_account_sync_state" ADD COLUMN "inbox_synced_at" timestamp with time zone;