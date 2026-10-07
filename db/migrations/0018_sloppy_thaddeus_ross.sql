CREATE TABLE "remote_content_senders" (
	"address" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
