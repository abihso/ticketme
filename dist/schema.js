"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.refundRequests = exports.pushTokens = exports.accountTokens = exports.promotions = exports.reviews = exports.favorites = exports.checkInLogs = exports.tickets = exports.purchases = exports.ticketTypes = exports.events = exports.users = exports.userRoleEnum = exports.purchaseStatusEnum = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
exports.purchaseStatusEnum = (0, pg_core_1.pgEnum)("PurchaseStatus", [
    "PENDING",
    "PAID",
    "FAILED",
]);
exports.userRoleEnum = (0, pg_core_1.pgEnum)("UserRole", [
    "CUSTOMER",
    "ORGANIZER",
    "ADMIN",
]);
exports.users = (0, pg_core_1.pgTable)("User", {
    id: (0, pg_core_1.text)("id").primaryKey(),
    email: (0, pg_core_1.text)("email").notNull(),
    name: (0, pg_core_1.text)("name").notNull(),
    passwordHash: (0, pg_core_1.text)("passwordHash").notNull(),
    role: (0, exports.userRoleEnum)("role").notNull().default("CUSTOMER"),
    emailVerified: (0, pg_core_1.boolean)("emailVerified").notNull().default(true),
    referralCode: (0, pg_core_1.text)("referralCode"),
    referredById: (0, pg_core_1.text)("referredById"),
    createdAt: (0, pg_core_1.timestamp)("createdAt", { precision: 3 }).notNull().defaultNow(),
    updatedAt: (0, pg_core_1.timestamp)("updatedAt", { precision: 3 }).notNull().defaultNow(),
}, (table) => [
    (0, pg_core_1.uniqueIndex)("User_email_key").on(table.email),
    (0, pg_core_1.uniqueIndex)("User_referralCode_key").on(table.referralCode),
]);
exports.events = (0, pg_core_1.pgTable)("Event", {
    id: (0, pg_core_1.text)("id").primaryKey(),
    createdById: (0, pg_core_1.text)("createdById").references(() => exports.users.id, {
        onDelete: "set null",
    }),
    title: (0, pg_core_1.text)("title").notNull(),
    description: (0, pg_core_1.text)("description"),
    coverImageUrl: (0, pg_core_1.text)("coverImageUrl"),
    coverImageKey: (0, pg_core_1.text)("coverImageKey"),
    venue: (0, pg_core_1.text)("venue").notNull(),
    category: (0, pg_core_1.text)("category").notNull().default("Other"),
    agenda: (0, pg_core_1.text)("agenda"),
    accessibility: (0, pg_core_1.text)("accessibility"),
    refundPolicy: (0, pg_core_1.text)("refundPolicy"),
    startsAt: (0, pg_core_1.timestamp)("startsAt", { precision: 3 }).notNull(),
    endsAt: (0, pg_core_1.timestamp)("endsAt", { precision: 3 }),
    published: (0, pg_core_1.boolean)("published").notNull().default(false),
    createdAt: (0, pg_core_1.timestamp)("createdAt", { precision: 3 }).notNull().defaultNow(),
    updatedAt: (0, pg_core_1.timestamp)("updatedAt", { precision: 3 }).notNull().defaultNow(),
}, (table) => [(0, pg_core_1.index)("Event_createdById_idx").on(table.createdById)]);
exports.ticketTypes = (0, pg_core_1.pgTable)("TicketType", {
    id: (0, pg_core_1.text)("id").primaryKey(),
    eventId: (0, pg_core_1.text)("eventId")
        .notNull()
        .references(() => exports.events.id, { onDelete: "cascade" }),
    name: (0, pg_core_1.text)("name").notNull(),
    priceMinor: (0, pg_core_1.integer)("priceMinor").notNull(),
    currency: (0, pg_core_1.text)("currency").notNull().default("GHS"),
    quantity: (0, pg_core_1.integer)("quantity").notNull(),
    sold: (0, pg_core_1.integer)("sold").notNull().default(0),
    reserved: (0, pg_core_1.integer)("reserved").notNull().default(0),
    createdAt: (0, pg_core_1.timestamp)("createdAt", { precision: 3 }).notNull().defaultNow(),
}, (table) => [(0, pg_core_1.index)("TicketType_eventId_idx").on(table.eventId)]);
exports.purchases = (0, pg_core_1.pgTable)("Purchase", {
    id: (0, pg_core_1.text)("id").primaryKey(),
    reference: (0, pg_core_1.text)("reference").notNull(),
    userId: (0, pg_core_1.text)("userId").references(() => exports.users.id),
    ticketTypeId: (0, pg_core_1.text)("ticketTypeId")
        .notNull()
        .references(() => exports.ticketTypes.id),
    email: (0, pg_core_1.text)("email").notNull(),
    quantity: (0, pg_core_1.integer)("quantity").notNull(),
    amountMinor: (0, pg_core_1.integer)("amountMinor").notNull(),
    originalAmountMinor: (0, pg_core_1.integer)("originalAmountMinor").notNull().default(0),
    discountPercent: (0, pg_core_1.integer)("discountPercent").notNull().default(0),
    promoCodeId: (0, pg_core_1.text)("promoCodeId"),
    currency: (0, pg_core_1.text)("currency").notNull(),
    status: (0, exports.purchaseStatusEnum)("status").notNull().default("PENDING"),
    expiresAt: (0, pg_core_1.timestamp)("expiresAt", { precision: 3 }).notNull().defaultNow(),
    createdAt: (0, pg_core_1.timestamp)("createdAt", { precision: 3 }).notNull().defaultNow(),
    updatedAt: (0, pg_core_1.timestamp)("updatedAt", { precision: 3 }).notNull().defaultNow(),
}, (table) => [(0, pg_core_1.uniqueIndex)("Purchase_reference_key").on(table.reference)]);
exports.tickets = (0, pg_core_1.pgTable)("Ticket", {
    id: (0, pg_core_1.text)("id").primaryKey(),
    purchaseId: (0, pg_core_1.text)("purchaseId")
        .notNull()
        .references(() => exports.purchases.id, { onDelete: "cascade" }),
    ownerId: (0, pg_core_1.text)("ownerId").references(() => exports.users.id, {
        onDelete: "set null",
    }),
    tokenHash: (0, pg_core_1.text)("tokenHash").notNull(),
    encryptedToken: (0, pg_core_1.text)("encryptedToken").notNull().default(""),
    checkedInAt: (0, pg_core_1.timestamp)("checkedInAt", { precision: 3 }),
    checkedOutAt: (0, pg_core_1.timestamp)("checkedOutAt", { precision: 3 }),
    createdAt: (0, pg_core_1.timestamp)("createdAt", { precision: 3 }).notNull().defaultNow(),
}, (table) => [
    (0, pg_core_1.uniqueIndex)("Ticket_tokenHash_key").on(table.tokenHash),
    (0, pg_core_1.index)("Ticket_purchaseId_idx").on(table.purchaseId),
]);
exports.checkInLogs = (0, pg_core_1.pgTable)("TicketCheckIn", {
    id: (0, pg_core_1.text)("id").primaryKey(),
    ticketId: (0, pg_core_1.text)("ticketId")
        .notNull()
        .references(() => exports.tickets.id, { onDelete: "cascade" }),
    eventId: (0, pg_core_1.text)("eventId")
        .notNull()
        .references(() => exports.events.id, { onDelete: "cascade" }),
    actorId: (0, pg_core_1.text)("actorId").references(() => exports.users.id, {
        onDelete: "set null",
    }),
    checkedAt: (0, pg_core_1.timestamp)("checkedAt", { precision: 3 }).notNull().defaultNow(),
}, (table) => [
    (0, pg_core_1.index)("TicketCheckIn_event_checkedAt_idx").on(table.eventId, table.checkedAt),
    (0, pg_core_1.index)("TicketCheckIn_ticketId_idx").on(table.ticketId),
]);
exports.favorites = (0, pg_core_1.pgTable)("UserFavoriteEvent", {
    userId: (0, pg_core_1.text)("userId")
        .notNull()
        .references(() => exports.users.id, { onDelete: "cascade" }),
    eventId: (0, pg_core_1.text)("eventId")
        .notNull()
        .references(() => exports.events.id, { onDelete: "cascade" }),
    createdAt: (0, pg_core_1.timestamp)("createdAt", { precision: 3 }).notNull().defaultNow(),
}, (table) => [
    (0, pg_core_1.uniqueIndex)("UserFavoriteEvent_user_event_key").on(table.userId, table.eventId),
]);
exports.reviews = (0, pg_core_1.pgTable)("EventReview", {
    id: (0, pg_core_1.text)("id").primaryKey(),
    eventId: (0, pg_core_1.text)("eventId")
        .notNull()
        .references(() => exports.events.id, { onDelete: "cascade" }),
    userId: (0, pg_core_1.text)("userId")
        .notNull()
        .references(() => exports.users.id, { onDelete: "cascade" }),
    rating: (0, pg_core_1.integer)("rating").notNull(),
    comment: (0, pg_core_1.text)("comment"),
    createdAt: (0, pg_core_1.timestamp)("createdAt", { precision: 3 }).notNull().defaultNow(),
    updatedAt: (0, pg_core_1.timestamp)("updatedAt", { precision: 3 }).notNull().defaultNow(),
}, (table) => [
    (0, pg_core_1.uniqueIndex)("EventReview_event_user_key").on(table.eventId, table.userId),
]);
exports.promotions = (0, pg_core_1.pgTable)("Promotion", {
    id: (0, pg_core_1.text)("id").primaryKey(),
    code: (0, pg_core_1.text)("code").notNull(),
    percentOff: (0, pg_core_1.integer)("percentOff").notNull(),
    eventId: (0, pg_core_1.text)("eventId").references(() => exports.events.id, {
        onDelete: "cascade",
    }),
    createdById: (0, pg_core_1.text)("createdById")
        .notNull()
        .references(() => exports.users.id),
    maxUses: (0, pg_core_1.integer)("maxUses"),
    uses: (0, pg_core_1.integer)("uses").notNull().default(0),
    expiresAt: (0, pg_core_1.timestamp)("expiresAt", { precision: 3 }),
    createdAt: (0, pg_core_1.timestamp)("createdAt", { precision: 3 }).notNull().defaultNow(),
}, (table) => [(0, pg_core_1.uniqueIndex)("Promotion_code_key").on(table.code)]);
exports.accountTokens = (0, pg_core_1.pgTable)("AccountToken", {
    id: (0, pg_core_1.text)("id").primaryKey(),
    userId: (0, pg_core_1.text)("userId")
        .notNull()
        .references(() => exports.users.id, { onDelete: "cascade" }),
    tokenHash: (0, pg_core_1.text)("tokenHash").notNull(),
    purpose: (0, pg_core_1.text)("purpose").notNull(),
    targetEmail: (0, pg_core_1.text)("targetEmail"),
    expiresAt: (0, pg_core_1.timestamp)("expiresAt", { precision: 3 }).notNull(),
    createdAt: (0, pg_core_1.timestamp)("createdAt", { precision: 3 }).notNull().defaultNow(),
}, (table) => [(0, pg_core_1.uniqueIndex)("AccountToken_tokenHash_key").on(table.tokenHash)]);
exports.pushTokens = (0, pg_core_1.pgTable)("PushToken", {
    id: (0, pg_core_1.text)("id").primaryKey(),
    userId: (0, pg_core_1.text)("userId")
        .notNull()
        .references(() => exports.users.id, { onDelete: "cascade" }),
    token: (0, pg_core_1.text)("token").notNull(),
    createdAt: (0, pg_core_1.timestamp)("createdAt", { precision: 3 }).notNull().defaultNow(),
}, (table) => [(0, pg_core_1.uniqueIndex)("PushToken_token_key").on(table.token)]);
exports.refundRequests = (0, pg_core_1.pgTable)("RefundRequest", {
    id: (0, pg_core_1.text)("id").primaryKey(),
    purchaseId: (0, pg_core_1.text)("purchaseId")
        .notNull()
        .references(() => exports.purchases.id, { onDelete: "cascade" }),
    userId: (0, pg_core_1.text)("userId")
        .notNull()
        .references(() => exports.users.id, { onDelete: "cascade" }),
    reason: (0, pg_core_1.text)("reason").notNull(),
    status: (0, pg_core_1.text)("status").notNull().default("PENDING"),
    decisionNote: (0, pg_core_1.text)("decisionNote"),
    createdAt: (0, pg_core_1.timestamp)("createdAt", { precision: 3 }).notNull().defaultNow(),
    updatedAt: (0, pg_core_1.timestamp)("updatedAt", { precision: 3 }).notNull().defaultNow(),
}, (table) => [(0, pg_core_1.uniqueIndex)("RefundRequest_purchaseId_key").on(table.purchaseId)]);
