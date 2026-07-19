CREATE TABLE "activity_logs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "activity_logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"audience" text NOT NULL,
	"actor_id" bigint,
	"actor_email" text NOT NULL,
	"actor_name" text,
	"partner_id" bigint,
	"action" text NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"resource_summary" text,
	"status" text NOT NULL,
	"status_code" integer,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_activity_logs_created_at" ON "activity_logs" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_activity_logs_audience_created_at" ON "activity_logs" USING btree ("audience","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_activity_logs_actor_email" ON "activity_logs" USING btree ("actor_email");