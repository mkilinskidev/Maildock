CREATE TABLE "mailbox_roles" (
	"account_id" uuid NOT NULL,
	"role" text NOT NULL,
	"mailbox_id" uuid NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailbox_roles_account_id_role_pk" PRIMARY KEY("account_id","role"),
	CONSTRAINT "mailbox_roles_role" CHECK ("mailbox_roles"."role" in ('archive', 'trash', 'sent', 'drafts', 'junk')),
	CONSTRAINT "mailbox_roles_source" CHECK ("mailbox_roles"."source" in ('special_use', 'manual'))
);
--> statement-breakpoint
ALTER TABLE "mailbox_roles" ADD CONSTRAINT "mailbox_roles_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_roles" ADD CONSTRAINT "mailbox_roles_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mailbox_roles_mailbox_idx" ON "mailbox_roles" USING btree ("mailbox_id");
--> statement-breakpoint
WITH role_attributes(role, attribute) AS (
  VALUES ('archive', '\Archive'), ('trash', '\Trash'), ('sent', '\Sent'), ('drafts', '\Drafts'), ('junk', '\Junk')
), candidates AS (
  SELECT m.account_id, r.role, min(m.id::text)::uuid AS mailbox_id, count(*) AS candidate_count
  FROM mailboxes m
  CROSS JOIN role_attributes r
  WHERE m.lifecycle_status = 'active' AND m.selectable AND r.attribute = ANY(m.special_use)
  GROUP BY m.account_id, r.role
)
INSERT INTO mailbox_roles (account_id, role, mailbox_id, source)
SELECT account_id, role, mailbox_id, 'special_use'
FROM candidates WHERE candidate_count = 1;
