CREATE TABLE "gojek_portal_sync_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "gojek_portal_sync_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"date_from" date NOT NULL,
	"date_to" date NOT NULL,
	"report_id" bigint,
	"filename" text,
	"file_key" text,
	"imported_rows" integer,
	"skipped_rows" integer,
	"import_ids" jsonb,
	"message" text,
	"triggered_by" bigint,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gojek_portal_sync_settings" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "gojek_portal_sync_settings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"email" text,
	"password_digest_enc" text,
	"is_enabled" boolean DEFAULT false NOT NULL,
	"run_at" text DEFAULT '05:00' NOT NULL,
	"lookback_days" integer DEFAULT 1 NOT NULL,
	"last_verified_at" timestamp with time zone,
	"updated_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fleet_imports" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "fleet_imports" ADD COLUMN "sync_run_id" bigint;--> statement-breakpoint
ALTER TABLE "fleet_imports" ADD COLUMN "skipped_rows" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "fleet_imports" ADD COLUMN "error" text;--> statement-breakpoint
CREATE INDEX "idx_gojek_portal_sync_runs_started_at" ON "gojek_portal_sync_runs" USING btree ("started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_gojek_portal_sync_runs_status" ON "gojek_portal_sync_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_gojek_portal_sync_runs_trigger_started_at" ON "gojek_portal_sync_runs" USING btree ("trigger","started_at" DESC NULLS LAST);