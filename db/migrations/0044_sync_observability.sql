CREATE TABLE "sync_observations" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"account_revision" bigint NOT NULL,
	"operation_token" uuid,
	"phase" text,
	"priority" integer,
	"active_until" timestamp with time zone,
	"last_check_at" timestamp with time zone,
	"last_materialized_at" timestamp with time zone,
	"last_refusal" jsonb,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sync_observations" ADD CONSTRAINT "sync_observations_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;