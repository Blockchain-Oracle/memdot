CREATE TYPE "public"."grant_scope" AS ENUM('read', 'read_write');--> statement-breakpoint
CREATE TYPE "public"."grant_status" AS ENUM('pending', 'active', 'revoked', 'expired');--> statement-breakpoint
CREATE TYPE "public"."grantee_kind" AS ENUM('account', 'agent');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'submitted', 'in_block', 'finalized', 'failed');--> statement-breakpoint
CREATE TYPE "public"."memory_mode" AS ENUM('off', 'private', 'assisted');--> statement-breakpoint
CREATE TYPE "public"."object_kind" AS ENUM('file', 'manifest', 'segment', 'index_snapshot', 'key_bundle', 'grant_key');--> statement-breakpoint
CREATE TYPE "public"."object_status" AS ENUM('queued', 'uploading', 'stored', 'failed', 'tombstoned', 'lost');--> statement-breakpoint
CREATE TYPE "public"."space_mode" AS ENUM('sponsored', 'self_signed');--> statement-breakpoint
CREATE TYPE "public"."stored_item_status" AS ENUM('pending', 'stored', 'expired_served', 'lost', 'released');--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"label" text NOT NULL,
	"client" text NOT NULL,
	"public_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "chain_cursors" (
	"name" text PRIMARY KEY NOT NULL,
	"block" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain_grant_id" text,
	"space_id" uuid NOT NULL,
	"object_id" uuid,
	"grantee_kind" "grantee_kind" NOT NULL,
	"grantee" text NOT NULL,
	"scope" "grant_scope" DEFAULT 'read' NOT NULL,
	"status" "grant_status" DEFAULT 'pending' NOT NULL,
	"wrapped_key_cid" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"kind" text NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"idempotency_key" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"error" text,
	"tx_hash" text,
	"block" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"message" text NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "request_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" uuid,
	"api_key_prefix" text,
	"client" text,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"status" integer NOT NULL,
	"latency_ms" integer NOT NULL,
	"request_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"owner_account" text NOT NULL,
	"evm_address" text,
	"encryption_key" text,
	"key_bundle_cid" text,
	"recovery_public_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "chain_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"name" text NOT NULL,
	"block" integer NOT NULL,
	"tx_hash" text,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"parent_id" uuid,
	"encrypted_name" "bytea" NOT NULL,
	"memory_mode" "memory_mode" DEFAULT 'off' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"folder_id" uuid,
	"kind" "object_kind" NOT NULL,
	"status" "object_status" DEFAULT 'queued' NOT NULL,
	"content_hash" text,
	"cid" text,
	"size_bytes" bigint NOT NULL,
	"encrypted_meta" "bytea",
	"segment_id" uuid,
	"previous_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tombstoned_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "renewals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stored_item_id" uuid NOT NULL,
	"tx_hash" text NOT NULL,
	"from_block" integer NOT NULL,
	"from_idx" integer NOT NULL,
	"to_block" integer NOT NULL,
	"to_idx" integer NOT NULL,
	"fee_planck" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"chain_space_id" text,
	"encrypted_name" "bytea" NOT NULL,
	"mode" "space_mode" DEFAULT 'sponsored' NOT NULL,
	"key_epoch" integer DEFAULT 0 NOT NULL,
	"quota_bytes" bigint NOT NULL,
	"used_bytes" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "stored_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"object_id" uuid,
	"chunk_index" integer DEFAULT 0 NOT NULL,
	"content_hash" text NOT NULL,
	"cid" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"status" "stored_item_status" DEFAULT 'pending' NOT NULL,
	"block" integer,
	"idx" integer,
	"stored_tx_hash" text,
	"last_renewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_object_id_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objects" ADD CONSTRAINT "objects_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objects" ADD CONSTRAINT "objects_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renewals" ADD CONSTRAINT "renewals_stored_item_id_stored_items_id_fk" FOREIGN KEY ("stored_item_id") REFERENCES "public"."stored_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stored_items" ADD CONSTRAINT "stored_items_object_id_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_key_idx" ON "agents" USING btree ("public_key");--> statement-breakpoint
CREATE INDEX "agents_account_idx" ON "agents" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "grants_space_idx" ON "grants" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "grants_grantee_idx" ON "grants" USING btree ("grantee","status");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_idempotency_idx" ON "jobs" USING btree ("account_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "jobs_account_idx" ON "jobs" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "request_logs_account_idx" ON "request_logs" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "request_logs_created_brin" ON "request_logs" USING brin ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_user_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_owner_idx" ON "accounts" USING btree ("owner_account");--> statement-breakpoint
CREATE INDEX "chain_events_block_idx" ON "chain_events" USING btree ("source","block");--> statement-breakpoint
CREATE INDEX "folders_space_idx" ON "folders" USING btree ("space_id","parent_id");--> statement-breakpoint
CREATE INDEX "objects_space_folder_idx" ON "objects" USING btree ("space_id","folder_id");--> statement-breakpoint
CREATE INDEX "objects_segment_idx" ON "objects" USING btree ("segment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "objects_space_hash_idx" ON "objects" USING btree ("space_id","content_hash") WHERE "objects"."content_hash" is not null;--> statement-breakpoint
CREATE INDEX "renewals_item_idx" ON "renewals" USING btree ("stored_item_id");--> statement-breakpoint
CREATE INDEX "spaces_account_idx" ON "spaces" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "spaces_chain_idx" ON "spaces" USING btree ("chain_space_id") WHERE "spaces"."chain_space_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "stored_items_object_chunk_idx" ON "stored_items" USING btree ("object_id","chunk_index");--> statement-breakpoint
CREATE INDEX "stored_items_hash_idx" ON "stored_items" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "stored_items_due_idx" ON "stored_items" USING btree ("status","block");