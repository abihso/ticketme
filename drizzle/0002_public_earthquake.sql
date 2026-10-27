ALTER TYPE "public"."UserRole" ADD VALUE 'ORGANIZER' BEFORE 'ADMIN';--> statement-breakpoint
ALTER TABLE "Event" ADD COLUMN "createdById" text;--> statement-breakpoint
ALTER TABLE "Event" ADD CONSTRAINT "Event_createdById_User_id_fk" FOREIGN KEY ("createdById") REFERENCES "public"."User"("id") ON DELETE set null ON UPDATE no action;