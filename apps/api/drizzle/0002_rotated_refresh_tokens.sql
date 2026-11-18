CREATE TABLE "rotated_refresh_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"rotated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DROP INDEX "sessions_previous_refresh_token_hash_unique";--> statement-breakpoint
ALTER TABLE "rotated_refresh_tokens" ADD CONSTRAINT "rotated_refresh_tokens_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rotated_refresh_tokens_session_id_idx" ON "rotated_refresh_tokens" USING btree ("session_id");--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "previous_refresh_token_hash";