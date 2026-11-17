ALTER TABLE "TicketCheckIn" ADD COLUMN "checkedOutAt" timestamp (3);--> statement-breakpoint
ALTER TABLE "TicketCheckIn" ADD COLUMN "checkedOutById" text;--> statement-breakpoint
ALTER TABLE "TicketCheckIn" ADD CONSTRAINT "TicketCheckIn_checkedOutById_User_id_fk" FOREIGN KEY ("checkedOutById") REFERENCES "public"."User"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Preserve the latest known visit for tickets issued before visit logging.
INSERT INTO "TicketCheckIn" ("id", "ticketId", "eventId", "checkedAt", "checkedOutAt")
SELECT 'legacy-check-in:' || t."id", t."id", tt."eventId", t."checkedInAt", t."checkedOutAt"
FROM "Ticket" t
JOIN "Purchase" p ON p."id" = t."purchaseId"
JOIN "TicketType" tt ON tt."id" = p."ticketTypeId"
WHERE t."checkedInAt" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "TicketCheckIn" visit
    WHERE visit."ticketId" = t."id" AND visit."checkedAt" = t."checkedInAt"
  );--> statement-breakpoint
-- Older checkout times are only recoverable for the ticket's latest visit.
UPDATE "TicketCheckIn" visit
SET "checkedOutAt" = t."checkedOutAt"
FROM "Ticket" t
WHERE visit."ticketId" = t."id" AND visit."checkedAt" = t."checkedInAt"
  AND t."checkedOutAt" IS NOT NULL;
