DO $$ BEGIN
  CREATE TYPE "public"."PurchaseStatus" AS ENUM ('PENDING', 'PAID', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."UserRole" AS ENUM ('CUSTOMER', 'ADMIN');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "Event" (
  "id" text PRIMARY KEY NOT NULL,
  "title" text NOT NULL,
  "description" text,
  "venue" text NOT NULL,
  "startsAt" timestamp(3) NOT NULL,
  "endsAt" timestamp(3),
  "published" boolean NOT NULL DEFAULT false,
  "createdAt" timestamp(3) NOT NULL DEFAULT now(),
  "updatedAt" timestamp(3) NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "User" (
  "id" text PRIMARY KEY NOT NULL,
  "email" text NOT NULL,
  "name" text NOT NULL,
  "passwordHash" text NOT NULL,
  "role" "UserRole" NOT NULL DEFAULT 'CUSTOMER',
  "createdAt" timestamp(3) NOT NULL DEFAULT now(),
  "updatedAt" timestamp(3) NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "TicketType" (
  "id" text PRIMARY KEY NOT NULL,
  "eventId" text NOT NULL,
  "name" text NOT NULL,
  "priceMinor" integer NOT NULL,
  "currency" text NOT NULL DEFAULT 'NGN',
  "quantity" integer NOT NULL,
  "sold" integer NOT NULL DEFAULT 0,
  "reserved" integer NOT NULL DEFAULT 0,
  "createdAt" timestamp(3) NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "Purchase" (
  "id" text PRIMARY KEY NOT NULL,
  "reference" text NOT NULL,
  "userId" text,
  "ticketTypeId" text NOT NULL,
  "email" text NOT NULL,
  "quantity" integer NOT NULL,
  "amountMinor" integer NOT NULL,
  "currency" text NOT NULL,
  "status" "PurchaseStatus" NOT NULL DEFAULT 'PENDING',
  "expiresAt" timestamp(3) NOT NULL DEFAULT now(),
  "createdAt" timestamp(3) NOT NULL DEFAULT now(),
  "updatedAt" timestamp(3) NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "Ticket" (
  "id" text PRIMARY KEY NOT NULL,
  "purchaseId" text NOT NULL,
  "tokenHash" text NOT NULL,
  "encryptedToken" text NOT NULL DEFAULT '',
  "checkedInAt" timestamp(3),
  "createdAt" timestamp(3) NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "TicketType" ADD COLUMN IF NOT EXISTS "reserved" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "Purchase" ADD COLUMN IF NOT EXISTS "userId" text;
--> statement-breakpoint
ALTER TABLE "Purchase" ADD COLUMN IF NOT EXISTS "expiresAt" timestamp(3) NOT NULL DEFAULT now();
--> statement-breakpoint
ALTER TABLE "Ticket" ADD COLUMN IF NOT EXISTS "encryptedToken" text NOT NULL DEFAULT '';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key" ON "User" USING btree ("email");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "Purchase_reference_key" ON "Purchase" USING btree ("reference");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "TicketType_eventId_idx" ON "TicketType" USING btree ("eventId");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "Ticket_tokenHash_key" ON "Ticket" USING btree ("tokenHash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "Ticket_purchaseId_idx" ON "Ticket" USING btree ("purchaseId");
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "TicketType" ADD CONSTRAINT "TicketType_eventId_Event_id_fk"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_userId_User_id_fk"
    FOREIGN KEY ("userId") REFERENCES "User"("id");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_ticketTypeId_TicketType_id_fk"
    FOREIGN KEY ("ticketTypeId") REFERENCES "TicketType"("id");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_purchaseId_Purchase_id_fk"
    FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
