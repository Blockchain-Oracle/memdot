CREATE TYPE "public"."stored_item_role" AS ENUM('root', 'chunk');--> statement-breakpoint
CREATE TABLE "blob_staging" (
	"stored_item_id" uuid PRIMARY KEY NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "stored_items_object_chunk_idx";--> statement-breakpoint
ALTER TABLE "objects" ALTER COLUMN "space_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "objects" ADD COLUMN "account_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "stored_items" ADD COLUMN "role" "stored_item_role" DEFAULT 'root' NOT NULL;--> statement-breakpoint
ALTER TABLE "stored_items" ADD COLUMN "fee_planck" text;--> statement-breakpoint
ALTER TABLE "blob_staging" ADD CONSTRAINT "blob_staging_stored_item_id_stored_items_id_fk" FOREIGN KEY ("stored_item_id") REFERENCES "public"."stored_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objects" ADD CONSTRAINT "objects_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "objects_account_idx" ON "objects" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "stored_items_object_chunk_idx" ON "stored_items" USING btree ("object_id","role","chunk_index");