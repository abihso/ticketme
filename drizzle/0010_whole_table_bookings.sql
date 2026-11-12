ALTER TABLE "Purchase" ADD COLUMN "tableNumber" integer;--> statement-breakpoint
ALTER TABLE "Purchase" ADD COLUMN "tableCapacity" integer;--> statement-breakpoint
ALTER TABLE "TicketType" ADD COLUMN "tableCapacity" integer;--> statement-breakpoint
ALTER TABLE "Ticket" ADD COLUMN "guestName" text;--> statement-breakpoint
ALTER TABLE "Ticket" ADD COLUMN "seatNumber" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "Purchase_active_table_key" ON "Purchase" USING btree ("ticketTypeId","tableNumber") WHERE "Purchase"."status" != 'FAILED';--> statement-breakpoint
CREATE UNIQUE INDEX "Ticket_purchase_seat_key" ON "Ticket" USING btree ("purchaseId","seatNumber");