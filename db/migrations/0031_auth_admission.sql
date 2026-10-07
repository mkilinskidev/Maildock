CREATE TABLE "auth_admission" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "auth_admission_key" CHECK ("auth_admission"."key" in ('work:password', 'work:mfa', 'work:management', 'manage:password', 'manage:factor')),
	CONSTRAINT "auth_admission_count" CHECK ("auth_admission"."count" between 1 and 31)
);
