CREATE TABLE "TicketCheckIn" (
	"id" text PRIMARY KEY NOT NULL,
	"ticketId" text NOT NULL,
	"eventId" text NOT NULL,
	"actorId" text,
	"checkedAt" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "TicketCheckIn" ADD CONSTRAINT "TicketCheckIn_ticketId_Ticket_id_fk" FOREIGN KEY ("ticketId") REFERENCES "public"."Ticket"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TicketCheckIn" ADD CONSTRAINT "TicketCheckIn_eventId_Event_id_fk" FOREIGN KEY ("eventId") REFERENCES "public"."Event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TicketCheckIn" ADD CONSTRAINT "TicketCheckIn_actorId_User_id_fk" FOREIGN KEY ("actorId") REFERENCES "public"."User"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "TicketCheckIn_event_checkedAt_idx" ON "TicketCheckIn" USING btree ("eventId","checkedAt");--> statement-breakpoint
CREATE INDEX "TicketCheckIn_ticketId_idx" ON "TicketCheckIn" USING btree ("ticketId");