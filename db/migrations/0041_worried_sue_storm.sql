ALTER TABLE "gmail_account_sync_state" ADD COLUMN "history_drain_due" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "gmail_account_sync_state" ADD COLUMN "history_discovered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gmail_account_sync_state" ADD COLUMN "priority_burst" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "gmail_account_sync_state" ADD COLUMN "last_lower_priority" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "gmail_sync_work" ADD COLUMN "priority_class" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "gmail_sync_work" SET "priority_class"=2 WHERE "purpose"='inventory';--> statement-breakpoint
CREATE INDEX "gmail_work_priority_idx" ON "gmail_sync_work" USING btree ("account_id","run_id","status","priority_class","created_at");--> statement-breakpoint
ALTER TABLE "gmail_sync_work" ADD CONSTRAINT "gmail_work_priority" CHECK ("gmail_sync_work"."priority_class" between 0 and 2);
