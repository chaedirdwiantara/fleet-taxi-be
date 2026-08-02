CREATE TABLE "rental_payment_proofs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "rental_payment_proofs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"partner_id" bigint NOT NULL,
	"rental_id" bigint,
	"storage_key" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"uploaded_by_user_id" bigint,
	"uploaded_by_name" text,
	"uploaded_by_email" text NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rental_payment_proofs_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
ALTER TABLE "rental_payment_proofs" ADD CONSTRAINT "rental_payment_proofs_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rental_payment_proofs" ADD CONSTRAINT "rental_payment_proofs_rental_id_rentals_id_fk" FOREIGN KEY ("rental_id") REFERENCES "public"."rentals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rental_payment_proofs_rental_idx" ON "rental_payment_proofs" USING btree ("rental_id");--> statement-breakpoint
CREATE INDEX "rental_payment_proofs_partner_rental_idx" ON "rental_payment_proofs" USING btree ("partner_id","rental_id");