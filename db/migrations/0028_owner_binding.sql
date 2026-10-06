ALTER TABLE "instance_state" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
-- Drizzle applies this migration transactionally. Freeze the legacy candidate
-- set until validation, backfill and constraints have committed.
LOCK TABLE "user", "account" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE
  initialized timestamp with time zone;
  user_count bigint;
  candidate text;
BEGIN
  IF (SELECT count(*) FROM instance_state) <> 1 THEN
    RAISE EXCEPTION 'F10 owner binding migration rejected inconsistent instance state';
  END IF;
  SELECT initialized_at INTO initialized FROM instance_state WHERE id = 1;
  SELECT count(*) INTO user_count FROM "user";
  IF initialized IS NULL THEN
    IF user_count <> 0 OR EXISTS (SELECT 1 FROM account) THEN
      RAISE EXCEPTION 'F10 owner binding migration rejected uninitialized auth state';
    END IF;
  ELSE
    IF user_count <> 1 THEN
      RAISE EXCEPTION 'F10 owner binding migration requires exactly one provisioned user';
    END IF;
    -- Cardinality was established above. These are legacy provisioning
    -- consistency checks, never runtime ownership selectors.
    SELECT u.id INTO candidate FROM "user" u
    WHERE u.id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND u.email = 'owner@localhost.invalid' AND u.email_verified
      AND u.username ~ '^[a-z0-9_.-]{3,64}$'
      AND u.created_at = initialized
      AND (SELECT count(*) FROM account) = 1
      AND EXISTS (
        SELECT 1 FROM account a WHERE a.user_id = u.id
          AND a.account_id = u.id AND a.provider_id = 'credential'
          AND a.password LIKE '$argon2id$%' AND a.created_at = initialized
      )
      AND EXISTS (
        SELECT 1 FROM instance_state WHERE id = 1
          AND password_algorithm = 'argon2id' AND password_parameters IS NOT NULL
      );
    IF candidate IS NULL THEN
      RAISE EXCEPTION 'F10 owner binding migration rejected inconsistent owner provisioning';
    END IF;
    UPDATE instance_state SET owner_user_id = candidate WHERE id = 1;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "instance_state" ADD CONSTRAINT "instance_state_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "instance_state" ADD CONSTRAINT "instance_state_owner_binding" CHECK (("instance_state"."initialized_at" is null and "instance_state"."owner_user_id" is null) or ("instance_state"."initialized_at" is not null and "instance_state"."owner_user_id" is not null and length(trim("instance_state"."owner_user_id")) > 0 and "instance_state"."owner_user_id" = trim("instance_state"."owner_user_id")));
