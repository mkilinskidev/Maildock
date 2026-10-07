CREATE OR REPLACE FUNCTION public.maildock_search_addresses(addresses jsonb) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SECURITY INVOKER AS $$
  SELECT coalesce(pg_catalog.string_agg(coalesce(a->>'name', '') || ' ' ||
    coalesce(a->>'address', '') || ' ' ||
    pg_catalog.replace(coalesce(a->>'address', ''), '@', ' ') || ' ' ||
    pg_catalog.regexp_replace(coalesce(a->>'address', ''), '[^[:alnum:]_]+', ' ', 'g'), ' '), '')
  FROM pg_catalog.jsonb_array_elements(addresses) a
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.maildock_search_vector(subject text, from_addresses jsonb,
  sender jsonb, recipients jsonb, cc jsonb, body text) RETURNS tsvector
LANGUAGE sql IMMUTABLE PARALLEL SAFE SECURITY INVOKER AS $$
  SELECT pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.simple', coalesce(subject, '')), 'A') ||
    pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.simple', public.maildock_search_addresses(from_addresses || sender)), 'B') ||
    pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.simple', public.maildock_search_addresses(recipients || cc)), 'C') ||
    pg_catalog.setweight(pg_catalog.to_tsvector('pg_catalog.simple', coalesce(body, '')), 'D')
$$;
--> statement-breakpoint
CREATE TABLE "recovery_maintenance" (
	"id" integer PRIMARY KEY NOT NULL,
	"receipt_id" uuid NOT NULL,
	"owner_user_id" text NOT NULL,
	"factor_id" text NOT NULL,
	"recovery_codes_digest" text NOT NULL,
	"status" text NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recovery_maintenance_id_check" CHECK ("recovery_maintenance"."id" = 1),
	CONSTRAINT "recovery_maintenance_status_check" CHECK ("recovery_maintenance"."status" in ('verified', 'pending_mfa'))
);
--> statement-breakpoint
ALTER TABLE "recovery_maintenance" ADD CONSTRAINT "recovery_maintenance_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE restrict;
