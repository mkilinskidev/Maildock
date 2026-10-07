CREATE SEQUENCE "public"."mail_account_order_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1;--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD COLUMN "sort_order" integer DEFAULT nextval('mail_account_order_seq') NOT NULL;--> statement-breakpoint
-- Preserve the previous creation-date ordering, with a stable tie-breaker.
WITH ordered AS (
  SELECT id, row_number() OVER (ORDER BY created_at, id)::integer AS position
  FROM mail_accounts
)
UPDATE mail_accounts SET sort_order = ordered.position
FROM ordered WHERE mail_accounts.id = ordered.id;--> statement-breakpoint
-- The third argument keeps the first allocation at 1 on an empty installation.
SELECT setval('mail_account_order_seq',
  COALESCE((SELECT max(sort_order) FROM mail_accounts), 1),
  EXISTS (SELECT 1 FROM mail_accounts));--> statement-breakpoint
ALTER SEQUENCE "mail_account_order_seq" OWNED BY "mail_accounts"."sort_order";--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD CONSTRAINT "mail_accounts_sort_order" CHECK ("mail_accounts"."sort_order" > 0);