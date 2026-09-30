ALTER TABLE "mailboxes" ADD COLUMN "delta_uid_validity" bigint;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "delta_last_seen_uid" bigint;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "delta_highest_modseq" bigint;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "delta_sync_status" text DEFAULT 'not_started' NOT NULL;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "delta_sync_error" text;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "delta_sync_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "delta_sync_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "last_successful_delta_sync_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_delta_sync_status" CHECK ("mailboxes"."delta_sync_status" in ('not_started', 'pending', 'running', 'success', 'failed'));