-- Native receiving is a fresh-install release. This repeats the read-only
-- pre-migration guard for direct Drizzle callers, before incompatible DDL.
DO $$
DECLARE t record; populated boolean;
BEGIN
  FOR t IN SELECT c.relname FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p')
  LOOP
    IF t.relname = 'instance_state' THEN
      SELECT EXISTS(SELECT FROM public.instance_state WHERE initialized_at IS NOT NULL) INTO populated;
    ELSE
      EXECUTE format('SELECT EXISTS(SELECT FROM public.%I LIMIT 1)', t.relname) INTO populated;
    END IF;
    IF populated THEN
      RAISE EXCEPTION 'Native Gmail release requires a separate fresh database. Populated legacy installation refused; restore it only with its matched legacy binary. No data was erased.';
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint
CREATE TABLE "gmail_account_sync_state" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"receive_transport" text DEFAULT 'gmail' NOT NULL,
	"account_revision" bigint NOT NULL,
	"status" text DEFAULT 'not_started' NOT NULL,
	"recent_ready" boolean DEFAULT false NOT NULL,
	"inventory_complete" boolean DEFAULT false NOT NULL,
	"history_id" text,
	"baseline_history_id" text,
	"inventory_generation" bigint DEFAULT 1 NOT NULL,
	"inventory_run_id" uuid,
	"inventory_phase" text,
	"recent_cutoff" timestamp with time zone,
	"historical_before" timestamp with time zone,
	"inventory_next_page_token" text,
	"inventory_pages_complete" boolean DEFAULT false NOT NULL,
	"history_run_id" uuid,
	"history_start_id" text,
	"history_next_page_token" text,
	"history_candidate_id" text,
	"history_pages_complete" boolean DEFAULT false NOT NULL,
	"needs_work" boolean DEFAULT true NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"error_category" text,
	"processed_count" bigint DEFAULT 0 NOT NULL,
	"quota_minute" bigint DEFAULT 0 NOT NULL,
	"quota_current_units" bigint DEFAULT 0 NOT NULL,
	"quota_previous_units" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gmail_sync_transport" CHECK ("gmail_account_sync_state"."receive_transport" = 'gmail'),
	CONSTRAINT "gmail_sync_status" CHECK ("gmail_account_sync_state"."status" in ('not_started', 'initializing', 'ready', 'reconcile_required', 'reconciling', 'blocked')),
	CONSTRAINT "gmail_sync_counters" CHECK ("gmail_account_sync_state"."account_revision" > 0 and "gmail_account_sync_state"."inventory_generation" > 0 and "gmail_account_sync_state"."processed_count" >= 0 and "gmail_account_sync_state"."quota_minute" >= 0 and "gmail_account_sync_state"."quota_current_units" >= 0 and "gmail_account_sync_state"."quota_previous_units" >= 0),
	CONSTRAINT "gmail_sync_history_ids" CHECK (("gmail_account_sync_state"."history_id" is null or "gmail_account_sync_state"."history_id" ~ '^[0-9]+$') and ("gmail_account_sync_state"."baseline_history_id" is null or "gmail_account_sync_state"."baseline_history_id" ~ '^[0-9]+$') and ("gmail_account_sync_state"."history_start_id" is null or "gmail_account_sync_state"."history_start_id" ~ '^[0-9]+$') and ("gmail_account_sync_state"."history_candidate_id" is null or "gmail_account_sync_state"."history_candidate_id" ~ '^[0-9]+$')),
	CONSTRAINT "gmail_sync_history_run" CHECK (("gmail_account_sync_state"."history_run_id" is null and "gmail_account_sync_state"."history_start_id" is null and "gmail_account_sync_state"."history_next_page_token" is null and "gmail_account_sync_state"."history_candidate_id" is null and not "gmail_account_sync_state"."history_pages_complete") or ("gmail_account_sync_state"."history_run_id" is not null and "gmail_account_sync_state"."history_start_id" is not null and (not "gmail_account_sync_state"."history_pages_complete" or ("gmail_account_sync_state"."history_candidate_id" is not null and "gmail_account_sync_state"."history_next_page_token" is null)))),
	CONSTRAINT "gmail_sync_inventory_run" CHECK (("gmail_account_sync_state"."inventory_run_id" is null and "gmail_account_sync_state"."inventory_phase" is null and "gmail_account_sync_state"."inventory_next_page_token" is null and not "gmail_account_sync_state"."inventory_pages_complete") or ("gmail_account_sync_state"."inventory_run_id" is not null and "gmail_account_sync_state"."baseline_history_id" is not null and "gmail_account_sync_state"."inventory_phase" is not null and "gmail_account_sync_state"."inventory_phase" in ('recent', 'historical', 'reconcile') and "gmail_account_sync_state"."recent_cutoff" is not null and (not "gmail_account_sync_state"."inventory_pages_complete" or "gmail_account_sync_state"."inventory_next_page_token" is null))),
	CONSTRAINT "gmail_sync_error_category" CHECK ("gmail_account_sync_state"."error_category" is null or "gmail_account_sync_state"."error_category" in ('unsupported', 'authentication', 'api_disabled', 'quota', 'network', 'history_expired', 'invalid_response'))
);
--> statement-breakpoint
CREATE TABLE "gmail_sync_work" (
	"account_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"gmail_message_id" text NOT NULL,
	"account_revision" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error_category" text,
	"next_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gmail_sync_work_account_id_run_id_purpose_gmail_message_id_pk" PRIMARY KEY("account_id","run_id","purpose","gmail_message_id"),
	CONSTRAINT "gmail_work_identity" CHECK (length("gmail_sync_work"."gmail_message_id") > 0 and "gmail_sync_work"."account_revision" > 0),
	CONSTRAINT "gmail_work_purpose" CHECK ("gmail_sync_work"."purpose" in ('inventory', 'history')),
	CONSTRAINT "gmail_work_status" CHECK ("gmail_sync_work"."status" in ('pending', 'retry', 'complete') and "gmail_sync_work"."attempts" between 0 and 100),
	CONSTRAINT "gmail_work_error" CHECK ("gmail_sync_work"."error_category" is null or "gmail_sync_work"."error_category" in ('authentication', 'api_disabled', 'quota', 'network', 'invalid_response'))
);
--> statement-breakpoint
ALTER TABLE "mail_accounts" DROP CONSTRAINT "mail_accounts_provider_type";--> statement-breakpoint
ALTER TABLE "mail_accounts" DROP CONSTRAINT "mail_accounts_smtp_credentials";--> statement-breakpoint
ALTER TABLE "mail_accounts" DROP CONSTRAINT "mail_accounts_auth_credential";--> statement-breakpoint
ALTER TABLE "message_attachments" DROP CONSTRAINT "message_attachments_source_mailbox_id_mailboxes_id_fk";
--> statement-breakpoint
DROP INDEX "mailbox_messages_remote_identity_unique";--> statement-breakpoint
DROP INDEX "notification_events_remote_identity";--> statement-breakpoint
ALTER TABLE "mail_accounts" ALTER COLUMN "imap_host" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_accounts" ALTER COLUMN "imap_port" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_accounts" ALTER COLUMN "imap_security" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_accounts" ALTER COLUMN "imap_username" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "mailbox_messages" ALTER COLUMN "uid_validity" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "mailbox_messages" ALTER COLUMN "uid" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "message_attachments" ALTER COLUMN "source_uid_validity" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "message_attachments" ALTER COLUMN "source_uid" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "message_commands" ALTER COLUMN "source_path" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "message_commands" ALTER COLUMN "source_uid_validity" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "message_commands" ALTER COLUMN "source_uid" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_events" ALTER COLUMN "uid_validity" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_events" ALTER COLUMN "uid" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD COLUMN "receive_transport" text GENERATED ALWAYS AS (case when provider_type = 'gmail_smtp' then 'gmail' else 'imap' end) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD COLUMN "work_revision" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "mailbox_messages" ADD COLUMN "receive_transport" text DEFAULT 'imap' NOT NULL;--> statement-breakpoint
ALTER TABLE "mailbox_messages" ADD COLUMN "account_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "receive_transport" text DEFAULT 'imap' NOT NULL;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "view_kind" text DEFAULT 'remote' NOT NULL;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD COLUMN "receive_transport" text DEFAULT 'imap' NOT NULL;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD COLUMN "account_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD COLUMN "source_account_id" uuid;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD COLUMN "gmail_attachment_id" text;--> statement-breakpoint
ALTER TABLE "message_commands" ADD COLUMN "receive_transport" text DEFAULT 'imap' NOT NULL;--> statement-breakpoint
ALTER TABLE "message_commands" ADD COLUMN "account_revision" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "message_commands" ADD COLUMN "intent_sequence" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "receive_transport" text DEFAULT 'imap' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "provider_thread_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "provider_history_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "remote_missing_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "inventory_generation" bigint;--> statement-breakpoint
ALTER TABLE "notification_events" ADD COLUMN "receive_transport" text DEFAULT 'imap' NOT NULL;--> statement-breakpoint
ALTER TABLE "outgoing_messages" ADD COLUMN "sent_copy_message_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "mail_accounts_transport_unique" ON "mail_accounts" USING btree ("id","receive_transport");--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_messages_gmail_membership_unique" ON "mailbox_messages" USING btree ("mailbox_id","message_id") WHERE "mailbox_messages"."receive_transport" = 'gmail';--> statement-breakpoint
CREATE UNIQUE INDEX "mailboxes_gmail_label_unique" ON "mailboxes" USING btree ("account_id","provider_mailbox_id") WHERE "mailboxes"."receive_transport" = 'gmail' and "mailboxes"."view_kind" = 'remote';--> statement-breakpoint
CREATE UNIQUE INDEX "mailboxes_gmail_virtual_unique" ON "mailboxes" USING btree ("account_id","view_kind") WHERE "mailboxes"."receive_transport" = 'gmail' and "mailboxes"."view_kind" = 'all_mail';--> statement-breakpoint
CREATE UNIQUE INDEX "mailboxes_account_transport_unique" ON "mailboxes" USING btree ("account_id","id","receive_transport");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_gmail_identity_unique" ON "messages" USING btree ("account_id","provider_message_id") WHERE "messages"."receive_transport" = 'gmail';--> statement-breakpoint
CREATE UNIQUE INDEX "messages_account_transport_unique" ON "messages" USING btree ("account_id","id","receive_transport");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_events_gmail_identity_unique" ON "notification_events" USING btree ("account_id","message_id") WHERE "notification_events"."receive_transport" = 'gmail';--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_messages_remote_identity_unique" ON "mailbox_messages" USING btree ("mailbox_id","uid_validity","uid") WHERE "mailbox_messages"."receive_transport" = 'imap';--> statement-breakpoint
CREATE UNIQUE INDEX "notification_events_remote_identity" ON "notification_events" USING btree ("mailbox_id","uid_validity","uid") WHERE "notification_events"."receive_transport" = 'imap';--> statement-breakpoint
ALTER TABLE "gmail_account_sync_state" ADD CONSTRAINT "gmail_sync_account_transport_fk" FOREIGN KEY ("account_id","receive_transport") REFERENCES "public"."mail_accounts"("id","receive_transport") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_sync_work" ADD CONSTRAINT "gmail_sync_work_account_id_gmail_account_sync_state_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."gmail_account_sync_state"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gmail_sync_due_idx" ON "gmail_account_sync_state" USING btree ("needs_work","next_attempt_at");--> statement-breakpoint
CREATE INDEX "gmail_work_due_idx" ON "gmail_sync_work" USING btree ("account_id","run_id","status","next_attempt_at");--> statement-breakpoint
ALTER TABLE "mailbox_messages" ADD CONSTRAINT "mailbox_messages_mailbox_transport_fk" FOREIGN KEY ("account_id","mailbox_id","receive_transport") REFERENCES "public"."mailboxes"("account_id","id","receive_transport") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_messages" ADD CONSTRAINT "mailbox_messages_message_transport_fk" FOREIGN KEY ("account_id","message_id","receive_transport") REFERENCES "public"."messages"("account_id","id","receive_transport") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_account_transport_fk" FOREIGN KEY ("account_id","receive_transport") REFERENCES "public"."mail_accounts"("id","receive_transport") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_message_transport_fk" FOREIGN KEY ("account_id","message_id","receive_transport") REFERENCES "public"."messages"("account_id","id","receive_transport") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_source_transport_fk" FOREIGN KEY ("source_account_id","source_mailbox_id","receive_transport") REFERENCES "public"."mailboxes"("account_id","id","receive_transport") ON DELETE set null ("source_account_id", "source_mailbox_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_commands" ADD CONSTRAINT "message_commands_message_transport_fk" FOREIGN KEY ("account_id","message_id","receive_transport") REFERENCES "public"."messages"("account_id","id","receive_transport") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_commands" ADD CONSTRAINT "message_commands_mailbox_transport_fk" FOREIGN KEY ("account_id","mailbox_id","receive_transport") REFERENCES "public"."mailboxes"("account_id","id","receive_transport") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_account_transport_fk" FOREIGN KEY ("account_id","receive_transport") REFERENCES "public"."mail_accounts"("id","receive_transport") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_message_transport_fk" FOREIGN KEY ("account_id","message_id","receive_transport") REFERENCES "public"."messages"("account_id","id","receive_transport") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_mailbox_transport_fk" FOREIGN KEY ("account_id","mailbox_id","receive_transport") REFERENCES "public"."mailboxes"("account_id","id","receive_transport") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outgoing_messages" ADD CONSTRAINT "outgoing_messages_native_sent_fk" FOREIGN KEY ("account_id","sent_copy_message_id") REFERENCES "public"."messages"("account_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_commands_intent_idx" ON "message_commands" USING btree ("account_id","message_id","intent_sequence");--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD CONSTRAINT "mail_accounts_work_revision" CHECK ("mail_accounts"."work_revision" > 0);--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD CONSTRAINT "mail_accounts_receive_identity" CHECK (("mail_accounts"."provider_type" = 'imap_smtp' and ("mail_accounts"."auth_method" = 'password' or ("mail_accounts"."auth_method" = 'oauth2' and "mail_accounts"."oauth_provider_id" is not null and "mail_accounts"."oauth_provider_id" = 'microsoft')) and "mail_accounts"."imap_host" is not null and length("mail_accounts"."imap_host") > 0 and "mail_accounts"."imap_port" is not null and "mail_accounts"."imap_security" is not null and "mail_accounts"."imap_username" is not null and length("mail_accounts"."imap_username") > 0) or ("mail_accounts"."provider_type" = 'gmail_smtp' and "mail_accounts"."auth_method" = 'oauth2' and "mail_accounts"."oauth_provider_id" is not null and "mail_accounts"."oauth_provider_id" = 'google' and "mail_accounts"."oauth_home_account_id" is not null and length("mail_accounts"."oauth_home_account_id") > 0 and "mail_accounts"."imap_host" is null and "mail_accounts"."imap_port" is null and "mail_accounts"."imap_security" is null and "mail_accounts"."imap_username" is null and cardinality("mail_accounts"."imap_capabilities") = 0 and not "mail_accounts"."smtp_uses_imap_credentials"));--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD CONSTRAINT "mail_accounts_provider_type" CHECK ("mail_accounts"."provider_type" in ('imap_smtp', 'gmail_smtp'));--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD CONSTRAINT "mail_accounts_smtp_credentials" CHECK (("mail_accounts"."smtp_uses_imap_credentials" and "mail_accounts"."smtp_username" is null and "mail_accounts"."smtp_password" is null) or (not "mail_accounts"."smtp_uses_imap_credentials" and "mail_accounts"."smtp_username" is not null and (("mail_accounts"."auth_method" = 'password' and "mail_accounts"."smtp_password" is not null) or ("mail_accounts"."auth_method" = 'oauth2' and "mail_accounts"."smtp_password" is null))));--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD CONSTRAINT "mail_accounts_auth_credential" CHECK (("mail_accounts"."auth_method" = 'password' and "mail_accounts"."oauth_provider_id" is null and "mail_accounts"."imap_password" is not null and "mail_accounts"."oauth_cache" is null and "mail_accounts"."oauth_home_account_id" is null and "mail_accounts"."oauth_status" is null) or ("mail_accounts"."auth_method" = 'oauth2' and "mail_accounts"."oauth_provider_id" is not null and "mail_accounts"."imap_password" is null and "mail_accounts"."smtp_password" is null and "mail_accounts"."oauth_cache" is not null and "mail_accounts"."oauth_status" is not null and "mail_accounts"."oauth_status" in ('connected', 'reconnect_required')));--> statement-breakpoint
ALTER TABLE "mailbox_messages" ADD CONSTRAINT "mailbox_messages_locator" CHECK (("mailbox_messages"."receive_transport" = 'imap' and "mailbox_messages"."uid" is not null and "mailbox_messages"."uid" > 0 and "mailbox_messages"."uid_validity" is not null and "mailbox_messages"."uid_validity" > 0 and ("mailbox_messages"."modseq" is null or "mailbox_messages"."modseq" > 0)) or ("mailbox_messages"."receive_transport" = 'gmail' and "mailbox_messages"."uid" is null and "mailbox_messages"."uid_validity" is null and "mailbox_messages"."modseq" is null));--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_transport_locator" CHECK (("mailboxes"."receive_transport" = 'imap' and "mailboxes"."view_kind" = 'remote') or ("mailboxes"."receive_transport" = 'gmail' and "mailboxes"."uid_validity" is null and "mailboxes"."uid_next" is null and "mailboxes"."highest_modseq" is null and "mailboxes"."recent_sync_uid_validity" is null and "mailboxes"."backfill_uid_validity" is null and "mailboxes"."backfill_frontier_uid" is null and "mailboxes"."delta_uid_validity" is null and "mailboxes"."delta_last_seen_uid" is null and "mailboxes"."delta_highest_modseq" is null and (("mailboxes"."view_kind" = 'remote' and "mailboxes"."provider_mailbox_id" is not null and length("mailboxes"."provider_mailbox_id") > 0) or ("mailboxes"."view_kind" = 'all_mail' and "mailboxes"."provider_mailbox_id" is null))));--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_locator" CHECK (("message_attachments"."receive_transport" = 'imap' and "message_attachments"."source_uid" is not null and "message_attachments"."source_uid" > 0 and "message_attachments"."source_uid_validity" is not null and "message_attachments"."source_uid_validity" > 0 and "message_attachments"."gmail_attachment_id" is null and (("message_attachments"."source_mailbox_id" is null and "message_attachments"."source_account_id" is null) or ("message_attachments"."source_mailbox_id" is not null and "message_attachments"."source_account_id" is not null and "message_attachments"."source_account_id" = "message_attachments"."account_id"))) or ("message_attachments"."receive_transport" = 'gmail' and "message_attachments"."source_mailbox_id" is null and "message_attachments"."source_account_id" is null and "message_attachments"."source_uid" is null and "message_attachments"."source_uid_validity" is null and ("message_attachments"."gmail_attachment_id" is null or length("message_attachments"."gmail_attachment_id") > 0)));--> statement-breakpoint
ALTER TABLE "message_commands" ADD CONSTRAINT "message_commands_revision_sequence" CHECK ("message_commands"."account_revision" > 0 and "message_commands"."intent_sequence" > 0);--> statement-breakpoint
ALTER TABLE "message_commands" ADD CONSTRAINT "message_commands_locator" CHECK (("message_commands"."receive_transport" = 'imap' and "message_commands"."source_path" is not null and length("message_commands"."source_path") > 0 and "message_commands"."source_uid" is not null and "message_commands"."source_uid" > 0 and "message_commands"."source_uid_validity" is not null and "message_commands"."source_uid_validity" > 0) or ("message_commands"."receive_transport" = 'gmail' and "message_commands"."source_path" is null and "message_commands"."source_uid" is null and "message_commands"."source_uid_validity" is null and "message_commands"."destination_path" is null and "message_commands"."destination_uid" is null and "message_commands"."destination_uid_validity" is null));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_native_identity" CHECK (("messages"."receive_transport" = 'imap' and "messages"."provider_thread_id" is null and "messages"."provider_history_id" is null and "messages"."inventory_generation" is null and "messages"."remote_missing_at" is null) or ("messages"."receive_transport" = 'gmail' and "messages"."provider_message_id" is not null and length("messages"."provider_message_id") > 0 and ("messages"."provider_thread_id" is null or length("messages"."provider_thread_id") > 0) and ("messages"."provider_history_id" is null or "messages"."provider_history_id" ~ '^[0-9]+$') and ("messages"."inventory_generation" is null or "messages"."inventory_generation" > 0)));--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_locator" CHECK (("notification_events"."receive_transport" = 'imap' and "notification_events"."uid" is not null and "notification_events"."uid" > 0 and "notification_events"."uid_validity" is not null and "notification_events"."uid_validity" > 0) or ("notification_events"."receive_transport" = 'gmail' and "notification_events"."uid" is null and "notification_events"."uid_validity" is null));
--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_messages_placement_transport_unique" ON "mailbox_messages" USING btree ("account_id","id","message_id","mailbox_id","receive_transport");--> statement-breakpoint
ALTER TABLE "message_commands" ADD CONSTRAINT "message_commands_destination_transport_fk" FOREIGN KEY ("account_id","destination_mailbox_id","receive_transport") REFERENCES "public"."mailboxes"("account_id","id","receive_transport") ON DELETE set null ("destination_mailbox_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_commands" ADD CONSTRAINT "message_commands_placement_transport_fk" FOREIGN KEY ("account_id","placement_id","message_id","mailbox_id","receive_transport") REFERENCES "public"."mailbox_messages"("account_id","id","message_id","mailbox_id","receive_transport") ON DELETE set null ("placement_id") ON UPDATE no action;