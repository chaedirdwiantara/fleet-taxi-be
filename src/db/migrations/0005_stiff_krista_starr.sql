CREATE TABLE "checkpoint_media" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "checkpoint_media_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"checkpoint_id" bigint NOT NULL,
	"point_id" bigint,
	"kind" text NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkpoint_media_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "checkpoint_points" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "checkpoint_points_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"checkpoint_id" bigint NOT NULL,
	"point_key" text NOT NULL,
	"passed" boolean,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkpoint_points_checkpoint_point_uq" UNIQUE("checkpoint_id","point_key")
);
--> statement-breakpoint
CREATE TABLE "checkpoints" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "checkpoints_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"partner_id" bigint NOT NULL,
	"created_by" bigint NOT NULL,
	"plate_number" text NOT NULL,
	"plate_number_norm" text NOT NULL,
	"handover_type" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"counterpart_name" text,
	"counterpart_phone" text,
	"odometer_km" integer,
	"battery_percent" smallint,
	"general_notes" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "checkpoint_media" ADD CONSTRAINT "checkpoint_media_checkpoint_id_checkpoints_id_fk" FOREIGN KEY ("checkpoint_id") REFERENCES "public"."checkpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkpoint_media" ADD CONSTRAINT "checkpoint_media_point_id_checkpoint_points_id_fk" FOREIGN KEY ("point_id") REFERENCES "public"."checkpoint_points"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkpoint_points" ADD CONSTRAINT "checkpoint_points_checkpoint_id_checkpoints_id_fk" FOREIGN KEY ("checkpoint_id") REFERENCES "public"."checkpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "checkpoint_media_checkpoint_idx" ON "checkpoint_media" USING btree ("checkpoint_id");--> statement-breakpoint
CREATE INDEX "checkpoint_media_point_idx" ON "checkpoint_media" USING btree ("point_id");--> statement-breakpoint
CREATE INDEX "checkpoints_partner_created_idx" ON "checkpoints" USING btree ("partner_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "checkpoints_prev_lookup_idx" ON "checkpoints" USING btree ("partner_id","plate_number_norm","handover_type","completed_at" DESC NULLS LAST);