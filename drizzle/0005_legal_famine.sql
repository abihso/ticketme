CREATE TABLE "AccountToken" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"tokenHash" text NOT NULL,
	"purpose" text NOT NULL,
	"targetEmail" text,
	"expiresAt" timestamp (3) NOT NULL,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "UserFavoriteEvent" (
	"userId" text NOT NULL,
	"eventId" text NOT NULL,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Promotion" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"percentOff" integer NOT NULL,
	"eventId" text,
	"createdById" text NOT NULL,
	"maxUses" integer,
	"uses" integer DEFAULT 0 NOT NULL,
	"expiresAt" timestamp (3),
	"createdAt" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "PushToken" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"token" text NOT NULL,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "RefundRequest" (
	"id" text PRIMARY KEY NOT NULL,
	"purchaseId" text NOT NULL,
	"userId" text NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"decisionNote" text,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "EventReview" (
	"id" text PRIMARY KEY NOT NULL,
	"eventId" text NOT NULL,
	"userId" text NOT NULL,
	"rating" integer NOT NULL,
	"comment" text,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "Event" ADD COLUMN "category" text DEFAULT 'Other' NOT NULL;--> statement-breakpoint
ALTER TABLE "Purchase" ADD COLUMN "originalAmountMinor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "Purchase" ADD COLUMN "discountPercent" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "Purchase" ADD COLUMN "promoCodeId" text;--> statement-breakpoint
ALTER TABLE "Ticket" ADD COLUMN "ownerId" text;--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN "emailVerified" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN "referralCode" text;--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN "referredById" text;--> statement-breakpoint
ALTER TABLE "AccountToken" ADD CONSTRAINT "AccountToken_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "UserFavoriteEvent" ADD CONSTRAINT "UserFavoriteEvent_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "UserFavoriteEvent" ADD CONSTRAINT "UserFavoriteEvent_eventId_Event_id_fk" FOREIGN KEY ("eventId") REFERENCES "public"."Event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_eventId_Event_id_fk" FOREIGN KEY ("eventId") REFERENCES "public"."Event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_createdById_User_id_fk" FOREIGN KEY ("createdById") REFERENCES "public"."User"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "PushToken" ADD CONSTRAINT "PushToken_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RefundRequest" ADD CONSTRAINT "RefundRequest_purchaseId_Purchase_id_fk" FOREIGN KEY ("purchaseId") REFERENCES "public"."Purchase"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RefundRequest" ADD CONSTRAINT "RefundRequest_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "EventReview" ADD CONSTRAINT "EventReview_eventId_Event_id_fk" FOREIGN KEY ("eventId") REFERENCES "public"."Event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "EventReview" ADD CONSTRAINT "EventReview_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "AccountToken_tokenHash_key" ON "AccountToken" USING btree ("tokenHash");--> statement-breakpoint
CREATE UNIQUE INDEX "UserFavoriteEvent_user_event_key" ON "UserFavoriteEvent" USING btree ("userId","eventId");--> statement-breakpoint
CREATE UNIQUE INDEX "Promotion_code_key" ON "Promotion" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "PushToken_token_key" ON "PushToken" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "RefundRequest_purchaseId_key" ON "RefundRequest" USING btree ("purchaseId");--> statement-breakpoint
CREATE UNIQUE INDEX "EventReview_event_user_key" ON "EventReview" USING btree ("eventId","userId");--> statement-breakpoint
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_ownerId_User_id_fk" FOREIGN KEY ("ownerId") REFERENCES "public"."User"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "User_referralCode_key" ON "User" USING btree ("referralCode");