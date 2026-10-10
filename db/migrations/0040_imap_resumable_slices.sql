ALTER TABLE "mailboxes" ADD COLUMN "imap_recent_progress" jsonb;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "imap_delta_progress" jsonb;