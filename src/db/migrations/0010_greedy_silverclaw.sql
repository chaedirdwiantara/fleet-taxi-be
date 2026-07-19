CREATE TABLE "deposit_installments" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "deposit_installments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"partner_id" bigint NOT NULL,
	"title" text NOT NULL,
	"driver_name" text NOT NULL,
	"driver_name_norm" text NOT NULL,
	"installment_amount" bigint NOT NULL,
	"installment_count" integer NOT NULL,
	"min_daily_setoran" bigint,
	"effective_date" date NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deposit_installments" ADD CONSTRAINT "deposit_installments_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deposit_installments_partner_created_idx" ON "deposit_installments" USING btree ("partner_id","created_at");--> statement-breakpoint
CREATE INDEX "deposit_installments_partner_driver_idx" ON "deposit_installments" USING btree ("partner_id","driver_name_norm");