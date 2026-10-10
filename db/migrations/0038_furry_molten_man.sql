CREATE TABLE "gmail_quota_buckets" (
	"scope" text NOT NULL,
	"kind" text NOT NULL,
	"bucket" bigint NOT NULL,
	"units" bigint NOT NULL,
	CONSTRAINT "gmail_quota_buckets_scope_kind_bucket_pk" PRIMARY KEY("scope","kind","bucket"),
	CONSTRAINT "gmail_quota_bucket_shape" CHECK ("gmail_quota_buckets"."bucket" >= 0 and "gmail_quota_buckets"."units" >= 0 and "gmail_quota_buckets"."kind" in ('second','day') and ("gmail_quota_buckets"."scope"='project' or "gmail_quota_buckets"."scope" ~ '^user:[a-f0-9]{64}$'))
);
--> statement-breakpoint
CREATE INDEX "gmail_quota_expiry_idx" ON "gmail_quota_buckets" USING btree ("kind","bucket");
--> statement-breakpoint
-- Preserve reservations made by the previous release, including reconnects.
-- Legacy minute buckets have no precise timestamps: place them at the minute's
-- end conservatively until they expire. Subsequent reservations use seconds.
INSERT INTO gmail_quota_buckets(scope,kind,bucket,units)
SELECT scopes.scope, 'second', charges.bucket, sum(charges.units)
FROM gmail_account_sync_state s JOIN mail_accounts a ON a.id=s.account_id
CROSS JOIN LATERAL (VALUES ('project'), ('user:'||encode(sha256(convert_to(a.oauth_home_account_id,'UTF8')),'hex'))) scopes(scope)
CROSS JOIN LATERAL (VALUES (s.quota_minute*60+59,s.quota_current_units),(s.quota_minute*60-1,s.quota_previous_units)) charges(bucket,units)
WHERE charges.bucket>=0 AND charges.units>0
GROUP BY scopes.scope,charges.bucket;
--> statement-breakpoint
INSERT INTO gmail_quota_buckets(scope,kind,bucket,units)
SELECT 'project','day',quota_day,sum(quota_daily_units)
FROM gmail_account_sync_state WHERE quota_daily_units>0 GROUP BY quota_day;
