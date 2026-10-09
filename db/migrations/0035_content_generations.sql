ALTER TABLE "message_contents" ADD COLUMN "request_generation" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "message_contents" ADD COLUMN "fetch_attempt" uuid;