CREATE TABLE "owner_recovery" (
	"id" integer PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"generation_id" uuid NOT NULL,
	"factor_id" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"token_digest" text,
	"expires_at" timestamp with time zone,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "owner_recovery_singleton" CHECK ("owner_recovery"."id" = 1),
	CONSTRAINT "owner_recovery_attempts" CHECK ("owner_recovery"."failed_attempts" between 0 and 5),
	CONSTRAINT "owner_recovery_token" CHECK (("owner_recovery"."token_digest" is null and "owner_recovery"."expires_at" is null) or ("owner_recovery"."token_digest" ~ '^[0-9a-f]{64}$' and "owner_recovery"."token_digest" is not null and "owner_recovery"."expires_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "owner_recovery" ADD CONSTRAINT "owner_recovery_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "owner_recovery" ADD CONSTRAINT "owner_recovery_factor_id_two_factor_id_fk" FOREIGN KEY ("factor_id") REFERENCES "public"."two_factor"("id") ON DELETE restrict ON UPDATE restrict;