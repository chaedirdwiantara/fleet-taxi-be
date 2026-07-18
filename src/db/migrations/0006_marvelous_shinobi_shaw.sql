CREATE TABLE "rental_cogs_defaults" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "rental_cogs_defaults_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"partner_id" bigint NOT NULL,
	"vehicle_type_key" text NOT NULL,
	"vehicle_type_label" text NOT NULL,
	"cogs_per_day" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rental_cogs_defaults_partner_key_uq" UNIQUE("partner_id","vehicle_type_key")
);
--> statement-breakpoint
CREATE TABLE "rentals" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "rentals_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"partner_id" bigint NOT NULL,
	"plate_number" text NOT NULL,
	"plate_number_norm" text NOT NULL,
	"vehicle_type" text,
	"region" text,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"price_per_day" bigint NOT NULL,
	"cogs_per_day" bigint DEFAULT 0 NOT NULL,
	"cogs_type" text,
	"additional_cost" bigint DEFAULT 0 NOT NULL,
	"additional_cost_description" text,
	"deposit" bigint DEFAULT 0 NOT NULL,
	"rental_type" text,
	"info_source" text,
	"service_area" text,
	"customer_name" text,
	"customer_phone" text,
	"payment_status" text DEFAULT 'Belum Dibayar' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rental_cogs_defaults" ADD CONSTRAINT "rental_cogs_defaults_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rentals" ADD CONSTRAINT "rentals_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rentals_partner_id_idx" ON "rentals" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "rentals_partner_start_date_idx" ON "rentals" USING btree ("partner_id","start_date");--> statement-breakpoint
CREATE INDEX "rentals_partner_plate_norm_idx" ON "rentals" USING btree ("partner_id","plate_number_norm");