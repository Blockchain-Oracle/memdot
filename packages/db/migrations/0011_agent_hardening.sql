ALTER TABLE "connect_requests" ADD COLUMN "requested_from" text;--> statement-breakpoint
ALTER TABLE "grants" ADD COLUMN "owner_tag" text;