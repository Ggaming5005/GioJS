-- Example rows for /notes. Seed data is a migration too, so it runs exactly
-- once per database.
INSERT INTO `notes` (`title`) VALUES ('Rows come from data/app.db through Drizzle (lib/db.server).');
--> statement-breakpoint
INSERT INTO `notes` (`title`) VALUES ('Change lib/schema, then run the db:generate script for a new migration.');
