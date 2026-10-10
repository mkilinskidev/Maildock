CREATE TABLE "sync_account_admission" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"last_admitted_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_admission_policy" (
	"id" integer PRIMARY KEY NOT NULL,
	"p0_admissions" integer DEFAULT 0 NOT NULL,
	"last_lower_class" integer DEFAULT 2 NOT NULL,
	CONSTRAINT "sync_admission_policy_singleton" CHECK ("sync_admission_policy"."id"=1)
);
--> statement-breakpoint
INSERT INTO "sync_admission_policy" ("id") VALUES (1);
--> statement-breakpoint
ALTER TABLE "sync_account_admission" ADD CONSTRAINT "sync_account_admission_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;
