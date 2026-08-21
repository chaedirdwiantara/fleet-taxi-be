ALTER TABLE "drivers" ADD COLUMN "home_lat" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "home_lng" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN "exited_at" date;--> statement-breakpoint
CREATE INDEX "drivers_partner_exited_idx" ON "drivers" USING btree ("partner_id","exited_at");