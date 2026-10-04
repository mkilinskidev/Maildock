CREATE TABLE "account_signature_defaults" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"new_signature_id" uuid,
	"reply_signature_id" uuid,
	"forward_signature_id" uuid
);
--> statement-breakpoint
CREATE TABLE "signature_resources" (
	"signature_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"blob_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	CONSTRAINT "signature_resources_signature_id_id_pk" PRIMARY KEY("signature_id","id")
);
--> statement-breakpoint
CREATE TABLE "signatures" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"rich_document" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_signature_defaults" ADD CONSTRAINT "account_signature_defaults_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_signature_defaults" ADD CONSTRAINT "account_signature_defaults_new_signature_id_signatures_id_fk" FOREIGN KEY ("new_signature_id") REFERENCES "public"."signatures"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_signature_defaults" ADD CONSTRAINT "account_signature_defaults_reply_signature_id_signatures_id_fk" FOREIGN KEY ("reply_signature_id") REFERENCES "public"."signatures"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_signature_defaults" ADD CONSTRAINT "account_signature_defaults_forward_signature_id_signatures_id_fk" FOREIGN KEY ("forward_signature_id") REFERENCES "public"."signatures"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature_resources" ADD CONSTRAINT "signature_resources_signature_id_signatures_id_fk" FOREIGN KEY ("signature_id") REFERENCES "public"."signatures"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature_resources" ADD CONSTRAINT "signature_resources_blob_id_blobs_id_fk" FOREIGN KEY ("blob_id") REFERENCES "public"."blobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "signature_resources_blob_idx" ON "signature_resources" USING btree ("blob_id");