import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Placeholder table created by the first migration, proving the migration
 * pipeline works end to end. Key/value metadata about the deployment
 * (not product data). Product tables arrive with their features.
 */
export const appMeta = pgTable("app_meta", {
  key: text().primaryKey(),
  value: text().notNull(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
