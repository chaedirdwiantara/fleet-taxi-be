CREATE TABLE "admin_plates" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "admin_plates_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"plate_number" text NOT NULL,
	"plate_number_norm" text NOT NULL,
	"vehicle_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_plates_plate_norm_uq" UNIQUE("plate_number_norm")
);
