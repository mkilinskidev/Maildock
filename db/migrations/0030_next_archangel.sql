CREATE TABLE "mfa_replacement" (
	"owner_user_id" text PRIMARY KEY NOT NULL,
	"factor_id" text NOT NULL,
	"token_digest" text NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mfa_replacement" ADD CONSTRAINT "mfa_replacement_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;