ALTER TABLE "mailboxes" ADD COLUMN "backfill_uid_validity" bigint;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "backfill_frontier_uid" bigint;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "backfill_status" text DEFAULT 'not_started' NOT NULL;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "backfill_error" text;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "backfill_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_backfill_status" CHECK ("mailboxes"."backfill_status" in ('not_started', 'pending', 'running', 'complete', 'failed'));