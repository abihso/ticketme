import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const purchaseStatusEnum = pgEnum("PurchaseStatus", [
  "PENDING",
  "PAID",
  "FAILED",
]);
export const userRoleEnum = pgEnum("UserRole", [
  "CUSTOMER",
  "ORGANIZER",
  "ADMIN",
]);
export type UserRole = (typeof userRoleEnum.enumValues)[number];

export const users = pgTable(
  "User",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("passwordHash").notNull(),
    role: userRoleEnum("role").notNull().default("CUSTOMER"),
    emailVerified: boolean("emailVerified").notNull().default(true),
    referralCode: text("referralCode"),
    referredById: text("referredById"),
    createdAt: timestamp("createdAt", { precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { precision: 3 }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("User_email_key").on(table.email),
    uniqueIndex("User_referralCode_key").on(table.referralCode),
  ],
);

export const events = pgTable(
  "Event",
  {
    id: text("id").primaryKey(),
    createdById: text("createdById").references(() => users.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    description: text("description"),
    coverImageUrl: text("coverImageUrl"),
    coverImageKey: text("coverImageKey"),
    venue: text("venue").notNull(),
    category: text("category").notNull().default("Other"),
    agenda: text("agenda"),
    accessibility: text("accessibility"),
    refundPolicy: text("refundPolicy"),
    startsAt: timestamp("startsAt", { precision: 3 }).notNull(),
    endsAt: timestamp("endsAt", { precision: 3 }),
    published: boolean("published").notNull().default(false),
    createdAt: timestamp("createdAt", { precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { precision: 3 }).notNull().defaultNow(),
  },
  (table) => [index("Event_createdById_idx").on(table.createdById)],
);

export const ticketTypes = pgTable(
  "TicketType",
  {
    id: text("id").primaryKey(),
    eventId: text("eventId")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    priceMinor: integer("priceMinor").notNull(),
    currency: text("currency").notNull().default("GHS"),
    quantity: integer("quantity").notNull(),
    sold: integer("sold").notNull().default(0),
    reserved: integer("reserved").notNull().default(0),
    createdAt: timestamp("createdAt", { precision: 3 }).notNull().defaultNow(),
  },
  (table) => [index("TicketType_eventId_idx").on(table.eventId)],
);

export const purchases = pgTable(
  "Purchase",
  {
    id: text("id").primaryKey(),
    reference: text("reference").notNull(),
    userId: text("userId").references(() => users.id),
    ticketTypeId: text("ticketTypeId")
      .notNull()
      .references(() => ticketTypes.id),
    email: text("email").notNull(),
    quantity: integer("quantity").notNull(),
    amountMinor: integer("amountMinor").notNull(),
    originalAmountMinor: integer("originalAmountMinor").notNull().default(0),
    discountPercent: integer("discountPercent").notNull().default(0),
    promoCodeId: text("promoCodeId"),
    currency: text("currency").notNull(),
    status: purchaseStatusEnum("status").notNull().default("PENDING"),
    expiresAt: timestamp("expiresAt", { precision: 3 }).notNull().defaultNow(),
    createdAt: timestamp("createdAt", { precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { precision: 3 }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("Purchase_reference_key").on(table.reference)],
);

export const tickets = pgTable(
  "Ticket",
  {
    id: text("id").primaryKey(),
    purchaseId: text("purchaseId")
      .notNull()
      .references(() => purchases.id, { onDelete: "cascade" }),
    ownerId: text("ownerId").references(() => users.id, {
      onDelete: "set null",
    }),
    tokenHash: text("tokenHash").notNull(),
    encryptedToken: text("encryptedToken").notNull().default(""),
    checkedInAt: timestamp("checkedInAt", { precision: 3 }),
    checkedOutAt: timestamp("checkedOutAt", { precision: 3 }),
    createdAt: timestamp("createdAt", { precision: 3 }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("Ticket_tokenHash_key").on(table.tokenHash),
    index("Ticket_purchaseId_idx").on(table.purchaseId),
  ],
);

export const checkInLogs = pgTable(
  "TicketCheckIn",
  {
    id: text("id").primaryKey(),
    ticketId: text("ticketId")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    eventId: text("eventId")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    actorId: text("actorId").references(() => users.id, {
      onDelete: "set null",
    }),
    checkedAt: timestamp("checkedAt", { precision: 3 }).notNull().defaultNow(),
  },
  (table) => [
    index("TicketCheckIn_event_checkedAt_idx").on(
      table.eventId,
      table.checkedAt,
    ),
    index("TicketCheckIn_ticketId_idx").on(table.ticketId),
  ],
);

export const favorites = pgTable(
  "UserFavoriteEvent",
  {
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    eventId: text("eventId")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    createdAt: timestamp("createdAt", { precision: 3 }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("UserFavoriteEvent_user_event_key").on(
      table.userId,
      table.eventId,
    ),
  ],
);

export const reviews = pgTable(
  "EventReview",
  {
    id: text("id").primaryKey(),
    eventId: text("eventId")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    rating: integer("rating").notNull(),
    comment: text("comment"),
    createdAt: timestamp("createdAt", { precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { precision: 3 }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("EventReview_event_user_key").on(table.eventId, table.userId),
  ],
);

export const promotions = pgTable(
  "Promotion",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull(),
    percentOff: integer("percentOff").notNull(),
    eventId: text("eventId").references(() => events.id, {
      onDelete: "cascade",
    }),
    createdById: text("createdById")
      .notNull()
      .references(() => users.id),
    maxUses: integer("maxUses"),
    uses: integer("uses").notNull().default(0),
    expiresAt: timestamp("expiresAt", { precision: 3 }),
    createdAt: timestamp("createdAt", { precision: 3 }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("Promotion_code_key").on(table.code)],
);

export const accountTokens = pgTable(
  "AccountToken",
  {
    id: text("id").primaryKey(),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("tokenHash").notNull(),
    purpose: text("purpose").notNull(),
    targetEmail: text("targetEmail"),
    expiresAt: timestamp("expiresAt", { precision: 3 }).notNull(),
    createdAt: timestamp("createdAt", { precision: 3 }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("AccountToken_tokenHash_key").on(table.tokenHash)],
);

export const pushTokens = pgTable(
  "PushToken",
  {
    id: text("id").primaryKey(),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    createdAt: timestamp("createdAt", { precision: 3 }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("PushToken_token_key").on(table.token)],
);

export const refundRequests = pgTable(
  "RefundRequest",
  {
    id: text("id").primaryKey(),
    purchaseId: text("purchaseId")
      .notNull()
      .references(() => purchases.id, { onDelete: "cascade" }),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    status: text("status").notNull().default("PENDING"),
    decisionNote: text("decisionNote"),
    createdAt: timestamp("createdAt", { precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { precision: 3 }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("RefundRequest_purchaseId_key").on(table.purchaseId)],
);
