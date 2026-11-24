CREATE TYPE "public"."court_block_reason" AS ENUM('maintenance', 'event', 'other');--> statement-breakpoint
CREATE TYPE "public"."court_environment" AS ENUM('indoor', 'outdoor');--> statement-breakpoint
CREATE TABLE "clubs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"address" text NOT NULL,
	"time_zone" text NOT NULL,
	"currency" text DEFAULT 'GBP' NOT NULL,
	"opening_hours" jsonb NOT NULL,
	"pricing" jsonb,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clubs_currency_iso" CHECK ("clubs"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "court_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"court_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" "court_block_reason" NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_user_id" uuid,
	CONSTRAINT "court_blocks_ends_after_starts" CHECK ("court_blocks"."ends_at" > "court_blocks"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "courts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"name" text NOT NULL,
	"environment" "court_environment" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "courts_club_id_id_unique" UNIQUE("club_id","id")
);
--> statement-breakpoint
ALTER TABLE "court_blocks" ADD CONSTRAINT "court_blocks_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "court_blocks" ADD CONSTRAINT "court_blocks_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "court_blocks" ADD CONSTRAINT "court_blocks_club_court_fk" FOREIGN KEY ("club_id","court_id") REFERENCES "public"."courts"("club_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courts" ADD CONSTRAINT "courts_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clubs_name_unique" ON "clubs" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "court_blocks_court_time_idx" ON "court_blocks" USING btree ("court_id","starts_at");--> statement-breakpoint
CREATE INDEX "court_blocks_club_time_idx" ON "court_blocks" USING btree ("club_id","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "courts_club_name_unique" ON "courts" USING btree ("club_id",lower("name"));