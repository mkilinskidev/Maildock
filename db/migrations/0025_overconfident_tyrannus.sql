CREATE TABLE "application_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"level" text NOT NULL,
	"area" text NOT NULL,
	"event" text NOT NULL,
	"account_id" uuid,
	"mailbox_id" uuid,
	"message" text NOT NULL,
	"details" jsonb,
	CONSTRAINT "application_events_level" CHECK ("application_events"."level" in ('info','warning','error')),
	CONSTRAINT "application_events_area" CHECK ("application_events"."area" in ('system','account','sync','imap','smtp','jobs'))
);
--> statement-breakpoint
ALTER TABLE "application_events" ADD CONSTRAINT "application_events_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_events" ADD CONSTRAINT "application_events_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_events_recent_idx" ON "application_events" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "application_events_account_idx" ON "application_events" USING btree ("account_id","created_at","id");