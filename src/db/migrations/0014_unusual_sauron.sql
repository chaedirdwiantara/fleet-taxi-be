ALTER TABLE "partners" ADD COLUMN "is_pkp" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "partners" ADD COLUMN "npwp" text;--> statement-breakpoint
ALTER TABLE "rentals" ADD COLUMN "ppn_rate_bps" integer DEFAULT 0 NOT NULL;