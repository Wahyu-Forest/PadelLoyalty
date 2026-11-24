CREATE TYPE "public"."consent_method" AS ENUM('email_link');--> statement-breakpoint
CREATE TYPE "public"."consent_request_status" AS ENUM('pending', 'confirmed', 'declined', 'superseded');--> statement-breakpoint
ALTER TYPE "public"."account_status" ADD VALUE 'pending_consent' BEFORE 'active';--> statement-breakpoint
CREATE TABLE "guardian_consent_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"guardian_email" text NOT NULL,
	"member_date_of_birth" date NOT NULL,
	"method" "consent_method" DEFAULT 'email_link' NOT NULL,
	"status" "consent_request_status" DEFAULT 'pending' NOT NULL,
	"token_hash" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_ip" text,
	"decided_user_agent" text,
	"guardian_attested" boolean DEFAULT false NOT NULL,
	"superseded_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "date_of_birth" date;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "guardian_email" text;--> statement-breakpoint
ALTER TABLE "guardian_consent_requests" ADD CONSTRAINT "guardian_consent_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "guardian_consent_requests_token_hash_unique" ON "guardian_consent_requests" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "guardian_consent_requests_one_pending" ON "guardian_consent_requests" USING btree ("user_id") WHERE "guardian_consent_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "guardian_consent_requests_user_id_idx" ON "guardian_consent_requests" USING btree ("user_id","requested_at");