CREATE TABLE "message_contents" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'not_fetched' NOT NULL,
	"plain_text" text,
	"sanitized_html" text,
	"remote_content_blocked" boolean DEFAULT false NOT NULL,
	"policy_version" text,
	"error" text,
	"fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_contents_status" CHECK ("message_contents"."status" in ('not_fetched', 'pending', 'fetching', 'ready', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "message_contents" ADD CONSTRAINT "message_contents_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;