CREATE TABLE "driver_documents" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "driver_documents_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"driver_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "driver_documents_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "drivers" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "drivers_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"partner_id" bigint NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"address" text,
	"ktp_no" text,
	"sim_no" text,
	"sim_expired" date,
	"driver_code" text,
	"plate_number" text,
	"plate_number_norm" text,
	"bank_account" text,
	"registration_status" text DEFAULT 'pending' NOT NULL,
	"reject_note" text,
	"ktp_verified" boolean DEFAULT false NOT NULL,
	"sim_verified" boolean DEFAULT false NOT NULL,
	"skck_verified" boolean DEFAULT false NOT NULL,
	"deposit_amount" bigint DEFAULT 0 NOT NULL,
	"deposit_status" text DEFAULT 'none' NOT NULL,
	"deposit_note" text,
	"deposit_decided_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"resigned_at" timestamp with time zone,
	"deposit_return_status" text DEFAULT 'none' NOT NULL,
	"deposit_return_decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drivers_partner_code_uq" UNIQUE("partner_id","driver_code")
);
--> statement-breakpoint
ALTER TABLE "driver_documents" ADD CONSTRAINT "driver_documents_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "driver_documents_driver_kind_idx" ON "driver_documents" USING btree ("driver_id","kind");--> statement-breakpoint
CREATE INDEX "drivers_partner_created_idx" ON "drivers" USING btree ("partner_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "drivers_partner_reg_status_idx" ON "drivers" USING btree ("partner_id","registration_status");--> statement-breakpoint
CREATE INDEX "drivers_partner_resigned_idx" ON "drivers" USING btree ("partner_id","resigned_at");