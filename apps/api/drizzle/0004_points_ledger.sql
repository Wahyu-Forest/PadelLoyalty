CREATE TYPE "public"."points_actor_type" AS ENUM('system', 'member', 'staff');--> statement-breakpoint
CREATE TYPE "public"."points_entry_type" AS ENUM('earn', 'redeem', 'adjustment', 'expiry');--> statement-breakpoint
CREATE TABLE "points_ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"entry_type" "points_entry_type" NOT NULL,
	"amount" integer NOT NULL,
	"reason" text NOT NULL,
	"reference" text,
	"idempotency_key" text NOT NULL,
	"actor_type" "points_actor_type" NOT NULL,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "points_ledger_entries_amount_sign" CHECK ("points_ledger_entries"."amount" <> 0
        and abs("points_ledger_entries"."amount") <= 1000000
        and (
          ("points_ledger_entries"."entry_type" = 'earn' and "points_ledger_entries"."amount" > 0)
          or ("points_ledger_entries"."entry_type" in ('redeem', 'expiry') and "points_ledger_entries"."amount" < 0)
          or "points_ledger_entries"."entry_type" = 'adjustment'
        )),
	CONSTRAINT "points_ledger_entries_actor" CHECK (("points_ledger_entries"."actor_type" = 'system') = ("points_ledger_entries"."actor_user_id" is null)),
	CONSTRAINT "points_ledger_entries_text_lengths" CHECK (char_length("points_ledger_entries"."reason") between 1 and 500
        and char_length("points_ledger_entries"."idempotency_key") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "points_ledger_entries" ADD CONSTRAINT "points_ledger_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "points_ledger_entries" ADD CONSTRAINT "points_ledger_entries_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "points_ledger_entries_idempotency_key_unique" ON "points_ledger_entries" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "points_ledger_entries_user_idx" ON "points_ledger_entries" USING btree ("user_id","created_at");--> statement-breakpoint
-- Append-only ledger (#6): entries are never updated or deleted. A mistake is
-- corrected by a new 'adjustment' entry. Not expressible in the Drizzle schema,
-- so written by hand below the generated statements.
CREATE FUNCTION "public"."points_ledger_entries_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'points_ledger_entries is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'restrict_violation',
          HINT = 'Correct a points balance with a new adjustment entry.';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "points_ledger_entries_no_update_or_delete"
  BEFORE UPDATE OR DELETE ON "points_ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "public"."points_ledger_entries_append_only"();--> statement-breakpoint
CREATE TRIGGER "points_ledger_entries_no_truncate"
  BEFORE TRUNCATE ON "points_ledger_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."points_ledger_entries_append_only"();
