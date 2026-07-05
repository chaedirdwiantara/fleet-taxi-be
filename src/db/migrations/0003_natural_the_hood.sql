CREATE TABLE "partner_plates" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "partner_plates_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"partner_id" bigint NOT NULL,
	"plate_number" text NOT NULL,
	"plate_number_norm" text NOT NULL,
	"vehicle_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partner_plates_partner_plate_uq" UNIQUE("partner_id","plate_number_norm")
);
--> statement-breakpoint
ALTER TABLE "partner_plates" ADD CONSTRAINT "partner_plates_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "partner_plates_partner_id_idx" ON "partner_plates" USING btree ("partner_id");