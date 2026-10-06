-- Reject corrupt development state without backfilling or repairing ownership.
LOCK TABLE "instance_state", "user" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
BEGIN
  IF (SELECT count(*) FROM instance_state) <> 1 OR NOT EXISTS (
    SELECT 1 FROM instance_state s WHERE s.id = 1 AND (
      (s.initialized_at IS NULL AND s.owner_user_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM "user")) OR
      (s.initialized_at IS NOT NULL AND s.owner_user_id IS NOT NULL
        AND length(trim(s.owner_user_id)) > 0
        AND s.owner_user_id = trim(s.owner_user_id)
        AND EXISTS (SELECT 1 FROM "user" u WHERE u.id = s.owner_user_id))
    )
  ) THEN
    RAISE EXCEPTION 'F2.1 MFA migration rejected inconsistent owner state';
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE "two_factor" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"failed_verification_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "two_factor_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "two_factor_user_id_unique" ON "two_factor" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "two_factor_secret_idx" ON "two_factor" USING btree ("secret");
