CREATE TABLE "memory_model_usage" (
	"account_id" uuid NOT NULL,
	"day" date NOT NULL,
	"model_calls" integer DEFAULT 0 NOT NULL,
	"searches" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "memory_model_usage_account_id_day_pk" PRIMARY KEY("account_id","day")
);
--> statement-breakpoint
ALTER TABLE "memory_model_usage" ADD CONSTRAINT "memory_model_usage_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;