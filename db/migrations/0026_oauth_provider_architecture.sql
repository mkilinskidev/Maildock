CREATE TABLE "oauth_provider_configs" (
	"provider_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"client_id" text NOT NULL,
	"encrypted_client_secret" jsonb,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mail_accounts" DROP CONSTRAINT "mail_accounts_auth_credential";--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD COLUMN "oauth_provider_id" text;--> statement-breakpoint
ALTER TABLE "oauth_authorization_states" ADD COLUMN "provider_id" text;
--> statement-breakpoint
UPDATE "oauth_authorization_states" SET "provider_id" = 'microsoft';
--> statement-breakpoint
ALTER TABLE "oauth_authorization_states" ALTER COLUMN "provider_id" SET NOT NULL;
--> statement-breakpoint
UPDATE "mail_accounts" SET "oauth_provider_id" = 'microsoft' WHERE "auth_method" = 'oauth2';--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD CONSTRAINT "mail_accounts_auth_credential" CHECK (("mail_accounts"."auth_method" = 'password' and "mail_accounts"."oauth_provider_id" is null and "mail_accounts"."imap_password" is not null and "mail_accounts"."oauth_cache" is null and "mail_accounts"."oauth_home_account_id" is null and "mail_accounts"."oauth_status" is null) or ("mail_accounts"."auth_method" = 'oauth2' and "mail_accounts"."oauth_provider_id" is not null and "mail_accounts"."imap_password" is null and "mail_accounts"."smtp_password" is null and "mail_accounts"."oauth_cache" is not null and "mail_accounts"."oauth_status" in ('connected', 'reconnect_required')));