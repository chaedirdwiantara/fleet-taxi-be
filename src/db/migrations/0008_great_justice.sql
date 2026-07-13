ALTER TABLE "drivers" ADD COLUMN "name_norm" text;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_partner_name_norm_uq" UNIQUE("partner_id","name_norm");--> statement-breakpoint
UPDATE drivers SET name_norm = upper(regexp_replace(btrim(name), '\s+', ' ', 'g')) WHERE name_norm IS NULL;
