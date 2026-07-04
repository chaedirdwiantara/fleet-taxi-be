-- Hand-written DDL: drizzle-kit cannot generate partitioned tables.
-- RANGE partitioned by (period_year, period_month); child partitions are
-- created on demand by ensureDetailPartition() (src/db/partitions.ts).
-- Rationale (PROJECT-BRIEF.md §5): month-scoped grid queries hit one
-- partition; batch rollback deletes within one partition; a whole period can
-- be dropped fast.

CREATE TABLE "fleet_import_details" (
	"id" bigint GENERATED ALWAYS AS IDENTITY,
	"import_id" bigint NOT NULL,
	"transaction_date" date NOT NULL,
	"period_year" integer NOT NULL,
	"period_month" integer NOT NULL,
	"driver_id" text,
	"driver_name" text,
	"vehicle_plate" text,
	"vehicle_plate_norm" text,
	"amount" bigint,
	"type" text,
	"is_manual_payment_setoran" smallint,
	"manual_payment_note" text,
	"reference_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fleet_import_details_pk" PRIMARY KEY ("id", "period_year", "period_month"),
	CONSTRAINT "fleet_import_details_import_id_fk" FOREIGN KEY ("import_id")
		REFERENCES "fleet_imports"("id") ON DELETE CASCADE
) PARTITION BY RANGE ("period_year", "period_month");
--> statement-breakpoint
CREATE INDEX "fleet_import_details_plate_norm_idx" ON "fleet_import_details" ("vehicle_plate_norm");
--> statement-breakpoint
CREATE INDEX "fleet_import_details_transaction_date_idx" ON "fleet_import_details" ("transaction_date");
--> statement-breakpoint
CREATE INDEX "fleet_import_details_import_id_idx" ON "fleet_import_details" ("import_id");
--> statement-breakpoint
CREATE TABLE "grab_import_details" (
	"id" bigint GENERATED ALWAYS AS IDENTITY,
	"import_id" bigint NOT NULL,
	"date" date NOT NULL,
	"period_year" integer NOT NULL,
	"period_month" integer NOT NULL,
	"plate_number" text,
	"plate_number_norm" text,
	"city" text,
	"car_model" text,
	"driver_name" text,
	"driver_phone_number" text,
	"tiering" text,
	"partner_name" text,
	"total_online_hours" numeric(10,2),
	"total_bookings" integer,
	"total_rides" integer,
	"cancel_by_driver" integer,
	"fullfilment_rate" numeric(10,2),
	"driver_cancellation_rate" numeric(10,2),
	"driver_fare" bigint,
	"toll_and_others" bigint,
	"total_incentive" bigint,
	"total_earning_collected" bigint,
	"composite_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grab_import_details_pk" PRIMARY KEY ("id", "period_year", "period_month"),
	CONSTRAINT "grab_import_details_import_id_fk" FOREIGN KEY ("import_id")
		REFERENCES "grab_imports"("id") ON DELETE CASCADE
) PARTITION BY RANGE ("period_year", "period_month");
--> statement-breakpoint
CREATE INDEX "grab_import_details_plate_norm_idx" ON "grab_import_details" ("plate_number_norm");
--> statement-breakpoint
CREATE INDEX "grab_import_details_date_idx" ON "grab_import_details" ("date");
--> statement-breakpoint
CREATE INDEX "grab_import_details_import_id_idx" ON "grab_import_details" ("import_id");
--> statement-breakpoint
CREATE INDEX "grab_import_details_composite_key_idx" ON "grab_import_details" ("composite_key");
