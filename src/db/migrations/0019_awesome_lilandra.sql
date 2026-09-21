ALTER TABLE "rentals" ADD COLUMN "price_unit" text DEFAULT 'hari' NOT NULL;--> statement-breakpoint
ALTER TABLE "rentals" ADD COLUMN "price_per_month" bigint;