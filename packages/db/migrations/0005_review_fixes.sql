DROP INDEX "jobs_account_idx";--> statement-breakpoint
DROP INDEX "request_logs_account_idx";--> statement-breakpoint
DROP INDEX "objects_account_idx";--> statement-breakpoint
DROP INDEX "objects_space_folder_idx";--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "grants" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "grants" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "ops_alerts" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "ops_alerts" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "request_logs" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "request_logs" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "blob_staging" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "blob_staging" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "chain_events" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "chain_events" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "folders" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "folders" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "objects" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "objects" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "renewals" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "renewals" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "spaces" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "spaces" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "stored_items" ALTER COLUMN "stored_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "stored_items" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "stored_items" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "object_id" uuid;--> statement-breakpoint
ALTER TABLE "objects" ADD COLUMN "relayed" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "objects" ADD COLUMN "reserved_bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "renewals" ADD COLUMN "account_id" uuid;--> statement-breakpoint
ALTER TABLE "stored_items" ADD COLUMN "account_id" uuid;--> statement-breakpoint
ALTER TABLE "stored_items" ADD COLUMN "first_block" integer;--> statement-breakpoint
ALTER TABLE "stored_items" ADD COLUMN "first_idx" integer;--> statement-breakpoint
ALTER TABLE "stored_items" ADD COLUMN "renew_queued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stored_items" ADD COLUMN "restore_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_object_id_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renewals" ADD CONSTRAINT "renewals_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stored_items" ADD CONSTRAINT "stored_items_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_object_idx" ON "jobs" USING btree ("object_id","kind");--> statement-breakpoint
CREATE INDEX "objects_previous_version_idx" ON "objects" USING btree ("previous_version_id") WHERE "objects"."previous_version_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "renewals_tx_item_idx" ON "renewals" USING btree ("tx_hash","stored_item_id");--> statement-breakpoint
CREATE INDEX "renewals_account_idx" ON "renewals" USING btree ("account_id","created_at","id");--> statement-breakpoint
CREATE INDEX "renewals_created_idx" ON "renewals" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "stored_items_tx_idx" ON "stored_items" USING btree ("stored_tx_hash") WHERE "stored_items"."stored_tx_hash" is not null;--> statement-breakpoint
CREATE INDEX "stored_items_account_stored_idx" ON "stored_items" USING btree ("account_id","stored_at","id") WHERE "stored_items"."stored_tx_hash" is not null;--> statement-breakpoint
CREATE INDEX "stored_items_stored_at_idx" ON "stored_items" USING btree ("stored_at") WHERE "stored_items"."stored_tx_hash" is not null;--> statement-breakpoint
CREATE INDEX "jobs_account_idx" ON "jobs" USING btree ("account_id","created_at","id");--> statement-breakpoint
CREATE INDEX "request_logs_account_idx" ON "request_logs" USING btree ("account_id","created_at","id");--> statement-breakpoint
CREATE INDEX "objects_account_idx" ON "objects" USING btree ("account_id","created_at","id");--> statement-breakpoint
CREATE INDEX "objects_space_folder_idx" ON "objects" USING btree ("space_id","folder_id","created_at","id");--> statement-breakpoint
-- Backfill the new columns from existing rows.
UPDATE "stored_items" si SET "account_id" = o."account_id" FROM "objects" o WHERE o."id" = si."object_id" AND si."account_id" IS NULL;--> statement-breakpoint
UPDATE "stored_items" si SET
  "first_block" = coalesce((SELECT r."from_block" FROM "renewals" r WHERE r."stored_item_id" = si."id" ORDER BY r."created_at" LIMIT 1), si."block"),
  "first_idx" = coalesce((SELECT r."from_idx" FROM "renewals" r WHERE r."stored_item_id" = si."id" ORDER BY r."created_at" LIMIT 1), si."idx")
  WHERE si."first_block" IS NULL AND si."block" IS NOT NULL;--> statement-breakpoint
UPDATE "renewals" r SET "account_id" = si."account_id" FROM "stored_items" si WHERE si."id" = r."stored_item_id" AND r."account_id" IS NULL;--> statement-breakpoint
UPDATE "jobs" j SET "object_id" = o."id" FROM "objects" o WHERE j."object_id" IS NULL AND o."id"::text = j."payload"->>'objectId';--> statement-breakpoint
UPDATE "objects" o SET "relayed" = (s."mode" = 'sponsored') FROM "spaces" s WHERE s."id" = o."space_id";--> statement-breakpoint
UPDATE "objects" o SET "reserved_bytes" = coalesce((SELECT sum(si."size_bytes") FROM "stored_items" si WHERE si."object_id" = o."id" AND si."status" <> 'released'), 0)
  WHERE o."space_id" IS NOT NULL AND o."relayed" AND o."status" NOT IN ('tombstoned', 'failed');--> statement-breakpoint
UPDATE "spaces" s SET "used_bytes" = coalesce((SELECT sum(o."reserved_bytes") FROM "objects" o WHERE o."space_id" = s."id"), 0);
