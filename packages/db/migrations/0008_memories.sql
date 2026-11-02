CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."memory_event" AS ENUM('ADD', 'UPDATE', 'DELETE');--> statement-breakpoint
CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"folder_id" uuid NOT NULL,
	"mode" "memory_mode" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"segment_id" uuid,
	"source_object_id" uuid,
	"source_kind" text,
	"source_label" text,
	"user_id" text,
	"agent_id" text,
	"run_id" text,
	"metadata" jsonb,
	"categories" text[],
	"entity_terms" text[],
	"memory_type" text,
	"attributed_to" text,
	"raw" boolean DEFAULT false NOT NULL,
	"immutable" boolean DEFAULT false NOT NULL,
	"sealed_text" "bytea",
	"dedupe_key" text,
	"embedding" vector(1536),
	"embedding_model" text,
	"term_count" integer DEFAULT 0 NOT NULL,
	"feedback" text,
	"feedback_reason" text,
	"occurred_at" timestamp (3) with time zone,
	"expires_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "memory_config" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"llm" jsonb,
	"llm_key_sealed" "bytea",
	"embedder" jsonb,
	"embedder_key_sealed" "bytea",
	"private_sealed" "bytea",
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"memory_id" uuid NOT NULL,
	"event" "memory_event" NOT NULL,
	"version" integer NOT NULL,
	"sealed_text" "bytea",
	"sealed_previous" "bytea",
	"actor" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_inbox" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"folder_id" uuid NOT NULL,
	"sealed" "bytea" NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_segments" (
	"object_id" uuid PRIMARY KEY NOT NULL,
	"folder_id" uuid NOT NULL,
	"entries" integer NOT NULL,
	"recorded_at" timestamp with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_settings" (
	"folder_id" uuid PRIMARY KEY NOT NULL,
	"custom_instructions" text,
	"categories" jsonb,
	"sealed" "bytea",
	"key_epoch" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_terms" (
	"memory_id" uuid NOT NULL,
	"folder_id" uuid NOT NULL,
	"term" text NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "memory_terms_memory_id_term_pk" PRIMARY KEY("memory_id","term")
);
--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_segment_id_objects_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_source_object_id_objects_id_fk" FOREIGN KEY ("source_object_id") REFERENCES "public"."objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_config" ADD CONSTRAINT "memory_config_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_history" ADD CONSTRAINT "memory_history_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_inbox" ADD CONSTRAINT "memory_inbox_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_inbox" ADD CONSTRAINT "memory_inbox_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_segments" ADD CONSTRAINT "memory_segments_object_id_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_segments" ADD CONSTRAINT "memory_segments_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_settings" ADD CONSTRAINT "memory_settings_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_terms" ADD CONSTRAINT "memory_terms_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memories_folder_idx" ON "memories" USING btree ("folder_id","created_at","id");--> statement-breakpoint
CREATE INDEX "memories_account_idx" ON "memories" USING btree ("account_id","created_at","id");--> statement-breakpoint
CREATE INDEX "memories_segment_idx" ON "memories" USING btree ("segment_id");--> statement-breakpoint
CREATE INDEX "memories_source_idx" ON "memories" USING btree ("source_object_id") WHERE "memories"."source_object_id" is not null;--> statement-breakpoint
CREATE INDEX "memories_user_idx" ON "memories" USING btree ("folder_id","user_id");--> statement-breakpoint
CREATE INDEX "memories_agent_idx" ON "memories" USING btree ("folder_id","agent_id");--> statement-breakpoint
CREATE INDEX "memories_run_idx" ON "memories" USING btree ("folder_id","run_id");--> statement-breakpoint
CREATE INDEX "memories_embedding_hnsw" ON "memories" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "memories_dedupe_idx" ON "memories" USING btree ("folder_id","dedupe_key") WHERE "memories"."dedupe_key" is not null and "memories"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "memory_history_memory_idx" ON "memory_history" USING btree ("memory_id","id");--> statement-breakpoint
CREATE INDEX "memory_segments_folder_idx" ON "memory_segments" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "memory_terms_lookup_idx" ON "memory_terms" USING btree ("folder_id","term");