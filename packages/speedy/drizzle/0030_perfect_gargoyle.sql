ALTER TABLE "files" ADD COLUMN "voice" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "duration_sec" integer;