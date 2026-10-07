CREATE TABLE "oauth_authorization_states" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"code_verifier" jsonb NOT NULL,
	"account_id" uuid,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mail_accounts" ALTER COLUMN "imap_password" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD COLUMN "auth_method" text DEFAULT 'password' NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD COLUMN "oauth_cache" jsonb;--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD COLUMN "oauth_home_account_id" text;--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD COLUMN "oauth_status" text;--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD CONSTRAINT "mail_accounts_auth_credential" CHECK (("mail_accounts"."auth_method" = 'password' and "mail_accounts"."imap_password" is not null and "mail_accounts"."oauth_cache" is null and "mail_accounts"."oauth_home_account_id" is null and "mail_accounts"."oauth_status" is null) or ("mail_accounts"."auth_method" = 'oauth2' and "mail_accounts"."imap_password" is null and "mail_accounts"."smtp_password" is null and "mail_accounts"."oauth_cache" is not null and "mail_accounts"."oauth_home_account_id" is not null and "mail_accounts"."oauth_status" in ('connected', 'reconnect_required')));