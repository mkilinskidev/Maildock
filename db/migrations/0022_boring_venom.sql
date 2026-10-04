ALTER TABLE "mail_accounts" ADD COLUMN "sender_display_name" text DEFAULT '' NOT NULL;
--> statement-breakpoint
UPDATE "mail_accounts" SET "sender_display_name" = "display_name";
