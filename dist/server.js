"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const cors_1 = __importDefault(require("cors"));
const express_1 = __importDefault(require("express"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const client_s3_1 = require("@aws-sdk/client-s3");
const s3_presigned_post_1 = require("@aws-sdk/s3-presigned-post");
const node_stream_1 = require("node:stream");
const event_cover_read_js_1 = require("./event-cover-read.js");
const drizzle_orm_1 = require("drizzle-orm");
const node_crypto_1 = require("node:crypto");
const node_util_1 = require("node:util");
const db_js_1 = require("./db.js");
const schema_js_1 = require("./schema.js");
const zod_1 = require("zod");
const refund_status_js_1 = require("./refund-status.js");
const check_in_status_js_1 = require("./check-in-status.js");
const event_cover_upload_js_1 = require("./event-cover-upload.js");
const proxy_config_js_1 = require("./proxy-config.js");
const event_covers_js_1 = require("./event-covers.js");
const app = (0, express_1.default)();
(0, proxy_config_js_1.configureProxy)(app);
const port = Number(process.env.PORT ?? 4000);
const awsRegion = process.env.AWS_REGION;
const s3Bucket = process.env.AWS_S3_BUCKET;
const s3Client = new client_s3_1.S3Client({
    region: awsRegion || "us-east-1",
    ...(process.env.AWS_S3_ENDPOINT_URL
        ? {
            endpoint: process.env.AWS_S3_ENDPOINT_URL,
            forcePathStyle: process.env.AWS_S3_FORCE_PATH_STYLE === "true",
        }
        : {}),
});
const scrypt = (0, node_util_1.promisify)(node_crypto_1.scrypt);
const sessionSecret = process.env.SESSION_SECRET;
const corsOrigins = process.env.CORS_ORIGINS?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
if (!sessionSecret || sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must be configured with at least 32 characters");
}
const appSecret = (0, node_crypto_1.createHash)("sha256").update(sessionSecret).digest();
const credentialLimiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many sign-in attempts. Try again later." },
});
const bootstrapLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many setup attempts. Try again later." },
});
const coverUploadLimiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many image uploads. Try again later." },
});
function coverImageUrl(request, key) {
    if (!key || !s3Bucket)
        return null;
    const origin = process.env.PUBLIC_API_URL || process.env.RENDER_EXTERNAL_URL || `${request.protocol}://${request.get("host")}`;
    return (0, event_cover_read_js_1.publicCoverImageUrl)(origin, key);
}
async function verifyCoverImageKey(key, userId) {
    if (!s3Bucket || !awsRegion || !(0, event_covers_js_1.isOwnedCoverImageKey)(key, userId))
        return false;
    try {
        const metadata = await s3Client.send(new client_s3_1.HeadObjectCommand({ Bucket: s3Bucket, Key: key }));
        if (!metadata.ContentLength ||
            metadata.ContentLength > event_covers_js_1.maxCoverImageBytes ||
            !metadata.ContentType ||
            !(0, event_covers_js_1.isAllowedCoverImageType)(metadata.ContentType)) {
            await s3Client.send(new client_s3_1.DeleteObjectCommand({ Bucket: s3Bucket, Key: key }));
            return false;
        }
        const image = await s3Client.send(new client_s3_1.GetObjectCommand({ Bucket: s3Bucket, Key: key }));
        const bytes = await image.Body?.transformToByteArray();
        if (!bytes || !(0, event_covers_js_1.matchesImageSignature)(bytes, metadata.ContentType)) {
            await s3Client.send(new client_s3_1.DeleteObjectCommand({ Bucket: s3Bucket, Key: key }));
            return false;
        }
        return true;
    }
    catch {
        return false;
    }
}
function signToken(userId) {
    const payload = Buffer.from(JSON.stringify({ sub: userId, exp: Date.now() + 7 * 86400000 })).toString("base64url");
    const signature = (0, node_crypto_1.createHmac)("sha256", sessionSecret)
        .update(payload)
        .digest("base64url");
    return `${payload}.${signature}`;
}
function readToken(token) {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra)
        return null;
    const expected = (0, node_crypto_1.createHmac)("sha256", sessionSecret)
        .update(payload)
        .digest();
    const supplied = Buffer.from(signature, "base64url");
    if (expected.length !== supplied.length ||
        !(0, node_crypto_1.timingSafeEqual)(expected, supplied))
        return null;
    try {
        const parsed = JSON.parse(Buffer.from(payload, "base64url").toString());
        return typeof parsed.sub === "string" &&
            typeof parsed.exp === "number" &&
            parsed.exp > Date.now()
            ? { sub: parsed.sub, exp: parsed.exp }
            : null;
    }
    catch {
        return null;
    }
}
function encryptTicketToken(token) {
    const iv = (0, node_crypto_1.randomBytes)(12);
    const cipher = (0, node_crypto_1.createCipheriv)("aes-256-gcm", appSecret, iv);
    const encrypted = Buffer.concat([
        cipher.update(token, "utf8"),
        cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
}
function decryptTicketToken(value) {
    const data = Buffer.from(value, "base64url");
    const decipher = (0, node_crypto_1.createDecipheriv)("aes-256-gcm", appSecret, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([
        decipher.update(data.subarray(28)),
        decipher.final(),
    ]).toString("utf8");
}
async function hashPassword(password) {
    const salt = (0, node_crypto_1.randomBytes)(16);
    const hash = (await scrypt(password, salt, 64));
    return `${salt.toString("base64url")}.${hash.toString("base64url")}`;
}
async function verifyPassword(password, stored) {
    const [saltString, hashString] = stored.split(".");
    if (!saltString || !hashString)
        return false;
    const salt = Buffer.from(saltString, "base64url");
    const expected = Buffer.from(hashString, "base64url");
    const actual = (await scrypt(password, salt, expected.length));
    return expected.length === actual.length && (0, node_crypto_1.timingSafeEqual)(expected, actual);
}
async function sendEmail(to, subject, htmlContent) {
    const apiKey = process.env.BREVO_API_KEY;
    const sender = process.env.BREVO_FROM_EMAIL;
    if (!apiKey || !sender)
        throw new Error("Email delivery is not configured (BREVO_API_KEY and BREVO_FROM_EMAIL required)");
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "api-key": apiKey, "content-type": "application/json" },
        body: JSON.stringify({
            sender: {
                email: sender,
                name: process.env.BREVO_FROM_NAME ?? "Ticketing",
            },
            to: [{ email: to }],
            subject,
            htmlContent,
        }),
    });
    if (!response.ok) {
        const details = await response.text();
        console.error("Email provider rejected a message:", response.status, details);
        throw new Error("Email provider could not send the message");
    }
}
async function sendAccountToken(userId, email, purpose, targetEmail = null) {
    const rawToken = (0, node_crypto_1.randomBytes)(32).toString("base64url");
    const tokenHash = (0, node_crypto_1.createHash)("sha256").update(rawToken).digest("hex");
    await db_js_1.db
        .delete(schema_js_1.accountTokens)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.accountTokens.userId, userId), (0, drizzle_orm_1.eq)(schema_js_1.accountTokens.purpose, purpose)));
    await db_js_1.db.insert(schema_js_1.accountTokens).values({
        id: (0, node_crypto_1.randomUUID)(),
        userId,
        tokenHash,
        purpose,
        targetEmail,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const webOrigin = process.env.WEB_APP_URL ?? "http://localhost:5173";
    const link = `${webOrigin.replace(/\/+$/, "")}/account/${purpose === "RESET_PASSWORD" ? "reset-password" : "verify-email"}?token=${encodeURIComponent(rawToken)}`;
    try {
        await sendEmail(email, purpose === "RESET_PASSWORD"
            ? "Reset your ticketing password"
            : "Confirm your email address", `<p>Use this secure link within one hour:</p><p><a href="${link}">${purpose === "RESET_PASSWORD" ? "Reset password" : "Confirm email"}</a></p>`);
    }
    catch (error) {
        await db_js_1.db
            .delete(schema_js_1.accountTokens)
            .where((0, drizzle_orm_1.eq)(schema_js_1.accountTokens.tokenHash, tokenHash));
        throw error;
    }
}
async function authenticate(request, response, next) {
    const authorization = request.header("authorization");
    const token = authorization?.match(/^Bearer (.+)$/i)?.[1];
    const claims = token ? readToken(token) : null;
    if (!claims) {
        response.status(401).json({ error: "Sign in required" });
        return;
    }
    try {
        const [user] = await db_js_1.db
            .select({ id: schema_js_1.users.id, role: schema_js_1.users.role })
            .from(schema_js_1.users)
            .where((0, drizzle_orm_1.eq)(schema_js_1.users.id, claims.sub))
            .limit(1);
        if (!user) {
            response.status(401).json({ error: "Sign in required" });
            return;
        }
        request.auth = { userId: user.id, role: user.role };
        next();
    }
    catch (error) {
        next(error);
    }
}
const organizerOnly = [
    authenticate,
    (request, response, next) => {
        const role = request.auth?.role;
        if (role !== "ADMIN" && role !== "ORGANIZER") {
            response.status(403).json({ error: "Organizer access required" });
            return;
        }
        next();
    },
];
const adminOnly = [
    authenticate,
    (request, response, next) => {
        if (request.auth?.role !== "ADMIN") {
            response.status(403).json({ error: "Administrator access required" });
            return;
        }
        next();
    },
];
const eventOwnerOnly = [
    authenticate,
    (request, response, next) => {
        if (request.auth?.role !== "ORGANIZER") {
            response
                .status(403)
                .json({ error: "Only event owners can create events" });
            return;
        }
        next();
    },
];
const asyncRoute = (handler) => (request, response, next) => {
    void handler(request, response, next).catch(next);
};
async function paystackRequest(path, init) {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (!secret)
        throw new Error("Payment provider is not configured");
    const response = await fetch(`https://api.paystack.co${path}`, {
        ...init,
        headers: {
            authorization: `Bearer ${secret}`,
            "content-type": "application/json",
            ...init.headers,
        },
    });
    const body = (await response.json());
    if (!response.ok || !body.status)
        throw new Error(body.message ?? "Payment provider request failed");
    return body;
}
async function fulfilPurchase(reference, payment) {
    if (payment.status !== "success")
        return false;
    const fulfilled = await db_js_1.db.transaction(async (tx) => {
        const [purchase] = await tx
            .select()
            .from(schema_js_1.purchases)
            .where((0, drizzle_orm_1.eq)(schema_js_1.purchases.reference, reference))
            .limit(1);
        if (!purchase)
            return false;
        if (purchase.status === "PAID")
            return false;
        if (purchase.status !== "PENDING")
            return false;
        if (payment.amount !== purchase.amountMinor ||
            payment.currency !== purchase.currency)
            return false;
        const [updated] = await tx
            .update(schema_js_1.purchases)
            .set({ status: "PAID", updatedAt: new Date() })
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.purchases.id, purchase.id), (0, drizzle_orm_1.eq)(schema_js_1.purchases.status, "PENDING")))
            .returning({ id: schema_js_1.purchases.id });
        if (!updated)
            return false;
        await tx
            .update(schema_js_1.ticketTypes)
            .set({
            reserved: (0, drizzle_orm_1.sql) `${schema_js_1.ticketTypes.reserved} - ${purchase.quantity}`,
            sold: (0, drizzle_orm_1.sql) `${schema_js_1.ticketTypes.sold} + ${purchase.quantity}`,
        })
            .where((0, drizzle_orm_1.eq)(schema_js_1.ticketTypes.id, purchase.ticketTypeId));
        const ticketRows = Array.from({ length: purchase.quantity }, () => {
            const token = (0, node_crypto_1.randomBytes)(32).toString("base64url");
            return {
                id: (0, node_crypto_1.randomUUID)(),
                purchaseId: purchase.id,
                ownerId: purchase.userId,
                tokenHash: (0, node_crypto_1.createHash)("sha256").update(token).digest("hex"),
                encryptedToken: encryptTicketToken(token),
            };
        });
        await tx.insert(schema_js_1.tickets).values(ticketRows);
        return true;
    });
    if (fulfilled) {
        try {
            const [purchase] = await db_js_1.db
                .select({ userId: schema_js_1.purchases.userId })
                .from(schema_js_1.purchases)
                .where((0, drizzle_orm_1.eq)(schema_js_1.purchases.reference, reference))
                .limit(1);
            if (purchase?.userId)
                await sendPush(purchase.userId, "Tickets are ready", "Your purchased tickets are now in My Tickets.", { screen: "tickets" });
        }
        catch (error) {
            console.error("Could not send ticket-ready notification:", error);
        }
    }
    return fulfilled;
}
async function sendPush(userId, title, body, data) {
    const tokens = await db_js_1.db
        .select({ token: schema_js_1.pushTokens.token })
        .from(schema_js_1.pushTokens)
        .where((0, drizzle_orm_1.eq)(schema_js_1.pushTokens.userId, userId));
    if (!tokens.length)
        return;
    const response = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(tokens.map(({ token }) => ({
            to: token,
            sound: "default",
            title,
            body,
            data,
            channelId: "default",
        }))),
    });
    if (!response.ok) {
        const details = await response.text();
        console.error("Expo push service rejected notification:", response.status, details);
    }
}
async function releaseFailedPurchase(reference) {
    await db_js_1.db.transaction(async (tx) => {
        const [purchase] = await tx
            .update(schema_js_1.purchases)
            .set({ status: "FAILED", updatedAt: new Date() })
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.purchases.reference, reference), (0, drizzle_orm_1.eq)(schema_js_1.purchases.status, "PENDING")))
            .returning({
            id: schema_js_1.purchases.id,
            quantity: schema_js_1.purchases.quantity,
            ticketTypeId: schema_js_1.purchases.ticketTypeId,
            promoCodeId: schema_js_1.purchases.promoCodeId,
        });
        if (!purchase)
            return;
        await tx
            .update(schema_js_1.ticketTypes)
            .set({ reserved: (0, drizzle_orm_1.sql) `${schema_js_1.ticketTypes.reserved} - ${purchase.quantity}` })
            .where((0, drizzle_orm_1.eq)(schema_js_1.ticketTypes.id, purchase.ticketTypeId));
        if (purchase.promoCodeId) {
            await tx
                .update(schema_js_1.promotions)
                .set({ uses: (0, drizzle_orm_1.sql) `GREATEST(${schema_js_1.promotions.uses} - 1, 0)` })
                .where((0, drizzle_orm_1.eq)(schema_js_1.promotions.id, purchase.promoCodeId));
        }
    });
}
async function verifyPaystackPayment(reference) {
    const result = await paystackRequest(`/transaction/verify/${encodeURIComponent(reference)}`, { method: "GET" });
    if (!result.data || result.data.reference !== reference)
        return false;
    if (result.data.status === "success")
        return fulfilPurchase(reference, result.data);
    if (result.data.status === "failed" || result.data.status === "abandoned") {
        await releaseFailedPurchase(reference);
    }
    return false;
}
app.use((0, cors_1.default)({
    origin: (origin, callback) => callback(null, !origin || !corsOrigins?.length || corsOrigins.includes(origin)),
}));
app.get("/api/promotions/:code", asyncRoute(async (request, response) => {
    const code = String(request.params.code).toUpperCase();
    const ticketTypeId = typeof request.query.ticketTypeId === "string"
        ? request.query.ticketTypeId
        : "";
    const [promo] = await db_js_1.db
        .select()
        .from(schema_js_1.promotions)
        .where((0, drizzle_orm_1.eq)(schema_js_1.promotions.code, code))
        .limit(1);
    if (!promo ||
        (promo.expiresAt && promo.expiresAt <= new Date()) ||
        (promo.maxUses !== null && promo.uses >= promo.maxUses)) {
        response
            .status(404)
            .json({ error: "Promo code is invalid, expired, or fully redeemed" });
        return;
    }
    if (promo.eventId) {
        const [type] = await db_js_1.db
            .select({ eventId: schema_js_1.ticketTypes.eventId })
            .from(schema_js_1.ticketTypes)
            .where((0, drizzle_orm_1.eq)(schema_js_1.ticketTypes.id, ticketTypeId))
            .limit(1);
        if (!type || type.eventId !== promo.eventId) {
            response
                .status(400)
                .json({ error: "Promo code does not apply to this event" });
            return;
        }
    }
    response.json({ code: promo.code, percentOff: promo.percentOff });
}));
app.post("/api/payments/webhook", express_1.default.raw({ type: "application/json" }), asyncRoute(async (request, response) => {
    const signature = request.header("x-paystack-signature");
    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (!signature || !secret || !Buffer.isBuffer(request.body)) {
        response.status(400).json({ error: "Invalid payment webhook" });
        return;
    }
    const expected = (0, node_crypto_1.createHmac)("sha512", secret).update(request.body).digest();
    const supplied = Buffer.from(signature, "hex");
    if (expected.length !== supplied.length ||
        !(0, node_crypto_1.timingSafeEqual)(expected, supplied)) {
        response.status(401).json({ error: "Invalid webhook signature" });
        return;
    }
    const event = JSON.parse(request.body.toString());
    if (event.event === "charge.success" && event.data?.reference)
        await verifyPaystackPayment(event.data.reference);
    response.sendStatus(200);
}));
app.use(express_1.default.json({ limit: "32kb" }));
// Saved event covers are public; storage credentials and upload routes stay private.
app.use("/api/event-covers", (0, event_cover_read_js_1.createCoverReadRouter)({
    configured: Boolean(s3Bucket && awsRegion),
    isSaved: async (key) => {
        const [event] = await db_js_1.db.select({ id: schema_js_1.events.id }).from(schema_js_1.events)
            .where((0, drizzle_orm_1.eq)(schema_js_1.events.coverImageKey, key)).limit(1);
        return Boolean(event);
    },
    load: async (key) => {
        const image = await s3Client.send(new client_s3_1.GetObjectCommand({ Bucket: s3Bucket, Key: key }));
        if (!(image.Body instanceof node_stream_1.Readable))
            throw new Error("Missing image body");
        return { body: image.Body, contentType: image.ContentType ?? "", contentLength: image.ContentLength };
    },
}));
app.get("/api/health", (_request, response) => response.json({ status: "ok" }));
const credentialsSchema = zod_1.z.object({
    email: zod_1.z
        .string()
        .email()
        .max(254)
        .transform((email) => email.toLowerCase()),
    password: zod_1.z.string().min(10).max(128),
    name: zod_1.z.string().trim().min(1).max(100),
    referralCode: zod_1.z.string().trim().min(4).max(24).optional(),
});
app.post("/api/auth/register", credentialLimiter, asyncRoute(async (request, response) => {
    const parsed = credentialsSchema.safeParse(request.body);
    if (!parsed.success) {
        response.status(400).json({
            error: "Provide a valid name, email, and password (at least 10 characters)",
        });
        return;
    }
    const { email, password, name, referralCode } = parsed.data;
    const [existing] = await db_js_1.db
        .select({ id: schema_js_1.users.id })
        .from(schema_js_1.users)
        .where((0, drizzle_orm_1.eq)(schema_js_1.users.email, email))
        .limit(1);
    if (existing) {
        response
            .status(409)
            .json({ error: "An account with this email already exists" });
        return;
    }
    const [referrer] = referralCode
        ? await db_js_1.db
            .select({ id: schema_js_1.users.id })
            .from(schema_js_1.users)
            .where((0, drizzle_orm_1.eq)(schema_js_1.users.referralCode, referralCode.toUpperCase()))
            .limit(1)
        : [];
    const userId = (0, node_crypto_1.randomUUID)();
    const [user] = await db_js_1.db
        .insert(schema_js_1.users)
        .values({
        id: userId,
        email,
        name,
        passwordHash: await hashPassword(password),
        emailVerified: false,
        referralCode: `NR${(0, node_crypto_1.randomBytes)(5).toString("hex").toUpperCase()}`,
        referredById: referrer?.id ?? null,
        updatedAt: new Date(),
    })
        .returning({
        id: schema_js_1.users.id,
        email: schema_js_1.users.email,
        name: schema_js_1.users.name,
        role: schema_js_1.users.role,
        emailVerified: schema_js_1.users.emailVerified,
        referralCode: schema_js_1.users.referralCode,
    });
    let verificationEmailSent = false;
    try {
        await sendAccountToken(user.id, user.email, "VERIFY_EMAIL");
        verificationEmailSent = true;
    }
    catch (error) {
        console.error("Could not send signup verification email:", error);
    }
    response
        .status(201)
        .json({ token: signToken(user.id), user, verificationEmailSent });
}));
app.post("/api/admin/organizers", ...adminOnly, credentialLimiter, asyncRoute(async (request, response) => {
    const parsed = credentialsSchema.safeParse(request.body);
    if (!parsed.success) {
        response.status(400).json({
            error: "Provide a valid name, email, and password (at least 10 characters)",
        });
        return;
    }
    const { email, password, name } = parsed.data;
    try {
        const [user] = await db_js_1.db
            .insert(schema_js_1.users)
            .values({
            id: (0, node_crypto_1.randomUUID)(),
            email,
            name,
            passwordHash: await hashPassword(password),
            role: "ORGANIZER",
            updatedAt: new Date(),
        })
            .returning({
            id: schema_js_1.users.id,
            email: schema_js_1.users.email,
            name: schema_js_1.users.name,
            role: schema_js_1.users.role,
        });
        response.status(201).json({ user });
    }
    catch (error) {
        if (typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "23505") {
            response
                .status(409)
                .json({ error: "An account with this email already exists" });
            return;
        }
        throw error;
    }
}));
app.post("/api/auth/login", credentialLimiter, asyncRoute(async (request, response) => {
    const parsed = zod_1.z
        .object({
        email: zod_1.z
            .string()
            .email()
            .transform((email) => email.toLowerCase()),
        password: zod_1.z.string().min(1).max(128),
    })
        .safeParse(request.body);
    if (!parsed.success) {
        response.status(400).json({ error: "Enter a valid email and password" });
        return;
    }
    const [user] = await db_js_1.db
        .select()
        .from(schema_js_1.users)
        .where((0, drizzle_orm_1.eq)(schema_js_1.users.email, parsed.data.email))
        .limit(1);
    if (!user ||
        !(await verifyPassword(parsed.data.password, user.passwordHash))) {
        response.status(401).json({ error: "Email or password is incorrect" });
        return;
    }
    response.json({
        token: signToken(user.id),
        user: {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            emailVerified: user.emailVerified,
            referralCode: user.referralCode,
        },
    });
}));
app.post("/api/admin/bootstrap", bootstrapLimiter, asyncRoute(async (request, response) => {
    const secret = process.env.ADMIN_BOOTSTRAP_SECRET;
    const supplied = request.header("x-bootstrap-secret");
    if (!secret || !supplied) {
        response.status(404).json({ error: "Admin setup is disabled" });
        return;
    }
    const expectedBytes = Buffer.from(secret);
    const suppliedBytes = Buffer.from(supplied);
    if (expectedBytes.length !== suppliedBytes.length ||
        !(0, node_crypto_1.timingSafeEqual)(expectedBytes, suppliedBytes)) {
        response.status(401).json({ error: "Invalid setup secret" });
        return;
    }
    const parsed = credentialsSchema.safeParse(request.body);
    if (!parsed.success) {
        response.status(400).json({
            error: "Provide a valid name, email, and password (at least 10 characters)",
        });
        return;
    }
    const [existingAdmin] = await db_js_1.db
        .select({ id: schema_js_1.users.id })
        .from(schema_js_1.users)
        .where((0, drizzle_orm_1.eq)(schema_js_1.users.role, "ADMIN"))
        .limit(1);
    if (existingAdmin) {
        response
            .status(409)
            .json({ error: "An administrator is already configured" });
        return;
    }
    const { email, name, password } = parsed.data;
    const [user] = await db_js_1.db
        .insert(schema_js_1.users)
        .values({
        id: (0, node_crypto_1.randomUUID)(),
        email,
        name,
        passwordHash: await hashPassword(password),
        role: "ADMIN",
        updatedAt: new Date(),
    })
        .returning({
        id: schema_js_1.users.id,
        email: schema_js_1.users.email,
        name: schema_js_1.users.name,
        role: schema_js_1.users.role,
    });
    response.status(201).json({ token: signToken(user.id), user });
}));
app.get("/api/me", authenticate, asyncRoute(async (request, response) => {
    const { userId } = request.auth;
    const [user] = await db_js_1.db
        .select({
        id: schema_js_1.users.id,
        name: schema_js_1.users.name,
        email: schema_js_1.users.email,
        role: schema_js_1.users.role,
        emailVerified: schema_js_1.users.emailVerified,
        referralCode: schema_js_1.users.referralCode,
    })
        .from(schema_js_1.users)
        .where((0, drizzle_orm_1.eq)(schema_js_1.users.id, userId))
        .limit(1);
    response.json(user);
}));
app.patch("/api/me", authenticate, asyncRoute(async (request, response) => {
    const parsed = zod_1.z
        .object({ name: zod_1.z.string().trim().min(1).max(100) })
        .safeParse(request.body);
    if (!parsed.success) {
        response.status(400).json({ error: "Enter a valid name" });
        return;
    }
    const { userId } = request.auth;
    const [user] = await db_js_1.db
        .update(schema_js_1.users)
        .set({ name: parsed.data.name, updatedAt: new Date() })
        .where((0, drizzle_orm_1.eq)(schema_js_1.users.id, userId))
        .returning({
        id: schema_js_1.users.id,
        name: schema_js_1.users.name,
        email: schema_js_1.users.email,
        emailVerified: schema_js_1.users.emailVerified,
    });
    response.json(user);
}));
app.post("/api/me/change-email", authenticate, asyncRoute(async (request, response) => {
    const parsed = zod_1.z
        .object({
        email: zod_1.z
            .string()
            .email()
            .max(254)
            .transform((value) => value.toLowerCase()),
    })
        .safeParse(request.body);
    if (!parsed.success) {
        response.status(400).json({ error: "Enter a valid email address" });
        return;
    }
    const { userId } = request.auth;
    const [existing] = await db_js_1.db
        .select({ id: schema_js_1.users.id })
        .from(schema_js_1.users)
        .where((0, drizzle_orm_1.eq)(schema_js_1.users.email, parsed.data.email))
        .limit(1);
    if (existing) {
        response
            .status(409)
            .json({ error: "That email address is already in use" });
        return;
    }
    const [user] = await db_js_1.db
        .select({ email: schema_js_1.users.email })
        .from(schema_js_1.users)
        .where((0, drizzle_orm_1.eq)(schema_js_1.users.id, userId))
        .limit(1);
    if (!user) {
        response.status(404).json({ error: "Account not found" });
        return;
    }
    await sendAccountToken(userId, parsed.data.email, "VERIFY_EMAIL", parsed.data.email);
    response.json({
        message: "A verification link was sent to the new email address.",
    });
}));
app.post("/api/auth/forgot-password", credentialLimiter, asyncRoute(async (request, response) => {
    const parsed = zod_1.z
        .object({
        email: zod_1.z
            .string()
            .email()
            .max(254)
            .transform((value) => value.toLowerCase()),
    })
        .safeParse(request.body);
    if (!parsed.success) {
        response.status(400).json({ error: "Enter a valid email address" });
        return;
    }
    const [user] = await db_js_1.db
        .select({ id: schema_js_1.users.id, email: schema_js_1.users.email })
        .from(schema_js_1.users)
        .where((0, drizzle_orm_1.eq)(schema_js_1.users.email, parsed.data.email))
        .limit(1);
    if (user)
        await sendAccountToken(user.id, user.email, "RESET_PASSWORD");
    response.json({
        message: "If an account exists for that address, a password reset link has been sent.",
    });
}));
app.post("/api/auth/reset-password", credentialLimiter, asyncRoute(async (request, response) => {
    const parsed = zod_1.z
        .object({
        token: zod_1.z.string().min(32).max(128),
        password: zod_1.z.string().min(10).max(128),
    })
        .safeParse(request.body);
    if (!parsed.success) {
        response.status(400).json({
            error: "Provide a valid reset token and password of at least 10 characters",
        });
        return;
    }
    const tokenHash = (0, node_crypto_1.createHash)("sha256")
        .update(parsed.data.token)
        .digest("hex");
    const [token] = await db_js_1.db
        .select()
        .from(schema_js_1.accountTokens)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.accountTokens.tokenHash, tokenHash), (0, drizzle_orm_1.eq)(schema_js_1.accountTokens.purpose, "RESET_PASSWORD"), (0, drizzle_orm_1.gte)(schema_js_1.accountTokens.expiresAt, new Date())))
        .limit(1);
    if (!token) {
        response.status(400).json({ error: "Reset link is invalid or expired" });
        return;
    }
    await db_js_1.db.transaction(async (tx) => {
        await tx
            .update(schema_js_1.users)
            .set({
            passwordHash: await hashPassword(parsed.data.password),
            updatedAt: new Date(),
        })
            .where((0, drizzle_orm_1.eq)(schema_js_1.users.id, token.userId));
        await tx
            .delete(schema_js_1.accountTokens)
            .where((0, drizzle_orm_1.eq)(schema_js_1.accountTokens.userId, token.userId));
    });
    response.json({ message: "Password updated. You can now sign in." });
}));
app.post("/api/auth/verify-email", asyncRoute(async (request, response) => {
    const parsed = zod_1.z
        .object({ token: zod_1.z.string().min(32).max(128) })
        .safeParse(request.body);
    if (!parsed.success) {
        response.status(400).json({ error: "Invalid verification link" });
        return;
    }
    const tokenHash = (0, node_crypto_1.createHash)("sha256")
        .update(parsed.data.token)
        .digest("hex");
    const [token] = await db_js_1.db
        .select()
        .from(schema_js_1.accountTokens)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.accountTokens.tokenHash, tokenHash), (0, drizzle_orm_1.eq)(schema_js_1.accountTokens.purpose, "VERIFY_EMAIL"), (0, drizzle_orm_1.gte)(schema_js_1.accountTokens.expiresAt, new Date())))
        .limit(1);
    if (!token) {
        response
            .status(400)
            .json({ error: "Verification link is invalid or expired" });
        return;
    }
    await db_js_1.db.transaction(async (tx) => {
        await tx
            .update(schema_js_1.users)
            .set({
            ...(token.targetEmail ? { email: token.targetEmail } : {}),
            emailVerified: true,
            updatedAt: new Date(),
        })
            .where((0, drizzle_orm_1.eq)(schema_js_1.users.id, token.userId));
        await tx
            .delete(schema_js_1.accountTokens)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.accountTokens.userId, token.userId), (0, drizzle_orm_1.eq)(schema_js_1.accountTokens.purpose, "VERIFY_EMAIL")));
    });
    response.json({ message: "Email address verified." });
}));
app.post("/api/me/password", authenticate, asyncRoute(async (request, response) => {
    const parsed = zod_1.z
        .object({
        currentPassword: zod_1.z.string().min(1).max(128),
        newPassword: zod_1.z.string().min(10).max(128),
    })
        .safeParse(request.body);
    if (!parsed.success) {
        response.status(400).json({
            error: "Provide the current password and a new password of at least 10 characters",
        });
        return;
    }
    const { userId } = request.auth;
    const [user] = await db_js_1.db
        .select({ passwordHash: schema_js_1.users.passwordHash })
        .from(schema_js_1.users)
        .where((0, drizzle_orm_1.eq)(schema_js_1.users.id, userId))
        .limit(1);
    if (!user ||
        !(await verifyPassword(parsed.data.currentPassword, user.passwordHash))) {
        response.status(401).json({ error: "Current password is incorrect" });
        return;
    }
    await db_js_1.db
        .update(schema_js_1.users)
        .set({
        passwordHash: await hashPassword(parsed.data.newPassword),
        updatedAt: new Date(),
    })
        .where((0, drizzle_orm_1.eq)(schema_js_1.users.id, userId));
    response.json({ message: "Password updated." });
}));
app.post("/api/me/push-token", authenticate, asyncRoute(async (request, response) => {
    const parsed = zod_1.z
        .object({ token: zod_1.z.string().min(10).max(512) })
        .safeParse(request.body);
    if (!parsed.success) {
        response.status(400).json({ error: "Invalid push token" });
        return;
    }
    const { userId } = request.auth;
    await db_js_1.db
        .insert(schema_js_1.pushTokens)
        .values({ id: (0, node_crypto_1.randomUUID)(), userId, token: parsed.data.token })
        .onConflictDoUpdate({ target: schema_js_1.pushTokens.token, set: { userId } });
    response.status(204).end();
}));
app.post("/api/me/verify-email", authenticate, asyncRoute(async (request, response) => {
    const { userId } = request.auth;
    const [user] = await db_js_1.db
        .select({
        email: schema_js_1.users.email,
        emailVerified: schema_js_1.users.emailVerified,
    })
        .from(schema_js_1.users)
        .where((0, drizzle_orm_1.eq)(schema_js_1.users.id, userId))
        .limit(1);
    if (!user) {
        response.status(404).json({ error: "Account not found" });
        return;
    }
    if (user.emailVerified) {
        response
            .status(409)
            .json({ error: "Your email address is already verified" });
        return;
    }
    try {
        await sendAccountToken(userId, user.email, "VERIFY_EMAIL");
    }
    catch (error) {
        console.error("Could not send email verification link:", error);
        response.status(502).json({
            error: "Could not send a verification email. Please try again later.",
        });
        return;
    }
    response.json({
        message: "A verification link was sent to your email address.",
    });
}));
app.get("/api/me/favorites", authenticate, asyncRoute(async (request, response) => {
    const { userId } = request.auth;
    const rows = await db_js_1.db
        .select({ event: schema_js_1.events })
        .from(schema_js_1.favorites)
        .innerJoin(schema_js_1.events, (0, drizzle_orm_1.eq)(schema_js_1.favorites.eventId, schema_js_1.events.id))
        .where((0, drizzle_orm_1.eq)(schema_js_1.favorites.userId, userId))
        .orderBy((0, drizzle_orm_1.desc)(schema_js_1.favorites.createdAt));
    response.json(await Promise.all(rows.map(async ({ event }) => {
        const { coverImageKey, ...savedEvent } = event;
        return {
            ...savedEvent,
            coverImageUrl: coverImageUrl(request, coverImageKey),
        };
    })));
}));
app.post("/api/me/favorites/:eventId", authenticate, asyncRoute(async (request, response) => {
    const eventId = request.params.eventId;
    if (typeof eventId !== "string") {
        response.status(400).json({ error: "Invalid event id" });
        return;
    }
    const { userId } = request.auth;
    const [event] = await db_js_1.db
        .select({ id: schema_js_1.events.id })
        .from(schema_js_1.events)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.events.id, eventId), (0, drizzle_orm_1.eq)(schema_js_1.events.published, true)))
        .limit(1);
    if (!event) {
        response.status(404).json({ error: "Event not found" });
        return;
    }
    await db_js_1.db
        .insert(schema_js_1.favorites)
        .values({ userId, eventId })
        .onConflictDoNothing();
    response.sendStatus(204);
}));
app.delete("/api/me/favorites/:eventId", authenticate, asyncRoute(async (request, response) => {
    const eventId = request.params.eventId;
    if (typeof eventId !== "string") {
        response.status(400).json({ error: "Invalid event id" });
        return;
    }
    const { userId } = request.auth;
    await db_js_1.db
        .delete(schema_js_1.favorites)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.favorites.userId, userId), (0, drizzle_orm_1.eq)(schema_js_1.favorites.eventId, eventId)));
    response.sendStatus(204);
}));
app.get("/api/events", asyncRoute(async (request, response) => {
    const now = new Date();
    const search = typeof request.query.search === "string"
        ? request.query.search.trim().slice(0, 100)
        : "";
    const category = typeof request.query.category === "string"
        ? request.query.category.trim().slice(0, 80)
        : "";
    const minPriceRaw = request.query.minPrice;
    const maxPriceRaw = request.query.maxPrice;
    const minPrice = typeof minPriceRaw === "string" ? Number(minPriceRaw) : null;
    const maxPrice = typeof maxPriceRaw === "string" ? Number(maxPriceRaw) : null;
    if ((minPriceRaw !== undefined &&
        (minPrice === null || !Number.isFinite(minPrice) || minPrice < 0)) ||
        (maxPriceRaw !== undefined &&
            (maxPrice === null || !Number.isFinite(maxPrice) || maxPrice < 0)) ||
        (minPrice !== null && maxPrice !== null && maxPrice < minPrice)) {
        response.status(400).json({
            error: "Price filters must be non-negative values with maximum at least minimum",
        });
        return;
    }
    const eventRows = await db_js_1.db
        .select()
        .from(schema_js_1.events)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.events.published, true), (0, drizzle_orm_1.gte)(schema_js_1.events.startsAt, now), search ? (0, drizzle_orm_1.ilike)(schema_js_1.events.title, `%${search}%`) : undefined, category ? (0, drizzle_orm_1.eq)(schema_js_1.events.category, category) : undefined))
        .orderBy((0, drizzle_orm_1.asc)(schema_js_1.events.startsAt));
    const ids = eventRows.map((event) => event.id);
    const types = ids.length
        ? await db_js_1.db
            .select()
            .from(schema_js_1.ticketTypes)
            .where((0, drizzle_orm_1.inArray)(schema_js_1.ticketTypes.eventId, ids))
        : [];
    const results = eventRows
        .map((event) => ({
        ...event,
        ticketTypes: types
            .filter((type) => type.eventId === event.id)
            .map(({ quantity, sold, reserved, ...type }) => ({
            ...type,
            available: Math.max(0, quantity - sold - reserved),
        })),
    }))
        .filter((event) => event.ticketTypes.some((type) => {
        const minimumMatches = minPrice === null || type.priceMinor >= minPrice * 100;
        const maximumMatches = maxPrice === null || type.priceMinor <= maxPrice * 100;
        return minimumMatches && maximumMatches;
    }));
    response.json(await Promise.all(results.map(async (event) => {
        const { coverImageKey, ...publicEvent } = event;
        return {
            ...publicEvent,
            coverImageUrl: coverImageUrl(request, coverImageKey),
        };
    })));
}));
app.get("/api/events/:eventId", asyncRoute(async (request, response) => {
    const eventId = request.params.eventId;
    if (typeof eventId !== "string") {
        response.status(400).json({ error: "Invalid event id" });
        return;
    }
    const [event] = await db_js_1.db
        .select()
        .from(schema_js_1.events)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.events.id, eventId), (0, drizzle_orm_1.eq)(schema_js_1.events.published, true)))
        .limit(1);
    if (!event) {
        response.status(404).json({ error: "Event not found" });
        return;
    }
    const [types, reviewRows] = await Promise.all([
        db_js_1.db.select().from(schema_js_1.ticketTypes).where((0, drizzle_orm_1.eq)(schema_js_1.ticketTypes.eventId, event.id)),
        db_js_1.db
            .select({ rating: schema_js_1.reviews.rating })
            .from(schema_js_1.reviews)
            .where((0, drizzle_orm_1.eq)(schema_js_1.reviews.eventId, event.id)),
    ]);
    const [organizer] = event.createdById
        ? await db_js_1.db
            .select({ name: schema_js_1.users.name })
            .from(schema_js_1.users)
            .where((0, drizzle_orm_1.eq)(schema_js_1.users.id, event.createdById))
            .limit(1)
        : [];
    const { coverImageKey, ...publicEvent } = event;
    response.json({
        ...publicEvent,
        coverImageUrl: coverImageUrl(request, coverImageKey),
        organizerName: organizer?.name ?? null,
        ticketTypes: types.map(({ quantity, sold, reserved, ...type }) => ({
            ...type,
            available: Math.max(0, quantity - sold - reserved),
        })),
        averageRating: reviewRows.length
            ? reviewRows.reduce((total, review) => total + review.rating, 0) /
                reviewRows.length
            : null,
        reviewCount: reviewRows.length,
    });
}));
app.get("/api/events/:eventId/reviews", asyncRoute(async (request, response) => {
    const eventId = request.params.eventId;
    if (typeof eventId !== "string") {
        response.status(400).json({ error: "Invalid event id" });
        return;
    }
    const rows = await db_js_1.db
        .select({
        id: schema_js_1.reviews.id,
        rating: schema_js_1.reviews.rating,
        comment: schema_js_1.reviews.comment,
        createdAt: schema_js_1.reviews.createdAt,
        name: schema_js_1.users.name,
    })
        .from(schema_js_1.reviews)
        .innerJoin(schema_js_1.users, (0, drizzle_orm_1.eq)(schema_js_1.reviews.userId, schema_js_1.users.id))
        .innerJoin(schema_js_1.events, (0, drizzle_orm_1.eq)(schema_js_1.reviews.eventId, schema_js_1.events.id))
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.reviews.eventId, eventId), (0, drizzle_orm_1.eq)(schema_js_1.events.published, true)));
    response.json(rows);
}));
app.post("/api/events/:eventId/reviews", authenticate, asyncRoute(async (request, response) => {
    const eventId = request.params.eventId;
    if (typeof eventId !== "string") {
        response.status(400).json({ error: "Invalid event id" });
        return;
    }
    const parsed = zod_1.z
        .object({
        rating: zod_1.z.number().int().min(1).max(5),
        comment: zod_1.z.string().trim().max(1000).optional(),
    })
        .safeParse(request.body);
    if (!parsed.success) {
        response.status(400).json({
            error: "Provide a rating from 1 to 5 and an optional comment up to 1000 characters",
        });
        return;
    }
    const { userId } = request.auth;
    const [eligible] = await db_js_1.db
        .select({ id: schema_js_1.purchases.id })
        .from(schema_js_1.purchases)
        .innerJoin(schema_js_1.ticketTypes, (0, drizzle_orm_1.eq)(schema_js_1.purchases.ticketTypeId, schema_js_1.ticketTypes.id))
        .innerJoin(schema_js_1.events, (0, drizzle_orm_1.eq)(schema_js_1.ticketTypes.eventId, schema_js_1.events.id))
        .innerJoin(schema_js_1.tickets, (0, drizzle_orm_1.eq)(schema_js_1.tickets.purchaseId, schema_js_1.purchases.id))
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.purchases.status, "PAID"), (0, drizzle_orm_1.eq)(schema_js_1.events.id, eventId), (0, drizzle_orm_1.or)((0, drizzle_orm_1.eq)(schema_js_1.tickets.ownerId, userId), (0, drizzle_orm_1.and)((0, drizzle_orm_1.isNull)(schema_js_1.tickets.ownerId), (0, drizzle_orm_1.eq)(schema_js_1.purchases.userId, userId))), (0, drizzle_orm_1.sql) `COALESCE(${schema_js_1.events.endsAt}, ${schema_js_1.events.startsAt}) <= ${new Date()}`))
        .limit(1);
    if (!eligible) {
        response.status(403).json({
            error: "Only customers with a paid ticket can review an event after it ends",
        });
        return;
    }
    const [review] = await db_js_1.db
        .insert(schema_js_1.reviews)
        .values({
        id: (0, node_crypto_1.randomUUID)(),
        eventId,
        userId,
        rating: parsed.data.rating,
        comment: parsed.data.comment || null,
        updatedAt: new Date(),
    })
        .onConflictDoUpdate({
        target: [schema_js_1.reviews.eventId, schema_js_1.reviews.userId],
        set: {
            rating: parsed.data.rating,
            comment: parsed.data.comment || null,
            updatedAt: new Date(),
        },
    })
        .returning();
    response.status(201).json(review);
}));
const ticketTypeInput = zod_1.z.object({
    name: zod_1.z.string().trim().min(1).max(100),
    priceMinor: zod_1.z.number().int().min(0).max(100_000_000),
    currency: zod_1.z
        .string()
        .length(3)
        .transform((currency) => currency.toUpperCase())
        .default("GHS"),
    quantity: zod_1.z.number().int().min(1).max(100_000),
});
const eventInput = zod_1.z.object({
    title: zod_1.z.string().trim().min(1).max(160),
    description: zod_1.z.string().trim().max(5000).nullable().optional(),
    coverImageKey: zod_1.z
        .string()
        .max(128)
        .regex(/^[A-Za-z0-9_-]+\/[a-f0-9-]{36}\.(jpg|png|webp)$/i)
        .nullable()
        .optional(),
    venue: zod_1.z.string().trim().min(1).max(250),
    category: zod_1.z.string().trim().min(1).max(80).default("Other"),
    agenda: zod_1.z.string().trim().max(5000).nullable().optional(),
    accessibility: zod_1.z.string().trim().max(2000).nullable().optional(),
    refundPolicy: zod_1.z.string().trim().max(2000).nullable().optional(),
    startsAt: zod_1.z.coerce.date(),
    endsAt: zod_1.z.coerce.date().nullable().optional(),
    published: zod_1.z.boolean().default(false),
    ticketTypes: zod_1.z.array(ticketTypeInput).min(1).max(30),
});
app.use("/api/admin/event-covers/content", ...organizerOnly, coverUploadLimiter, (0, event_cover_upload_js_1.createCoverUploadRouter)({
    configured: Boolean(s3Bucket && awsRegion),
    save: async (request, bytes, contentType) => {
        const { userId } = request.auth;
        const extension = event_covers_js_1.coverImageTypes[contentType];
        const key = `${userId}/${(0, node_crypto_1.randomUUID)()}.${extension}`;
        await s3Client.send(new client_s3_1.PutObjectCommand({
            Bucket: s3Bucket,
            Key: key,
            Body: bytes,
            ContentType: contentType,
        }));
        return key;
    },
}));
const coverUploadInput = zod_1.z.object({
    contentType: zod_1.z.enum(["image/jpeg", "image/jpg", "image/png", "image/webp"]),
});
app.post("/api/admin/event-covers/upload", ...organizerOnly, coverUploadLimiter, asyncRoute(async (request, response) => {
    const parsed = coverUploadInput.safeParse(request.body);
    if (!parsed.success) {
        response.status(400).json({ error: "Choose a JPG/JPEG, PNG, or WebP image" });
        return;
    }
    if (!s3Bucket || !awsRegion) {
        response
            .status(503)
            .json({ error: "Event image storage is not configured" });
        return;
    }
    const { userId } = request.auth;
    const contentType = parsed.data.contentType === "image/jpg" ? "image/jpeg" : parsed.data.contentType;
    const extension = event_covers_js_1.coverImageTypes[contentType];
    const key = `${userId}/${(0, node_crypto_1.randomUUID)()}.${extension}`;
    const upload = await (0, s3_presigned_post_1.createPresignedPost)(s3Client, {
        Bucket: s3Bucket,
        Key: key,
        Expires: 300,
        Fields: { "Content-Type": contentType },
        Conditions: [
            ["content-length-range", 1, event_covers_js_1.maxCoverImageBytes],
            ["eq", "$Content-Type", contentType],
            ["eq", "$key", key],
        ],
    });
    response.json({ uploadUrl: upload.url, fields: upload.fields, key });
}));
app.get("/api/admin/events", ...organizerOnly, asyncRoute(async (request, response) => {
    const { userId, role } = request.auth;
    const eventRows = await db_js_1.db
        .select()
        .from(schema_js_1.events)
        .where(role === "ADMIN" ? undefined : (0, drizzle_orm_1.eq)(schema_js_1.events.createdById, userId))
        .orderBy((0, drizzle_orm_1.desc)(schema_js_1.events.startsAt));
    const ids = eventRows.map((event) => event.id);
    const types = ids.length
        ? await db_js_1.db
            .select()
            .from(schema_js_1.ticketTypes)
            .where((0, drizzle_orm_1.inArray)(schema_js_1.ticketTypes.eventId, ids))
        : [];
    response.json(await Promise.all(eventRows.map(async (event) => ({
        ...event,
        coverImageUrl: coverImageUrl(request, event.coverImageKey),
        ticketTypes: types.filter((type) => type.eventId === event.id),
    }))));
}));
app.post("/api/admin/events", ...eventOwnerOnly, asyncRoute(async (request, response) => {
    const parsed = eventInput.safeParse(request.body);
    if (!parsed.success) {
        response.status(400).json({
            error: "Provide event details and at least one valid ticket type",
        });
        return;
    }
    const { ticketTypes: typeRows, ...event } = parsed.data;
    if (event.coverImageKey &&
        !(await verifyCoverImageKey(event.coverImageKey, request.auth.userId))) {
        response
            .status(400)
            .json({ error: "Upload a valid event cover image before saving" });
        return;
    }
    if (event.endsAt && event.endsAt <= event.startsAt) {
        response
            .status(400)
            .json({ error: "Event end time must be later than its start time" });
        return;
    }
    if (event.published &&
        (event.startsAt <= new Date() || typeRows.length === 0)) {
        response.status(400).json({
            error: "Add at least one ticket type and choose a future start time before publishing",
        });
        return;
    }
    const { userId } = request.auth;
    const created = await db_js_1.db.transaction(async (tx) => {
        const id = (0, node_crypto_1.randomUUID)();
        const [createdEvent] = await tx
            .insert(schema_js_1.events)
            .values({ ...event, id, createdById: userId, updatedAt: new Date() })
            .returning();
        const createdTypes = await tx
            .insert(schema_js_1.ticketTypes)
            .values(typeRows.map((type) => ({ ...type, id: (0, node_crypto_1.randomUUID)(), eventId: id })))
            .returning();
        return { ...createdEvent, ticketTypes: createdTypes };
    });
    response.status(201).json({
        ...created,
        coverImageUrl: coverImageUrl(request, created.coverImageKey),
    });
}));
app.put("/api/admin/events/:eventId", ...organizerOnly, asyncRoute(async (request, response) => {
    const eventId = request.params.eventId;
    if (typeof eventId !== "string") {
        response.status(400).json({ error: "Invalid event id" });
        return;
    }
    const parsed = eventInput.partial().safeParse(request.body);
    if (!parsed.success || Object.keys(parsed.data ?? {}).length === 0) {
        response.status(400).json({ error: "Invalid event details" });
        return;
    }
    const { ticketTypes: typeRows, ...event } = parsed.data;
    const { userId, role } = request.auth;
    if (event.coverImageKey &&
        !(await verifyCoverImageKey(event.coverImageKey, userId))) {
        response
            .status(400)
            .json({ error: "Upload a valid event cover image before saving" });
        return;
    }
    if (role === "ADMIN" && event.published !== undefined) {
        response
            .status(403)
            .json({ error: "Only event owners can publish or unpublish events" });
        return;
    }
    const updated = await db_js_1.db.transaction(async (tx) => {
        const scope = role === "ADMIN"
            ? (0, drizzle_orm_1.eq)(schema_js_1.events.id, eventId)
            : (0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.events.id, eventId), (0, drizzle_orm_1.eq)(schema_js_1.events.createdById, userId));
        const [current] = await tx.select().from(schema_js_1.events).where(scope).limit(1);
        if (!current)
            return {
                event: null,
                invalidSchedule: false,
                invalidPublication: false,
            };
        const startsAt = event.startsAt ?? current.startsAt;
        const endsAt = event.endsAt === undefined ? current.endsAt : event.endsAt;
        if (endsAt && endsAt <= startsAt)
            return {
                event: null,
                invalidSchedule: true,
                invalidPublication: false,
            };
        if (event.published === true && !current.published) {
            const ticketTypesForEvent = await tx
                .select({ id: schema_js_1.ticketTypes.id })
                .from(schema_js_1.ticketTypes)
                .where((0, drizzle_orm_1.eq)(schema_js_1.ticketTypes.eventId, eventId))
                .limit(1);
            if (startsAt <= new Date() || ticketTypesForEvent.length === 0) {
                return {
                    event: null,
                    invalidSchedule: false,
                    invalidPublication: true,
                };
            }
        }
        const [updatedEvent] = await tx
            .update(schema_js_1.events)
            .set({ ...event, updatedAt: new Date() })
            .where(scope)
            .returning();
        if (!updatedEvent)
            return {
                event: null,
                invalidSchedule: false,
                invalidPublication: false,
            };
        const createdTypes = typeRows?.length
            ? await tx
                .insert(schema_js_1.ticketTypes)
                .values(typeRows.map((type) => ({ ...type, id: (0, node_crypto_1.randomUUID)(), eventId })))
                .returning()
            : [];
        const existingTypes = createdTypes.length
            ? createdTypes
            : await tx
                .select()
                .from(schema_js_1.ticketTypes)
                .where((0, drizzle_orm_1.eq)(schema_js_1.ticketTypes.eventId, eventId));
        return {
            event: { ...updatedEvent, ticketTypes: existingTypes },
            invalidSchedule: false,
            invalidPublication: false,
        };
    });
    if (updated.invalidSchedule) {
        response
            .status(400)
            .json({ error: "Event end time must be later than its start time" });
        return;
    }
    if (updated.invalidPublication) {
        response.status(400).json({
            error: "Add at least one ticket type and choose a future start time before publishing",
        });
        return;
    }
    if (!updated.event) {
        response.status(404).json({ error: "Event not found" });
        return;
    }
    response.json({
        ...updated.event,
        coverImageUrl: coverImageUrl(request, updated.event.coverImageKey),
    });
}));
app.delete("/api/admin/events/:eventId", ...organizerOnly, asyncRoute(async (request, response) => {
    const eventId = request.params.eventId;
    if (typeof eventId !== "string") {
        response.status(400).json({ error: "Invalid event id" });
        return;
    }
    const { userId, role } = request.auth;
    const [deleted] = await db_js_1.db
        .delete(schema_js_1.events)
        .where(role === "ADMIN"
        ? (0, drizzle_orm_1.eq)(schema_js_1.events.id, eventId)
        : (0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.events.id, eventId), (0, drizzle_orm_1.eq)(schema_js_1.events.createdById, userId)))
        .returning({ id: schema_js_1.events.id });
    if (!deleted) {
        response.status(404).json({ error: "Event not found" });
        return;
    }
    response.sendStatus(204);
}));
app.patch("/api/admin/ticket-types/:ticketTypeId", ...organizerOnly, asyncRoute(async (request, response) => {
    const ticketTypeId = request.params.ticketTypeId;
    if (typeof ticketTypeId !== "string") {
        response.status(400).json({ error: "Invalid ticket type id" });
        return;
    }
    const parsed = ticketTypeInput.partial().safeParse(request.body);
    if (!parsed.success || Object.keys(parsed.data ?? {}).length === 0) {
        response.status(400).json({ error: "Provide valid ticket type details" });
        return;
    }
    const { userId, role } = request.auth;
    const updated = await db_js_1.db.transaction(async (tx) => {
        const [current] = await tx
            .select({ type: schema_js_1.ticketTypes, ownerId: schema_js_1.events.createdById })
            .from(schema_js_1.ticketTypes)
            .innerJoin(schema_js_1.events, (0, drizzle_orm_1.eq)(schema_js_1.ticketTypes.eventId, schema_js_1.events.id))
            .where((0, drizzle_orm_1.eq)(schema_js_1.ticketTypes.id, ticketTypeId))
            .limit(1);
        if (!current)
            return { type: null, invalidCapacity: false };
        if (role !== "ADMIN" && current.ownerId !== userId)
            return { type: null, invalidCapacity: false };
        const quantity = parsed.data.quantity ?? current.type.quantity;
        if (quantity < current.type.sold + current.type.reserved)
            return { type: null, invalidCapacity: true };
        const [type] = await tx
            .update(schema_js_1.ticketTypes)
            .set(parsed.data)
            .where((0, drizzle_orm_1.eq)(schema_js_1.ticketTypes.id, ticketTypeId))
            .returning();
        return { type, invalidCapacity: false };
    });
    if (updated.invalidCapacity) {
        response.status(409).json({
            error: "Capacity cannot be lower than sold and reserved tickets",
        });
        return;
    }
    if (!updated.type) {
        response.status(404).json({ error: "Ticket type not found" });
        return;
    }
    response.json(updated.type);
}));
app.get("/api/admin/summary", ...organizerOnly, asyncRoute(async (request, response) => {
    const { userId, role } = request.auth;
    const eventScope = role === "ADMIN" ? undefined : (0, drizzle_orm_1.eq)(schema_js_1.events.createdById, userId);
    const purchaseScope = role === "ADMIN" ? undefined : (0, drizzle_orm_1.eq)(schema_js_1.events.createdById, userId);
    const [eventCount] = await db_js_1.db
        .select({ value: (0, drizzle_orm_1.count)() })
        .from(schema_js_1.events)
        .where(eventScope);
    const [paidPurchases] = await db_js_1.db
        .select({ value: (0, drizzle_orm_1.count)() })
        .from(schema_js_1.purchases)
        .innerJoin(schema_js_1.ticketTypes, (0, drizzle_orm_1.eq)(schema_js_1.purchases.ticketTypeId, schema_js_1.ticketTypes.id))
        .innerJoin(schema_js_1.events, (0, drizzle_orm_1.eq)(schema_js_1.ticketTypes.eventId, schema_js_1.events.id))
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.purchases.status, "PAID"), purchaseScope));
    const [ticketCount] = await db_js_1.db
        .select({ value: (0, drizzle_orm_1.count)() })
        .from(schema_js_1.tickets)
        .innerJoin(schema_js_1.purchases, (0, drizzle_orm_1.eq)(schema_js_1.tickets.purchaseId, schema_js_1.purchases.id))
        .innerJoin(schema_js_1.ticketTypes, (0, drizzle_orm_1.eq)(schema_js_1.purchases.ticketTypeId, schema_js_1.ticketTypes.id))
        .innerJoin(schema_js_1.events, (0, drizzle_orm_1.eq)(schema_js_1.ticketTypes.eventId, schema_js_1.events.id))
        .where(purchaseScope);
    const [checkedInCount] = await db_js_1.db
        .select({ value: (0, drizzle_orm_1.count)() })
        .from(schema_js_1.tickets)
        .innerJoin(schema_js_1.purchases, (0, drizzle_orm_1.eq)(schema_js_1.tickets.purchaseId, schema_js_1.purchases.id))
        .innerJoin(schema_js_1.ticketTypes, (0, drizzle_orm_1.eq)(schema_js_1.purchases.ticketTypeId, schema_js_1.ticketTypes.id))
        .innerJoin(schema_js_1.events, (0, drizzle_orm_1.eq)(schema_js_1.ticketTypes.eventId, schema_js_1.events.id))
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.isNotNull)(schema_js_1.tickets.checkedInAt), (0, drizzle_orm_1.isNull)(schema_js_1.tickets.checkedOutAt), purchaseScope));
    const [ticketsEverCheckedIn] = await db_js_1.db
        .select({ value: (0, drizzle_orm_1.count)() })
        .from(schema_js_1.tickets)
        .innerJoin(schema_js_1.purchases, (0, drizzle_orm_1.eq)(schema_js_1.tickets.purchaseId, schema_js_1.purchases.id))
        .innerJoin(schema_js_1.ticketTypes, (0, drizzle_orm_1.eq)(schema_js_1.purchases.ticketTypeId, schema_js_1.ticketTypes.id))
        .innerJoin(schema_js_1.events, (0, drizzle_orm_1.eq)(schema_js_1.ticketTypes.eventId, schema_js_1.events.id))
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.isNotNull)(schema_js_1.tickets.checkedInAt), purchaseScope));
    const [totalCheckIns] = await db_js_1.db
        .select({ value: (0, drizzle_orm_1.count)() })
        .from(schema_js_1.checkInLogs)
        .innerJoin(schema_js_1.events, (0, drizzle_orm_1.eq)(schema_js_1.checkInLogs.eventId, schema_js_1.events.id))
        .where(eventScope);
    const [legacyCheckIns] = await db_js_1.db
        .select({ value: (0, drizzle_orm_1.count)() })
        .from(schema_js_1.tickets)
        .innerJoin(schema_js_1.purchases, (0, drizzle_orm_1.eq)(schema_js_1.tickets.purchaseId, schema_js_1.purchases.id))
        .innerJoin(schema_js_1.ticketTypes, (0, drizzle_orm_1.eq)(schema_js_1.purchases.ticketTypeId, schema_js_1.ticketTypes.id))
        .innerJoin(schema_js_1.events, (0, drizzle_orm_1.eq)(schema_js_1.ticketTypes.eventId, schema_js_1.events.id))
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.isNotNull)(schema_js_1.tickets.checkedInAt), purchaseScope, (0, drizzle_orm_1.sql) `NOT EXISTS (SELECT 1 FROM "TicketCheckIn" WHERE "TicketCheckIn"."ticketId" = ${schema_js_1.tickets.id})`));
    const revenue = await db_js_1.db
        .select({
        currency: schema_js_1.purchases.currency,
        amountMinor: (0, drizzle_orm_1.sum)(schema_js_1.purchases.amountMinor),
    })
        .from(schema_js_1.purchases)
        .innerJoin(schema_js_1.ticketTypes, (0, drizzle_orm_1.eq)(schema_js_1.purchases.ticketTypeId, schema_js_1.ticketTypes.id))
        .innerJoin(schema_js_1.events, (0, drizzle_orm_1.eq)(schema_js_1.ticketTypes.eventId, schema_js_1.events.id))
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.purchases.status, "PAID"), purchaseScope))
        .groupBy(schema_js_1.purchases.currency);
    response.json({
        eventCount: eventCount.value,
        paidPurchases: paidPurchases.value,
        ticketCount: ticketCount.value,
        checkedInCount: checkedInCount.value,
        ticketsEverCheckedIn: ticketsEverCheckedIn.value,
        totalCheckIns: totalCheckIns.value + legacyCheckIns.value,
        revenueByCurrency: revenue.map((item) => ({
            currency: item.currency,
            amountMinor: Number(item.amountMinor ?? 0),
        })),
    });
}));
app.get("/api/admin/purchases", ...organizerOnly, asyncRoute(async (request, response) => {
    const { userId, role } = request.auth;
    const rows = await db_js_1.db
        .select({
        reference: schema_js_1.purchases.reference,
        customer: schema_js_1.users.name,
        email: schema_js_1.purchases.email,
        event: schema_js_1.events.title,
        ticketType: schema_js_1.ticketTypes.name,
        quantity: schema_js_1.purchases.quantity,
        amountMinor: schema_js_1.purchases.amountMinor,
        currency: schema_js_1.purchases.currency,
        createdAt: schema_js_1.purchases.createdAt,
    })
        .from(schema_js_1.purchases)
        .innerJoin(schema_js_1.ticketTypes, (0, drizzle_orm_1.eq)(schema_js_1.purchases.ticketTypeId, schema_js_1.ticketTypes.id))
        .innerJoin(schema_js_1.events, (0, drizzle_orm_1.eq)(schema_js_1.ticketTypes.eventId, schema_js_1.events.id))
        .leftJoin(schema_js_1.users, (0, drizzle_orm_1.eq)(schema_js_1.purchases.userId, schema_js_1.users.id))
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.purchases.status, "PAID"), role === "ADMIN" ? undefined : (0, drizzle_orm_1.eq)(schema_js_1.events.createdById, userId)))
        .orderBy((0, drizzle_orm_1.desc)(schema_js_1.purchases.createdAt))
        .limit(100);
    response.json(rows.map((row) => ({
        ...row,
        customer: row.customer ?? "Legacy customer",
    })));
}));
app.get("/api/admin/promotions", ...organizerOnly, asyncRoute(async (request, response) => {
    const { userId, role } = request.auth;
    const rows = await db_js_1.db
        .select()
        .from(schema_js_1.promotions)
        .where(role === "ADMIN" ? undefined : (0, drizzle_orm_1.eq)(schema_js_1.promotions.createdById, userId))
        .orderBy((0, drizzle_orm_1.desc)(schema_js_1.promotions.createdAt));
    response.json(rows);
}));
app.post("/api/admin/promotions", ...organizerOnly, asyncRoute(async (request, response) => {
    const { userId, role } = request.auth;
    if (role !== "ORGANIZER") {
        response
            .status(403)
            .json({ error: "Only event owners can create promo codes" });
        return;
    }
    const parsed = zod_1.z
        .object({
        code: zod_1.z
            .string()
            .trim()
            .min(4)
            .max(24)
            .regex(/^[a-zA-Z0-9_-]+$/)
            .transform((value) => value.toUpperCase()),
        percentOff: zod_1.z.number().int().min(1).max(90),
        eventId: zod_1.z.string().min(1).optional(),
        maxUses: zod_1.z.number().int().min(1).max(100000).nullable().optional(),
        expiresAt: zod_1.z.coerce.date().nullable().optional(),
    })
        .safeParse(request.body);
    if (!parsed.success) {
        response.status(400).json({
            error: "Provide a 4–24 character code and a discount from 1% to 90%",
        });
        return;
    }
    if (parsed.data.eventId) {
        const [event] = await db_js_1.db
            .select({ id: schema_js_1.events.id })
            .from(schema_js_1.events)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.events.id, parsed.data.eventId), (0, drizzle_orm_1.eq)(schema_js_1.events.createdById, userId)))
            .limit(1);
        if (!event) {
            response.status(404).json({ error: "Event not found" });
            return;
        }
    }
    const [promo] = await db_js_1.db
        .insert(schema_js_1.promotions)
        .values({ ...parsed.data, id: (0, node_crypto_1.randomUUID)(), createdById: userId })
        .returning();
    response.status(201).json(promo);
}));
app.post("/api/me/refund-requests", authenticate, asyncRoute(async (request, response) => {
    const parsed = zod_1.z
        .object({
        purchaseId: zod_1.z.string().min(1),
        reason: zod_1.z.string().trim().min(5).max(1000),
    })
        .safeParse(request.body);
    if (!parsed.success) {
        response
            .status(400)
            .json({ error: "Provide a reason between 5 and 1000 characters" });
        return;
    }
    const { userId } = request.auth;
    const [purchase] = await db_js_1.db
        .select({
        id: schema_js_1.purchases.id,
        userId: schema_js_1.purchases.userId,
        status: schema_js_1.purchases.status,
    })
        .from(schema_js_1.purchases)
        .where((0, drizzle_orm_1.eq)(schema_js_1.purchases.id, parsed.data.purchaseId))
        .limit(1);
    if (!purchase || purchase.userId !== userId || purchase.status !== "PAID") {
        response.status(404).json({ error: "Paid purchase not found" });
        return;
    }
    const [refund] = await db_js_1.db
        .insert(schema_js_1.refundRequests)
        .values({
        id: (0, node_crypto_1.randomUUID)(),
        purchaseId: purchase.id,
        userId,
        reason: parsed.data.reason,
    })
        .onConflictDoNothing()
        .returning();
    if (!refund) {
        response
            .status(409)
            .json({ error: "A refund request already exists for this purchase" });
        return;
    }
    response.status(201).json(refund);
}));
app.get("/api/me/refund-requests", authenticate, asyncRoute(async (request, response) => {
    const { userId } = request.auth;
    const rows = await db_js_1.db
        .select({ request: schema_js_1.refundRequests, reference: schema_js_1.purchases.reference })
        .from(schema_js_1.refundRequests)
        .innerJoin(schema_js_1.purchases, (0, drizzle_orm_1.eq)(schema_js_1.refundRequests.purchaseId, schema_js_1.purchases.id))
        .where((0, drizzle_orm_1.eq)(schema_js_1.refundRequests.userId, userId))
        .orderBy((0, drizzle_orm_1.desc)(schema_js_1.refundRequests.createdAt));
    response.json(rows.map((row) => ({ ...row.request, reference: row.reference })));
}));
app.get("/api/admin/refund-requests", ...organizerOnly, asyncRoute(async (request, response) => {
    const { userId, role } = request.auth;
    const rows = await db_js_1.db
        .select({
        request: schema_js_1.refundRequests,
        reference: schema_js_1.purchases.reference,
        email: schema_js_1.purchases.email,
        eventId: schema_js_1.events.id,
        event: schema_js_1.events.title,
    })
        .from(schema_js_1.refundRequests)
        .innerJoin(schema_js_1.purchases, (0, drizzle_orm_1.eq)(schema_js_1.refundRequests.purchaseId, schema_js_1.purchases.id))
        .innerJoin(schema_js_1.ticketTypes, (0, drizzle_orm_1.eq)(schema_js_1.purchases.ticketTypeId, schema_js_1.ticketTypes.id))
        .innerJoin(schema_js_1.events, (0, drizzle_orm_1.eq)(schema_js_1.ticketTypes.eventId, schema_js_1.events.id))
        .where(role === "ADMIN" ? undefined : (0, drizzle_orm_1.eq)(schema_js_1.events.createdById, userId))
        .orderBy((0, drizzle_orm_1.desc)(schema_js_1.refundRequests.createdAt));
    response.json(rows.map((row) => ({
        ...row.request,
        reference: row.reference,
        email: row.email,
        eventId: row.eventId,
        event: row.event,
    })));
}));
app.patch("/api/admin/refund-requests/:requestId", ...organizerOnly, asyncRoute(async (request, response) => {
    const requestId = request.params.requestId;
    if (typeof requestId !== "string") {
        response.status(400).json({ error: "Invalid refund request id" });
        return;
    }
    const parsed = zod_1.z
        .object({
        status: zod_1.z.enum(["APPROVED", "REJECTED"]),
        decisionNote: zod_1.z.string().trim().max(1000).optional(),
    })
        .safeParse(request.body);
    if (!parsed.success) {
        response.status(400).json({
            error: "Choose approved or rejected with an optional note",
        });
        return;
    }
    const { userId, role } = request.auth;
    const [current] = await db_js_1.db
        .select({ ownerId: schema_js_1.events.createdById, request: schema_js_1.refundRequests })
        .from(schema_js_1.refundRequests)
        .innerJoin(schema_js_1.purchases, (0, drizzle_orm_1.eq)(schema_js_1.refundRequests.purchaseId, schema_js_1.purchases.id))
        .innerJoin(schema_js_1.ticketTypes, (0, drizzle_orm_1.eq)(schema_js_1.purchases.ticketTypeId, schema_js_1.ticketTypes.id))
        .innerJoin(schema_js_1.events, (0, drizzle_orm_1.eq)(schema_js_1.ticketTypes.eventId, schema_js_1.events.id))
        .where((0, drizzle_orm_1.eq)(schema_js_1.refundRequests.id, requestId))
        .limit(1);
    if (!current || (role !== "ADMIN" && current.ownerId !== userId)) {
        response.status(404).json({ error: "Refund request not found" });
        return;
    }
    if (!(0, refund_status_js_1.canReviewRefundStatus)(current.request.status)) {
        response.status(409).json({
            error: "Only pending refund requests can be reviewed",
        });
        return;
    }
    const [updated] = await db_js_1.db
        .update(schema_js_1.refundRequests)
        .set({
        status: parsed.data.status,
        decisionNote: parsed.data.decisionNote ?? null,
        updatedAt: new Date(),
    })
        .where((0, drizzle_orm_1.eq)(schema_js_1.refundRequests.id, current.request.id))
        .returning();
    response.json(updated);
}));
app.get("/api/me/referral", authenticate, asyncRoute(async (request, response) => {
    const { userId } = request.auth;
    const [user] = await db_js_1.db
        .select({ referralCode: schema_js_1.users.referralCode })
        .from(schema_js_1.users)
        .where((0, drizzle_orm_1.eq)(schema_js_1.users.id, userId))
        .limit(1);
    const [referrals] = await db_js_1.db
        .select({ value: (0, drizzle_orm_1.count)() })
        .from(schema_js_1.users)
        .where((0, drizzle_orm_1.eq)(schema_js_1.users.referredById, userId));
    response.json({
        referralCode: user.referralCode,
        referralCount: referrals.value,
    });
}));
app.post("/api/me/tickets/:ticketId/transfer", authenticate, asyncRoute(async (request, response) => {
    const ticketId = request.params.ticketId;
    if (typeof ticketId !== "string") {
        response.status(400).json({ error: "Invalid ticket id" });
        return;
    }
    const parsed = zod_1.z
        .object({
        email: zod_1.z
            .string()
            .email()
            .max(254)
            .transform((value) => value.toLowerCase()),
    })
        .safeParse(request.body);
    if (!parsed.success) {
        response
            .status(400)
            .json({ error: "Enter the registered recipient email" });
        return;
    }
    const { userId } = request.auth;
    const [ticket] = await db_js_1.db
        .select({
        ticket: schema_js_1.tickets,
        purchase: schema_js_1.purchases,
        startsAt: schema_js_1.events.startsAt,
    })
        .from(schema_js_1.tickets)
        .innerJoin(schema_js_1.purchases, (0, drizzle_orm_1.eq)(schema_js_1.tickets.purchaseId, schema_js_1.purchases.id))
        .innerJoin(schema_js_1.ticketTypes, (0, drizzle_orm_1.eq)(schema_js_1.purchases.ticketTypeId, schema_js_1.ticketTypes.id))
        .innerJoin(schema_js_1.events, (0, drizzle_orm_1.eq)(schema_js_1.ticketTypes.eventId, schema_js_1.events.id))
        .where((0, drizzle_orm_1.eq)(schema_js_1.tickets.id, ticketId))
        .limit(1);
    if (!ticket ||
        ticket.purchase.status !== "PAID" ||
        (ticket.ticket.ownerId ?? ticket.purchase.userId) !== userId ||
        ticket.startsAt <= new Date()) {
        response.status(404).json({ error: "Transferable ticket not found" });
        return;
    }
    const [recipient] = await db_js_1.db
        .select({ id: schema_js_1.users.id, emailVerified: schema_js_1.users.emailVerified })
        .from(schema_js_1.users)
        .where((0, drizzle_orm_1.eq)(schema_js_1.users.email, parsed.data.email))
        .limit(1);
    if (!recipient || !recipient.emailVerified || recipient.id === userId) {
        response.status(400).json({
            error: "Recipient must be a different registered user with a verified email",
        });
        return;
    }
    const rotatedToken = (0, node_crypto_1.randomBytes)(32).toString("base64url");
    const [updated] = await db_js_1.db
        .update(schema_js_1.tickets)
        .set({
        ownerId: recipient.id,
        tokenHash: (0, node_crypto_1.createHash)("sha256").update(rotatedToken).digest("hex"),
        encryptedToken: encryptTicketToken(rotatedToken),
    })
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.tickets.id, ticket.ticket.id), (0, drizzle_orm_1.isNull)(schema_js_1.tickets.checkedInAt), ticket.ticket.ownerId === null
        ? (0, drizzle_orm_1.isNull)(schema_js_1.tickets.ownerId)
        : (0, drizzle_orm_1.eq)(schema_js_1.tickets.ownerId, userId)))
        .returning({ id: schema_js_1.tickets.id });
    if (!updated) {
        response.status(409).json({
            error: "Ticket is already checked in and cannot be transferred",
        });
        return;
    }
    response.json({ message: "Ticket transferred." });
}));
const purchaseInput = zod_1.z.object({
    ticketTypeId: zod_1.z.string().min(1),
    quantity: zod_1.z.number().int().min(1).max(10),
    promoCode: zod_1.z.string().trim().max(24).optional(),
});
app.post("/api/purchases", authenticate, asyncRoute(async (request, response) => {
    const parsed = purchaseInput.safeParse(request.body);
    if (!parsed.success) {
        response
            .status(400)
            .json({ error: "Select a ticket type and quantity from 1 to 10" });
        return;
    }
    const { userId } = request.auth;
    const [user] = await db_js_1.db
        .select()
        .from(schema_js_1.users)
        .where((0, drizzle_orm_1.eq)(schema_js_1.users.id, userId))
        .limit(1);
    if (!user) {
        response.status(401).json({ error: "Sign in required" });
        return;
    }
    if (!user.emailVerified) {
        response
            .status(403)
            .json({ error: "Verify your email address before buying tickets" });
        return;
    }
    const reference = `TKT-${(0, node_crypto_1.randomUUID)().replaceAll("-", "")}`;
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    let purchase;
    try {
        purchase = await db_js_1.db.transaction(async (tx) => {
            const [type] = await tx
                .select({
                id: schema_js_1.ticketTypes.id,
                priceMinor: schema_js_1.ticketTypes.priceMinor,
                currency: schema_js_1.ticketTypes.currency,
                eventPublished: schema_js_1.events.published,
                eventStartsAt: schema_js_1.events.startsAt,
                eventId: schema_js_1.events.id,
            })
                .from(schema_js_1.ticketTypes)
                .innerJoin(schema_js_1.events, (0, drizzle_orm_1.eq)(schema_js_1.ticketTypes.eventId, schema_js_1.events.id))
                .where((0, drizzle_orm_1.eq)(schema_js_1.ticketTypes.id, parsed.data.ticketTypeId))
                .limit(1);
            if (!type || !type.eventPublished || type.eventStartsAt <= new Date())
                throw new Error("TICKETS_UNAVAILABLE");
            let promo;
            if (parsed.data.promoCode) {
                [promo] = await tx
                    .select()
                    .from(schema_js_1.promotions)
                    .where((0, drizzle_orm_1.eq)(schema_js_1.promotions.code, parsed.data.promoCode.toUpperCase()))
                    .limit(1);
                if (!promo ||
                    (promo.eventId && promo.eventId !== type.eventId) ||
                    (promo.expiresAt && promo.expiresAt <= new Date()) ||
                    (promo.maxUses !== null && promo.uses >= promo.maxUses)) {
                    throw new Error("PROMO_INVALID");
                }
                const [reservedPromo] = await tx
                    .update(schema_js_1.promotions)
                    .set({ uses: (0, drizzle_orm_1.sql) `${schema_js_1.promotions.uses} + 1` })
                    .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.promotions.id, promo.id), promo.maxUses === null
                    ? undefined
                    : (0, drizzle_orm_1.sql) `${schema_js_1.promotions.uses} < ${promo.maxUses}`, promo.expiresAt === null
                    ? undefined
                    : (0, drizzle_orm_1.gte)(schema_js_1.promotions.expiresAt, new Date())))
                    .returning({ id: schema_js_1.promotions.id });
                if (!reservedPromo)
                    throw new Error("PROMO_INVALID");
            }
            const stale = await tx
                .select({
                id: schema_js_1.purchases.id,
                quantity: schema_js_1.purchases.quantity,
                ticketTypeId: schema_js_1.purchases.ticketTypeId,
                promoCodeId: schema_js_1.purchases.promoCodeId,
            })
                .from(schema_js_1.purchases)
                .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.purchases.status, "PENDING"), (0, drizzle_orm_1.lt)(schema_js_1.purchases.expiresAt, new Date())));
            for (const expiredPurchase of stale) {
                const [expired] = await tx
                    .update(schema_js_1.purchases)
                    .set({ status: "FAILED", updatedAt: new Date() })
                    .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.purchases.id, expiredPurchase.id), (0, drizzle_orm_1.eq)(schema_js_1.purchases.status, "PENDING")))
                    .returning({ id: schema_js_1.purchases.id });
                if (expired) {
                    await tx
                        .update(schema_js_1.ticketTypes)
                        .set({
                        reserved: (0, drizzle_orm_1.sql) `${schema_js_1.ticketTypes.reserved} - ${expiredPurchase.quantity}`,
                    })
                        .where((0, drizzle_orm_1.eq)(schema_js_1.ticketTypes.id, expiredPurchase.ticketTypeId));
                    if (expiredPurchase.promoCodeId) {
                        await tx
                            .update(schema_js_1.promotions)
                            .set({ uses: (0, drizzle_orm_1.sql) `GREATEST(${schema_js_1.promotions.uses} - 1, 0)` })
                            .where((0, drizzle_orm_1.eq)(schema_js_1.promotions.id, expiredPurchase.promoCodeId));
                    }
                }
            }
            const [available] = await tx
                .update(schema_js_1.ticketTypes)
                .set({
                reserved: (0, drizzle_orm_1.sql) `${schema_js_1.ticketTypes.reserved} + ${parsed.data.quantity}`,
            })
                .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.ticketTypes.id, type.id), (0, drizzle_orm_1.sql) `${schema_js_1.ticketTypes.quantity} - ${schema_js_1.ticketTypes.sold} - ${schema_js_1.ticketTypes.reserved} >= ${parsed.data.quantity}`))
                .returning({ id: schema_js_1.ticketTypes.id });
            if (!available)
                throw new Error("TICKETS_UNAVAILABLE");
            const [created] = await tx
                .insert(schema_js_1.purchases)
                .values({
                id: (0, node_crypto_1.randomUUID)(),
                reference,
                userId,
                ticketTypeId: type.id,
                email: user.email,
                quantity: parsed.data.quantity,
                amountMinor: promo
                    ? Math.floor((type.priceMinor *
                        parsed.data.quantity *
                        (100 - promo.percentOff)) /
                        100)
                    : type.priceMinor * parsed.data.quantity,
                originalAmountMinor: type.priceMinor * parsed.data.quantity,
                discountPercent: promo?.percentOff ?? 0,
                promoCodeId: promo?.id ?? null,
                currency: type.currency,
                expiresAt,
                updatedAt: new Date(),
            })
                .returning();
            return created;
        });
    }
    catch (error) {
        if (error instanceof Error && error.message === "TICKETS_UNAVAILABLE") {
            response
                .status(409)
                .json({ error: "Tickets are unavailable in that quantity" });
            return;
        }
        if (error instanceof Error && error.message === "PROMO_INVALID") {
            response.status(400).json({
                error: "Promo code is invalid, expired, fully redeemed, or not valid for this event",
            });
            return;
        }
        throw error;
    }
    try {
        const result = await paystackRequest("/transaction/initialize", {
            method: "POST",
            body: JSON.stringify({
                email: user.email,
                amount: purchase.amountMinor,
                currency: purchase.currency,
                reference,
                callback_url: process.env.PAYSTACK_CALLBACK_URL || "ticketing://payment",
                metadata: { purchaseId: purchase.id, userId },
            }),
        });
        if (!result.data?.authorization_url ||
            result.data.reference !== reference) {
            throw new Error("Payment provider returned an invalid checkout session");
        }
        response.status(201).json({
            reference,
            authorizationUrl: result.data.authorization_url,
            expiresAt,
            amountMinor: purchase.amountMinor,
            originalAmountMinor: purchase.originalAmountMinor,
            discountPercent: purchase.discountPercent,
            currency: purchase.currency,
        });
    }
    catch (error) {
        try {
            await releaseFailedPurchase(reference);
        }
        catch (releaseError) {
            console.error("Could not release ticket reservation after checkout initialization failed:", releaseError);
        }
        console.error("Payment checkout initialization failed:", error);
        response.status(502).json({
            error: error instanceof Error
                ? `Could not start payment checkout: ${error.message}`
                : "Could not start payment checkout. Please try again.",
        });
    }
}));
app.get("/api/payments/verify/:reference", authenticate, asyncRoute(async (request, response) => {
    const reference = request.params.reference;
    if (typeof reference !== "string") {
        response.status(400).json({ error: "Invalid payment reference" });
        return;
    }
    const { userId } = request.auth;
    const [purchase] = await db_js_1.db
        .select()
        .from(schema_js_1.purchases)
        .where((0, drizzle_orm_1.eq)(schema_js_1.purchases.reference, reference))
        .limit(1);
    if (!purchase || purchase.userId !== userId) {
        response.status(404).json({ error: "Purchase not found" });
        return;
    }
    try {
        const valid = await verifyPaystackPayment(purchase.reference);
        const [updated] = await db_js_1.db
            .select()
            .from(schema_js_1.purchases)
            .where((0, drizzle_orm_1.eq)(schema_js_1.purchases.id, purchase.id))
            .limit(1);
        const [ticketCount] = await db_js_1.db
            .select({ value: (0, drizzle_orm_1.count)() })
            .from(schema_js_1.tickets)
            .where((0, drizzle_orm_1.eq)(schema_js_1.tickets.purchaseId, purchase.id));
        response.json({
            status: updated.status,
            paid: valid || updated.status === "PAID",
            ticketCount: ticketCount.value,
            amountMinor: updated.amountMinor,
            originalAmountMinor: updated.originalAmountMinor,
            discountPercent: updated.discountPercent,
            currency: updated.currency,
            expiresAt: updated.expiresAt,
        });
    }
    catch (error) {
        console.error("Payment verification failed:", error);
        response
            .status(502)
            .json({ error: "Could not verify payment. Please try again." });
    }
}));
app.get("/api/purchases", authenticate, asyncRoute(async (request, response) => {
    const { userId } = request.auth;
    const ownedTicketRows = await db_js_1.db
        .select({ purchaseId: schema_js_1.tickets.purchaseId })
        .from(schema_js_1.tickets)
        .where((0, drizzle_orm_1.eq)(schema_js_1.tickets.ownerId, userId));
    const ownedPurchaseIds = ownedTicketRows.map((ticket) => ticket.purchaseId);
    const rows = await db_js_1.db
        .select({
        id: schema_js_1.purchases.id,
        ownerUserId: schema_js_1.purchases.userId,
        reference: schema_js_1.purchases.reference,
        status: schema_js_1.purchases.status,
        amountMinor: schema_js_1.purchases.amountMinor,
        originalAmountMinor: schema_js_1.purchases.originalAmountMinor,
        discountPercent: schema_js_1.purchases.discountPercent,
        currency: schema_js_1.purchases.currency,
        quantity: schema_js_1.purchases.quantity,
        createdAt: schema_js_1.purchases.createdAt,
        eventTitle: schema_js_1.events.title,
        eventId: schema_js_1.events.id,
        venue: schema_js_1.events.venue,
        startsAt: schema_js_1.events.startsAt,
        endsAt: schema_js_1.events.endsAt,
        ticketType: schema_js_1.ticketTypes.name,
    })
        .from(schema_js_1.purchases)
        .innerJoin(schema_js_1.ticketTypes, (0, drizzle_orm_1.eq)(schema_js_1.purchases.ticketTypeId, schema_js_1.ticketTypes.id))
        .innerJoin(schema_js_1.events, (0, drizzle_orm_1.eq)(schema_js_1.ticketTypes.eventId, schema_js_1.events.id))
        .where((0, drizzle_orm_1.or)((0, drizzle_orm_1.eq)(schema_js_1.purchases.userId, userId), ownedPurchaseIds.length
        ? (0, drizzle_orm_1.inArray)(schema_js_1.purchases.id, ownedPurchaseIds)
        : undefined))
        .orderBy((0, drizzle_orm_1.desc)(schema_js_1.purchases.createdAt));
    const purchaseIds = rows.map((purchase) => purchase.id);
    const ticketRows = purchaseIds.length
        ? await db_js_1.db
            .select()
            .from(schema_js_1.tickets)
            .where((0, drizzle_orm_1.inArray)(schema_js_1.tickets.purchaseId, purchaseIds))
        : [];
    response.json(rows.map((purchase) => ({
        id: purchase.id,
        reference: purchase.reference,
        status: purchase.status,
        amountMinor: purchase.amountMinor,
        originalAmountMinor: purchase.originalAmountMinor,
        discountPercent: purchase.discountPercent,
        currency: purchase.currency,
        quantity: purchase.quantity,
        createdAt: purchase.createdAt,
        event: {
            id: purchase.eventId,
            title: purchase.eventTitle,
            venue: purchase.venue,
            startsAt: purchase.startsAt,
            endsAt: purchase.endsAt,
        },
        ticketType: purchase.ticketType,
        tickets: purchase.status === "PAID"
            ? ticketRows
                .filter((ticket) => ticket.purchaseId === purchase.id &&
                (ticket.ownerId === userId ||
                    (ticket.ownerId === null &&
                        purchase.ownerUserId === userId)) &&
                ticket.encryptedToken)
                .map((ticket) => ({
                id: ticket.id,
                checkedInAt: ticket.checkedInAt,
                checkedOutAt: ticket.checkedOutAt,
                token: decryptTicketToken(ticket.encryptedToken),
            }))
            : [],
    })));
}));
const checkInSchema = zod_1.z.object({
    token: zod_1.z.string().min(16).max(256),
    action: zod_1.z.enum(["CHECK_IN", "CHECK_OUT"]).default("CHECK_IN"),
});
app.post("/api/admin/check-in", ...organizerOnly, asyncRoute(async (request, response) => {
    const parsed = checkInSchema.safeParse(request.body);
    if (!parsed.success) {
        response.status(400).json({ error: "Invalid ticket token" });
        return;
    }
    const tokenHash = (0, node_crypto_1.createHash)("sha256")
        .update(parsed.data.token)
        .digest("hex");
    const { userId, role } = request.auth;
    const ticket = await db_js_1.db
        .select({
        id: schema_js_1.tickets.id,
        eventId: schema_js_1.events.id,
        checkedInAt: schema_js_1.tickets.checkedInAt,
        checkedOutAt: schema_js_1.tickets.checkedOutAt,
        status: schema_js_1.purchases.status,
        event: schema_js_1.events.title,
        ticketType: schema_js_1.ticketTypes.name,
        ownerId: schema_js_1.events.createdById,
    })
        .from(schema_js_1.tickets)
        .innerJoin(schema_js_1.purchases, (0, drizzle_orm_1.eq)(schema_js_1.tickets.purchaseId, schema_js_1.purchases.id))
        .innerJoin(schema_js_1.ticketTypes, (0, drizzle_orm_1.eq)(schema_js_1.purchases.ticketTypeId, schema_js_1.ticketTypes.id))
        .innerJoin(schema_js_1.events, (0, drizzle_orm_1.eq)(schema_js_1.ticketTypes.eventId, schema_js_1.events.id))
        .where((0, drizzle_orm_1.eq)(schema_js_1.tickets.tokenHash, tokenHash))
        .limit(1);
    const found = ticket[0];
    if (!found ||
        found.status !== "PAID" ||
        (role !== "ADMIN" && found.ownerId !== userId)) {
        response.status(404).json({ error: "Ticket not found or not paid" });
        return;
    }
    const now = new Date();
    if (!(0, check_in_status_js_1.canTransitionCheckIn)(parsed.data.action, found.checkedInAt, found.checkedOutAt)) {
        if (parsed.data.action === "CHECK_IN") {
            response.status(409).json({
                error: "Ticket is already checked in. Choose check out only when the attendee is leaving.",
            });
        }
        else {
            response
                .status(409)
                .json({ error: "Ticket is not currently checked in." });
        }
        return;
    }
    const updated = await db_js_1.db.transaction(async (tx) => {
        const [ticketUpdate] = await tx
            .update(schema_js_1.tickets)
            .set(parsed.data.action === "CHECK_IN"
            ? { checkedInAt: now, checkedOutAt: null }
            : { checkedOutAt: now })
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.tickets.id, found.id), parsed.data.action === "CHECK_IN"
            ? (0, drizzle_orm_1.or)((0, drizzle_orm_1.isNull)(schema_js_1.tickets.checkedInAt), (0, drizzle_orm_1.isNotNull)(schema_js_1.tickets.checkedOutAt))
            : (0, drizzle_orm_1.and)((0, drizzle_orm_1.isNotNull)(schema_js_1.tickets.checkedInAt), (0, drizzle_orm_1.isNull)(schema_js_1.tickets.checkedOutAt))))
            .returning({ id: schema_js_1.tickets.id });
        if (!ticketUpdate)
            return null;
        if (parsed.data.action === "CHECK_IN") {
            await tx.insert(schema_js_1.checkInLogs).values({
                id: (0, node_crypto_1.randomUUID)(),
                ticketId: found.id,
                eventId: found.eventId,
                actorId: userId,
                checkedAt: now,
            });
        }
        return ticketUpdate;
    });
    if (!updated) {
        response.status(409).json({
            error: "Ticket status changed during the scan. Refresh and try again.",
        });
        return;
    }
    response.json({
        valid: true,
        action: parsed.data.action,
        status: parsed.data.action === "CHECK_IN" ? "CHECKED_IN" : "CHECKED_OUT",
        event: found.event,
        ticketType: found.ticketType,
    });
}));
app.use((error, _request, response, _next) => {
    console.error(error);
    const code = typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "";
    if (code === "23505") {
        response
            .status(409)
            .json({ error: "A record with these details already exists" });
        return;
    }
    if (code === "40001" || code === "40P01") {
        response
            .status(409)
            .json({ error: "Inventory changed while processing. Please retry." });
        return;
    }
    response.status(500).json({ error: "Internal server error" });
});
const server = app.listen(port, "0.0.0.0", () => {
    console.log(`Ticketing API listening on port ${port}`);
});
for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
        server.close(() => {
            void db_js_1.client.end().finally(() => process.exit(0));
        });
    });
}
