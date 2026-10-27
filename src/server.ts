import "dotenv/config";
import cors from "cors";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import rateLimit from "express-rate-limit";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lte,
  lt,
  or,
  sql,
  sum,
} from "drizzle-orm";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { db, client } from "./db.js";
import {
  accountTokens,
  checkInLogs,
  events,
  favorites,
  promotions,
  purchases,
  pushTokens,
  refundRequests,
  reviews,
  tickets,
  ticketTypes,
  type UserRole,
  users,
} from "./schema.js";
import { z } from "zod";
import { canReviewRefundStatus } from "./refund-status.js";
import { canTransitionCheckIn } from "./check-in-status.js";
import { createCoverUploadRouter } from "./event-cover-upload.js";
import {
  coverImageTypes,
  isAllowedCoverImageType,
  isOwnedCoverImageKey,
  maxCoverImageBytes,
  matchesImageSignature,
} from "./event-covers.js";

const app = express();
const port = Number(process.env.PORT ?? 4000);
const awsRegion = process.env.AWS_REGION;
const s3Bucket = process.env.AWS_S3_BUCKET;
const s3Client = new S3Client({
  region: awsRegion || "us-east-1",
  ...(process.env.AWS_S3_ENDPOINT_URL
    ? {
        endpoint: process.env.AWS_S3_ENDPOINT_URL,
        forcePathStyle: process.env.AWS_S3_FORCE_PATH_STYLE === "true",
      }
    : {}),
});
const scrypt = promisify(scryptCallback);
const sessionSecret = process.env.SESSION_SECRET;
const corsOrigins = process.env.CORS_ORIGINS?.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

type AuthedRequest = Request & { auth?: { userId: string; role: UserRole } };
type PaystackResponse = {
  status?: boolean;
  message?: string;
  data?: {
    authorization_url?: string;
    reference?: string;
    status?: string;
    amount?: number;
    currency?: string;
  };
};

if (!sessionSecret || sessionSecret.length < 32) {
  throw new Error(
    "SESSION_SECRET must be configured with at least 32 characters",
  );
}

const appSecret = createHash("sha256").update(sessionSecret).digest();
const credentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many sign-in attempts. Try again later." },
});
const bootstrapLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many setup attempts. Try again later." },
});
const coverUploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many image uploads. Try again later." },
});

async function signCoverImage(key: string | null): Promise<string | null> {
  if (!key || !s3Bucket) return null;
  return getSignedUrl(
    s3Client,
    new GetObjectCommand({ Bucket: s3Bucket, Key: key }),
    { expiresIn: 15 * 60 },
  );
}

async function verifyCoverImageKey(
  key: string,
  userId: string,
): Promise<boolean> {
  if (!s3Bucket || !awsRegion || !isOwnedCoverImageKey(key, userId))
    return false;
  try {
    const metadata = await s3Client.send(
      new HeadObjectCommand({ Bucket: s3Bucket, Key: key }),
    );
    if (
      !metadata.ContentLength ||
      metadata.ContentLength > maxCoverImageBytes ||
      !metadata.ContentType ||
      !isAllowedCoverImageType(metadata.ContentType)
    ) {
      await s3Client.send(
        new DeleteObjectCommand({ Bucket: s3Bucket, Key: key }),
      );
      return false;
    }
    const image = await s3Client.send(
      new GetObjectCommand({ Bucket: s3Bucket, Key: key }),
    );
    const bytes = await image.Body?.transformToByteArray();
    if (!bytes || !matchesImageSignature(bytes, metadata.ContentType)) {
      await s3Client.send(
        new DeleteObjectCommand({ Bucket: s3Bucket, Key: key }),
      );
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function signToken(userId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ sub: userId, exp: Date.now() + 7 * 86400000 }),
  ).toString("base64url");
  const signature = createHmac("sha256", sessionSecret!)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function readToken(token: string): { sub: string; exp: number } | null {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return null;
  const expected = createHmac("sha256", sessionSecret!)
    .update(payload)
    .digest();
  const supplied = Buffer.from(signature, "base64url");
  if (
    expected.length !== supplied.length ||
    !timingSafeEqual(expected, supplied)
  )
    return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      sub?: unknown;
      exp?: unknown;
    };
    return typeof parsed.sub === "string" &&
      typeof parsed.exp === "number" &&
      parsed.exp > Date.now()
      ? { sub: parsed.sub, exp: parsed.exp }
      : null;
  } catch {
    return null;
  }
}

function encryptTicketToken(token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", appSecret, iv);
  const encrypted = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
    "base64url",
  );
}

function decryptTicketToken(value: string): string {
  const data = Buffer.from(value, "base64url");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    appSecret,
    data.subarray(0, 12),
  );
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([
    decipher.update(data.subarray(28)),
    decipher.final(),
  ]).toString("utf8");
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt.toString("base64url")}.${hash.toString("base64url")}`;
}

async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [saltString, hashString] = stored.split(".");
  if (!saltString || !hashString) return false;
  const salt = Buffer.from(saltString, "base64url");
  const expected = Buffer.from(hashString, "base64url");
  const actual = (await scrypt(password, salt, expected.length)) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function sendEmail(to: string, subject: string, htmlContent: string) {
  const apiKey = process.env.BREVO_API_KEY;
  const sender = process.env.BREVO_FROM_EMAIL;
  if (!apiKey || !sender)
    throw new Error(
      "Email delivery is not configured (BREVO_API_KEY and BREVO_FROM_EMAIL required)",
    );
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
    console.error(
      "Email provider rejected a message:",
      response.status,
      details,
    );
    throw new Error("Email provider could not send the message");
  }
}

async function sendAccountToken(
  userId: string,
  email: string,
  purpose: "RESET_PASSWORD" | "VERIFY_EMAIL",
  targetEmail: string | null = null,
) {
  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  await db
    .delete(accountTokens)
    .where(
      and(eq(accountTokens.userId, userId), eq(accountTokens.purpose, purpose)),
    );
  await db.insert(accountTokens).values({
    id: randomUUID(),
    userId,
    tokenHash,
    purpose,
    targetEmail,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  const webOrigin = process.env.WEB_APP_URL ?? "http://localhost:5173";
  const link = `${webOrigin.replace(/\/+$/, "")}/account/${purpose === "RESET_PASSWORD" ? "reset-password" : "verify-email"}?token=${encodeURIComponent(rawToken)}`;
  try {
    await sendEmail(
      email,
      purpose === "RESET_PASSWORD"
        ? "Reset your ticketing password"
        : "Confirm your email address",
      `<p>Use this secure link within one hour:</p><p><a href="${link}">${purpose === "RESET_PASSWORD" ? "Reset password" : "Confirm email"}</a></p>`,
    );
  } catch (error) {
    await db
      .delete(accountTokens)
      .where(eq(accountTokens.tokenHash, tokenHash));
    throw error;
  }
}

async function authenticate(
  request: Request,
  response: Response,
  next: NextFunction,
) {
  const authorization = request.header("authorization");
  const token = authorization?.match(/^Bearer (.+)$/i)?.[1];
  const claims = token ? readToken(token) : null;
  if (!claims) {
    response.status(401).json({ error: "Sign in required" });
    return;
  }
  try {
    const [user] = await db
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(eq(users.id, claims.sub))
      .limit(1);
    if (!user) {
      response.status(401).json({ error: "Sign in required" });
      return;
    }
    (request as AuthedRequest).auth = { userId: user.id, role: user.role };
    next();
  } catch (error) {
    next(error);
  }
}

const organizerOnly = [
  authenticate,
  (request: Request, response: Response, next: NextFunction) => {
    const role = (request as AuthedRequest).auth?.role;
    if (role !== "ADMIN" && role !== "ORGANIZER") {
      response.status(403).json({ error: "Organizer access required" });
      return;
    }
    next();
  },
];
const adminOnly = [
  authenticate,
  (request: Request, response: Response, next: NextFunction) => {
    if ((request as AuthedRequest).auth?.role !== "ADMIN") {
      response.status(403).json({ error: "Administrator access required" });
      return;
    }
    next();
  },
];
const eventOwnerOnly = [
  authenticate,
  (request: Request, response: Response, next: NextFunction) => {
    if ((request as AuthedRequest).auth?.role !== "ORGANIZER") {
      response
        .status(403)
        .json({ error: "Only event owners can create events" });
      return;
    }
    next();
  },
];
const asyncRoute =
  (
    handler: (
      request: Request,
      response: Response,
      next: NextFunction,
    ) => Promise<void>,
  ) =>
  (request: Request, response: Response, next: NextFunction) => {
    void handler(request, response, next).catch(next);
  };

async function paystackRequest(
  path: string,
  init: RequestInit,
): Promise<PaystackResponse> {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) throw new Error("Payment provider is not configured");
  const response = await fetch(`https://api.paystack.co${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
  const body = (await response.json()) as PaystackResponse;
  if (!response.ok || !body.status)
    throw new Error(body.message ?? "Payment provider request failed");
  return body;
}

async function fulfilPurchase(
  reference: string,
  payment: NonNullable<PaystackResponse["data"]>,
) {
  if (payment.status !== "success") return false;
  const fulfilled = await db.transaction(async (tx) => {
    const [purchase] = await tx
      .select()
      .from(purchases)
      .where(eq(purchases.reference, reference))
      .limit(1);
    if (!purchase) return false;
    if (purchase.status === "PAID") return false;
    if (purchase.status !== "PENDING") return false;
    if (
      payment.amount !== purchase.amountMinor ||
      payment.currency !== purchase.currency
    )
      return false;

    const [updated] = await tx
      .update(purchases)
      .set({ status: "PAID", updatedAt: new Date() })
      .where(
        and(eq(purchases.id, purchase.id), eq(purchases.status, "PENDING")),
      )
      .returning({ id: purchases.id });
    if (!updated) return false;

    await tx
      .update(ticketTypes)
      .set({
        reserved: sql`${ticketTypes.reserved} - ${purchase.quantity}`,
        sold: sql`${ticketTypes.sold} + ${purchase.quantity}`,
      })
      .where(eq(ticketTypes.id, purchase.ticketTypeId));

    const ticketRows = Array.from({ length: purchase.quantity }, () => {
      const token = randomBytes(32).toString("base64url");
      return {
        id: randomUUID(),
        purchaseId: purchase.id,
        ownerId: purchase.userId,
        tokenHash: createHash("sha256").update(token).digest("hex"),
        encryptedToken: encryptTicketToken(token),
      };
    });
    await tx.insert(tickets).values(ticketRows);
    return true;
  });
  if (fulfilled) {
    try {
      const [purchase] = await db
        .select({ userId: purchases.userId })
        .from(purchases)
        .where(eq(purchases.reference, reference))
        .limit(1);
      if (purchase?.userId)
        await sendPush(
          purchase.userId,
          "Tickets are ready",
          "Your purchased tickets are now in My Tickets.",
          { screen: "tickets" },
        );
    } catch (error) {
      console.error("Could not send ticket-ready notification:", error);
    }
  }
  return fulfilled;
}

async function sendPush(
  userId: string,
  title: string,
  body: string,
  data: Record<string, string>,
) {
  const tokens = await db
    .select({ token: pushTokens.token })
    .from(pushTokens)
    .where(eq(pushTokens.userId, userId));
  if (!tokens.length) return;
  const response = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(
      tokens.map(({ token }) => ({
        to: token,
        sound: "default",
        title,
        body,
        data,
        channelId: "default",
      })),
    ),
  });
  if (!response.ok) {
    const details = await response.text();
    console.error(
      "Expo push service rejected notification:",
      response.status,
      details,
    );
  }
}

async function releaseFailedPurchase(reference: string) {
  await db.transaction(async (tx) => {
    const [purchase] = await tx
      .update(purchases)
      .set({ status: "FAILED", updatedAt: new Date() })
      .where(
        and(
          eq(purchases.reference, reference),
          eq(purchases.status, "PENDING"),
        ),
      )
      .returning({
        id: purchases.id,
        quantity: purchases.quantity,
        ticketTypeId: purchases.ticketTypeId,
        promoCodeId: purchases.promoCodeId,
      });
    if (!purchase) return;
    await tx
      .update(ticketTypes)
      .set({ reserved: sql`${ticketTypes.reserved} - ${purchase.quantity}` })
      .where(eq(ticketTypes.id, purchase.ticketTypeId));
    if (purchase.promoCodeId) {
      await tx
        .update(promotions)
        .set({ uses: sql`GREATEST(${promotions.uses} - 1, 0)` })
        .where(eq(promotions.id, purchase.promoCodeId));
    }
  });
}

async function verifyPaystackPayment(reference: string) {
  const result = await paystackRequest(
    `/transaction/verify/${encodeURIComponent(reference)}`,
    { method: "GET" },
  );
  if (!result.data || result.data.reference !== reference) return false;
  if (result.data.status === "success")
    return fulfilPurchase(reference, result.data);
  if (result.data.status === "failed" || result.data.status === "abandoned") {
    await releaseFailedPurchase(reference);
  }
  return false;
}

app.use(
  cors({
    origin: (origin, callback) =>
      callback(
        null,
        !origin || !corsOrigins?.length || corsOrigins.includes(origin),
      ),
  }),
);

app.get(
  "/api/promotions/:code",
  asyncRoute(async (request, response) => {
    const code = String(request.params.code).toUpperCase();
    const ticketTypeId =
      typeof request.query.ticketTypeId === "string"
        ? request.query.ticketTypeId
        : "";
    const [promo] = await db
      .select()
      .from(promotions)
      .where(eq(promotions.code, code))
      .limit(1);
    if (
      !promo ||
      (promo.expiresAt && promo.expiresAt <= new Date()) ||
      (promo.maxUses !== null && promo.uses >= promo.maxUses)
    ) {
      response
        .status(404)
        .json({ error: "Promo code is invalid, expired, or fully redeemed" });
      return;
    }
    if (promo.eventId) {
      const [type] = await db
        .select({ eventId: ticketTypes.eventId })
        .from(ticketTypes)
        .where(eq(ticketTypes.id, ticketTypeId))
        .limit(1);
      if (!type || type.eventId !== promo.eventId) {
        response
          .status(400)
          .json({ error: "Promo code does not apply to this event" });
        return;
      }
    }
    response.json({ code: promo.code, percentOff: promo.percentOff });
  }),
);
app.post(
  "/api/payments/webhook",
  express.raw({ type: "application/json" }),
  asyncRoute(async (request, response) => {
    const signature = request.header("x-paystack-signature");
    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (!signature || !secret || !Buffer.isBuffer(request.body)) {
      response.status(400).json({ error: "Invalid payment webhook" });
      return;
    }
    const expected = createHmac("sha512", secret).update(request.body).digest();
    const supplied = Buffer.from(signature, "hex");
    if (
      expected.length !== supplied.length ||
      !timingSafeEqual(expected, supplied)
    ) {
      response.status(401).json({ error: "Invalid webhook signature" });
      return;
    }
    const event = JSON.parse(request.body.toString()) as {
      event?: string;
      data?: { reference?: string };
    };
    if (event.event === "charge.success" && event.data?.reference)
      await verifyPaystackPayment(event.data.reference);
    response.sendStatus(200);
  }),
);
app.use(express.json({ limit: "32kb" }));

app.get("/api/health", (_request, response) => response.json({ status: "ok" }));

const credentialsSchema = z.object({
  email: z
    .string()
    .email()
    .max(254)
    .transform((email) => email.toLowerCase()),
  password: z.string().min(10).max(128),
  name: z.string().trim().min(1).max(100),
  referralCode: z.string().trim().min(4).max(24).optional(),
});

app.post(
  "/api/auth/register",
  credentialLimiter,
  asyncRoute(async (request, response) => {
    const parsed = credentialsSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error:
          "Provide a valid name, email, and password (at least 10 characters)",
      });
      return;
    }
    const { email, password, name, referralCode } = parsed.data;
    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (existing) {
      response
        .status(409)
        .json({ error: "An account with this email already exists" });
      return;
    }
    const [referrer] = referralCode
      ? await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.referralCode, referralCode.toUpperCase()))
          .limit(1)
      : [];
    const userId = randomUUID();
    const [user] = await db
      .insert(users)
      .values({
        id: userId,
        email,
        name,
        passwordHash: await hashPassword(password),
        emailVerified: false,
        referralCode: `NR${randomBytes(5).toString("hex").toUpperCase()}`,
        referredById: referrer?.id ?? null,
        updatedAt: new Date(),
      })
      .returning({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        emailVerified: users.emailVerified,
        referralCode: users.referralCode,
      });
    let verificationEmailSent = false;
    try {
      await sendAccountToken(user.id, user.email, "VERIFY_EMAIL");
      verificationEmailSent = true;
    } catch (error) {
      console.error("Could not send signup verification email:", error);
    }
    response
      .status(201)
      .json({ token: signToken(user.id), user, verificationEmailSent });
  }),
);

app.post(
  "/api/admin/organizers",
  ...adminOnly,
  credentialLimiter,
  asyncRoute(async (request, response) => {
    const parsed = credentialsSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error:
          "Provide a valid name, email, and password (at least 10 characters)",
      });
      return;
    }
    const { email, password, name } = parsed.data;
    try {
      const [user] = await db
        .insert(users)
        .values({
          id: randomUUID(),
          email,
          name,
          passwordHash: await hashPassword(password),
          role: "ORGANIZER",
          updatedAt: new Date(),
        })
        .returning({
          id: users.id,
          email: users.email,
          name: users.name,
          role: users.role,
        });
      response.status(201).json({ user });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
      ) {
        response
          .status(409)
          .json({ error: "An account with this email already exists" });
        return;
      }
      throw error;
    }
  }),
);

app.post(
  "/api/auth/login",
  credentialLimiter,
  asyncRoute(async (request, response) => {
    const parsed = z
      .object({
        email: z
          .string()
          .email()
          .transform((email) => email.toLowerCase()),
        password: z.string().min(1).max(128),
      })
      .safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "Enter a valid email and password" });
      return;
    }
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, parsed.data.email))
      .limit(1);
    if (
      !user ||
      !(await verifyPassword(parsed.data.password, user.passwordHash))
    ) {
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
  }),
);

app.post(
  "/api/admin/bootstrap",
  bootstrapLimiter,
  asyncRoute(async (request, response) => {
    const secret = process.env.ADMIN_BOOTSTRAP_SECRET;
    const supplied = request.header("x-bootstrap-secret");
    if (!secret || !supplied) {
      response.status(404).json({ error: "Admin setup is disabled" });
      return;
    }
    const expectedBytes = Buffer.from(secret);
    const suppliedBytes = Buffer.from(supplied);
    if (
      expectedBytes.length !== suppliedBytes.length ||
      !timingSafeEqual(expectedBytes, suppliedBytes)
    ) {
      response.status(401).json({ error: "Invalid setup secret" });
      return;
    }
    const parsed = credentialsSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error:
          "Provide a valid name, email, and password (at least 10 characters)",
      });
      return;
    }
    const [existingAdmin] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, "ADMIN"))
      .limit(1);
    if (existingAdmin) {
      response
        .status(409)
        .json({ error: "An administrator is already configured" });
      return;
    }
    const { email, name, password } = parsed.data;
    const [user] = await db
      .insert(users)
      .values({
        id: randomUUID(),
        email,
        name,
        passwordHash: await hashPassword(password),
        role: "ADMIN",
        updatedAt: new Date(),
      })
      .returning({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
      });
    response.status(201).json({ token: signToken(user.id), user });
  }),
);

app.get(
  "/api/me",
  authenticate,
  asyncRoute(async (request, response) => {
    const { userId } = (request as AuthedRequest).auth!;
    const [user] = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
        emailVerified: users.emailVerified,
        referralCode: users.referralCode,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    response.json(user);
  }),
);

app.patch(
  "/api/me",
  authenticate,
  asyncRoute(async (request, response) => {
    const parsed = z
      .object({ name: z.string().trim().min(1).max(100) })
      .safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "Enter a valid name" });
      return;
    }
    const { userId } = (request as AuthedRequest).auth!;
    const [user] = await db
      .update(users)
      .set({ name: parsed.data.name, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning({
        id: users.id,
        name: users.name,
        email: users.email,
        emailVerified: users.emailVerified,
      });
    response.json(user);
  }),
);

app.post(
  "/api/me/change-email",
  authenticate,
  asyncRoute(async (request, response) => {
    const parsed = z
      .object({
        email: z
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
    const { userId } = (request as AuthedRequest).auth!;
    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, parsed.data.email))
      .limit(1);
    if (existing) {
      response
        .status(409)
        .json({ error: "That email address is already in use" });
      return;
    }
    const [user] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) {
      response.status(404).json({ error: "Account not found" });
      return;
    }
    await sendAccountToken(
      userId,
      parsed.data.email,
      "VERIFY_EMAIL",
      parsed.data.email,
    );
    response.json({
      message: "A verification link was sent to the new email address.",
    });
  }),
);

app.post(
  "/api/auth/forgot-password",
  credentialLimiter,
  asyncRoute(async (request, response) => {
    const parsed = z
      .object({
        email: z
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
    const [user] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.email, parsed.data.email))
      .limit(1);
    if (user) await sendAccountToken(user.id, user.email, "RESET_PASSWORD");
    response.json({
      message:
        "If an account exists for that address, a password reset link has been sent.",
    });
  }),
);

app.post(
  "/api/auth/reset-password",
  credentialLimiter,
  asyncRoute(async (request, response) => {
    const parsed = z
      .object({
        token: z.string().min(32).max(128),
        password: z.string().min(10).max(128),
      })
      .safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error:
          "Provide a valid reset token and password of at least 10 characters",
      });
      return;
    }
    const tokenHash = createHash("sha256")
      .update(parsed.data.token)
      .digest("hex");
    const [token] = await db
      .select()
      .from(accountTokens)
      .where(
        and(
          eq(accountTokens.tokenHash, tokenHash),
          eq(accountTokens.purpose, "RESET_PASSWORD"),
          gte(accountTokens.expiresAt, new Date()),
        ),
      )
      .limit(1);
    if (!token) {
      response.status(400).json({ error: "Reset link is invalid or expired" });
      return;
    }
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({
          passwordHash: await hashPassword(parsed.data.password),
          updatedAt: new Date(),
        })
        .where(eq(users.id, token.userId));
      await tx
        .delete(accountTokens)
        .where(eq(accountTokens.userId, token.userId));
    });
    response.json({ message: "Password updated. You can now sign in." });
  }),
);

app.post(
  "/api/auth/verify-email",
  asyncRoute(async (request, response) => {
    const parsed = z
      .object({ token: z.string().min(32).max(128) })
      .safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "Invalid verification link" });
      return;
    }
    const tokenHash = createHash("sha256")
      .update(parsed.data.token)
      .digest("hex");
    const [token] = await db
      .select()
      .from(accountTokens)
      .where(
        and(
          eq(accountTokens.tokenHash, tokenHash),
          eq(accountTokens.purpose, "VERIFY_EMAIL"),
          gte(accountTokens.expiresAt, new Date()),
        ),
      )
      .limit(1);
    if (!token) {
      response
        .status(400)
        .json({ error: "Verification link is invalid or expired" });
      return;
    }
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({
          ...(token.targetEmail ? { email: token.targetEmail } : {}),
          emailVerified: true,
          updatedAt: new Date(),
        })
        .where(eq(users.id, token.userId));
      await tx
        .delete(accountTokens)
        .where(
          and(
            eq(accountTokens.userId, token.userId),
            eq(accountTokens.purpose, "VERIFY_EMAIL"),
          ),
        );
    });
    response.json({ message: "Email address verified." });
  }),
);

app.post(
  "/api/me/password",
  authenticate,
  asyncRoute(async (request, response) => {
    const parsed = z
      .object({
        currentPassword: z.string().min(1).max(128),
        newPassword: z.string().min(10).max(128),
      })
      .safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error:
          "Provide the current password and a new password of at least 10 characters",
      });
      return;
    }
    const { userId } = (request as AuthedRequest).auth!;
    const [user] = await db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (
      !user ||
      !(await verifyPassword(parsed.data.currentPassword, user.passwordHash))
    ) {
      response.status(401).json({ error: "Current password is incorrect" });
      return;
    }
    await db
      .update(users)
      .set({
        passwordHash: await hashPassword(parsed.data.newPassword),
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));
    response.json({ message: "Password updated." });
  }),
);

app.post(
  "/api/me/push-token",
  authenticate,
  asyncRoute(async (request, response) => {
    const parsed = z
      .object({ token: z.string().min(10).max(512) })
      .safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "Invalid push token" });
      return;
    }
    const { userId } = (request as AuthedRequest).auth!;
    await db
      .insert(pushTokens)
      .values({ id: randomUUID(), userId, token: parsed.data.token })
      .onConflictDoUpdate({ target: pushTokens.token, set: { userId } });
    response.status(204).end();
  }),
);

app.post(
  "/api/me/verify-email",
  authenticate,
  asyncRoute(async (request, response) => {
    const { userId } = (request as AuthedRequest).auth!;
    const [user] = await db
      .select({
        email: users.email,
        emailVerified: users.emailVerified,
      })
      .from(users)
      .where(eq(users.id, userId))
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
    } catch (error) {
      console.error("Could not send email verification link:", error);
      response.status(502).json({
        error: "Could not send a verification email. Please try again later.",
      });
      return;
    }
    response.json({
      message: "A verification link was sent to your email address.",
    });
  }),
);

app.get(
  "/api/me/favorites",
  authenticate,
  asyncRoute(async (request, response) => {
    const { userId } = (request as AuthedRequest).auth!;
    const rows = await db
      .select({ event: events })
      .from(favorites)
      .innerJoin(events, eq(favorites.eventId, events.id))
      .where(eq(favorites.userId, userId))
      .orderBy(desc(favorites.createdAt));
    response.json(
      await Promise.all(
        rows.map(async ({ event }) => {
          const { coverImageKey, ...savedEvent } = event;
          return {
            ...savedEvent,
            coverImageUrl: await signCoverImage(coverImageKey),
          };
        }),
      ),
    );
  }),
);

app.post(
  "/api/me/favorites/:eventId",
  authenticate,
  asyncRoute(async (request, response) => {
    const eventId = request.params.eventId;
    if (typeof eventId !== "string") {
      response.status(400).json({ error: "Invalid event id" });
      return;
    }
    const { userId } = (request as AuthedRequest).auth!;
    const [event] = await db
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.id, eventId), eq(events.published, true)))
      .limit(1);
    if (!event) {
      response.status(404).json({ error: "Event not found" });
      return;
    }
    await db
      .insert(favorites)
      .values({ userId, eventId })
      .onConflictDoNothing();
    response.sendStatus(204);
  }),
);

app.delete(
  "/api/me/favorites/:eventId",
  authenticate,
  asyncRoute(async (request, response) => {
    const eventId = request.params.eventId;
    if (typeof eventId !== "string") {
      response.status(400).json({ error: "Invalid event id" });
      return;
    }
    const { userId } = (request as AuthedRequest).auth!;
    await db
      .delete(favorites)
      .where(and(eq(favorites.userId, userId), eq(favorites.eventId, eventId)));
    response.sendStatus(204);
  }),
);

app.get(
  "/api/events",
  asyncRoute(async (request, response) => {
    const now = new Date();
    const search =
      typeof request.query.search === "string"
        ? request.query.search.trim().slice(0, 100)
        : "";
    const category =
      typeof request.query.category === "string"
        ? request.query.category.trim().slice(0, 80)
        : "";
    const minPriceRaw = request.query.minPrice;
    const maxPriceRaw = request.query.maxPrice;
    const minPrice =
      typeof minPriceRaw === "string" ? Number(minPriceRaw) : null;
    const maxPrice =
      typeof maxPriceRaw === "string" ? Number(maxPriceRaw) : null;
    if (
      (minPriceRaw !== undefined &&
        (minPrice === null || !Number.isFinite(minPrice) || minPrice < 0)) ||
      (maxPriceRaw !== undefined &&
        (maxPrice === null || !Number.isFinite(maxPrice) || maxPrice < 0)) ||
      (minPrice !== null && maxPrice !== null && maxPrice < minPrice)
    ) {
      response.status(400).json({
        error:
          "Price filters must be non-negative values with maximum at least minimum",
      });
      return;
    }
    const eventRows = await db
      .select()
      .from(events)
      .where(
        and(
          eq(events.published, true),
          gte(events.startsAt, now),
          search ? ilike(events.title, `%${search}%`) : undefined,
          category ? eq(events.category, category) : undefined,
        ),
      )
      .orderBy(asc(events.startsAt));
    const ids = eventRows.map((event) => event.id);
    const types = ids.length
      ? await db
          .select()
          .from(ticketTypes)
          .where(inArray(ticketTypes.eventId, ids))
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
      .filter((event) =>
        event.ticketTypes.some((type) => {
          const minimumMatches =
            minPrice === null || type.priceMinor >= minPrice * 100;
          const maximumMatches =
            maxPrice === null || type.priceMinor <= maxPrice * 100;
          return minimumMatches && maximumMatches;
        }),
      );
    response.json(
      await Promise.all(
        results.map(async (event) => {
          const { coverImageKey, ...publicEvent } = event;
          return {
            ...publicEvent,
            coverImageUrl: await signCoverImage(coverImageKey),
          };
        }),
      ),
    );
  }),
);

app.get(
  "/api/events/:eventId",
  asyncRoute(async (request, response) => {
    const eventId = request.params.eventId;
    if (typeof eventId !== "string") {
      response.status(400).json({ error: "Invalid event id" });
      return;
    }
    const [event] = await db
      .select()
      .from(events)
      .where(and(eq(events.id, eventId), eq(events.published, true)))
      .limit(1);
    if (!event) {
      response.status(404).json({ error: "Event not found" });
      return;
    }
    const [types, reviewRows] = await Promise.all([
      db.select().from(ticketTypes).where(eq(ticketTypes.eventId, event.id)),
      db
        .select({ rating: reviews.rating })
        .from(reviews)
        .where(eq(reviews.eventId, event.id)),
    ]);
    const [organizer] = event.createdById
      ? await db
          .select({ name: users.name })
          .from(users)
          .where(eq(users.id, event.createdById))
          .limit(1)
      : [];
    const { coverImageKey, ...publicEvent } = event;
    response.json({
      ...publicEvent,
      coverImageUrl: await signCoverImage(coverImageKey),
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
  }),
);

app.get(
  "/api/events/:eventId/reviews",
  asyncRoute(async (request, response) => {
    const eventId = request.params.eventId;
    if (typeof eventId !== "string") {
      response.status(400).json({ error: "Invalid event id" });
      return;
    }
    const rows = await db
      .select({
        id: reviews.id,
        rating: reviews.rating,
        comment: reviews.comment,
        createdAt: reviews.createdAt,
        name: users.name,
      })
      .from(reviews)
      .innerJoin(users, eq(reviews.userId, users.id))
      .innerJoin(events, eq(reviews.eventId, events.id))
      .where(and(eq(reviews.eventId, eventId), eq(events.published, true)));
    response.json(rows);
  }),
);

app.post(
  "/api/events/:eventId/reviews",
  authenticate,
  asyncRoute(async (request, response) => {
    const eventId = request.params.eventId;
    if (typeof eventId !== "string") {
      response.status(400).json({ error: "Invalid event id" });
      return;
    }
    const parsed = z
      .object({
        rating: z.number().int().min(1).max(5),
        comment: z.string().trim().max(1000).optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error:
          "Provide a rating from 1 to 5 and an optional comment up to 1000 characters",
      });
      return;
    }
    const { userId } = (request as AuthedRequest).auth!;
    const [eligible] = await db
      .select({ id: purchases.id })
      .from(purchases)
      .innerJoin(ticketTypes, eq(purchases.ticketTypeId, ticketTypes.id))
      .innerJoin(events, eq(ticketTypes.eventId, events.id))
      .innerJoin(tickets, eq(tickets.purchaseId, purchases.id))
      .where(
        and(
          eq(purchases.status, "PAID"),
          eq(events.id, eventId),
          or(
            eq(tickets.ownerId, userId),
            and(isNull(tickets.ownerId), eq(purchases.userId, userId)),
          ),
          sql`COALESCE(${events.endsAt}, ${events.startsAt}) <= ${new Date()}`,
        ),
      )
      .limit(1);
    if (!eligible) {
      response.status(403).json({
        error:
          "Only customers with a paid ticket can review an event after it ends",
      });
      return;
    }
    const [review] = await db
      .insert(reviews)
      .values({
        id: randomUUID(),
        eventId,
        userId,
        rating: parsed.data.rating,
        comment: parsed.data.comment || null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [reviews.eventId, reviews.userId],
        set: {
          rating: parsed.data.rating,
          comment: parsed.data.comment || null,
          updatedAt: new Date(),
        },
      })
      .returning();
    response.status(201).json(review);
  }),
);

const ticketTypeInput = z.object({
  name: z.string().trim().min(1).max(100),
  priceMinor: z.number().int().min(0).max(100_000_000),
  currency: z
    .string()
    .length(3)
    .transform((currency) => currency.toUpperCase())
    .default("GHS"),
  quantity: z.number().int().min(1).max(100_000),
});
const eventInput = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(5000).nullable().optional(),
  coverImageKey: z
    .string()
    .max(128)
    .regex(/^[A-Za-z0-9_-]+\/[a-f0-9-]{36}\.(jpg|png|webp)$/i)
    .nullable()
    .optional(),
  venue: z.string().trim().min(1).max(250),
  category: z.string().trim().min(1).max(80).default("Other"),
  agenda: z.string().trim().max(5000).nullable().optional(),
  accessibility: z.string().trim().max(2000).nullable().optional(),
  refundPolicy: z.string().trim().max(2000).nullable().optional(),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date().nullable().optional(),
  published: z.boolean().default(false),
  ticketTypes: z.array(ticketTypeInput).min(1).max(30),
});

app.use(
  "/api/admin/event-covers/content",
  ...organizerOnly,
  coverUploadLimiter,
  createCoverUploadRouter({
    configured: Boolean(s3Bucket && awsRegion),
    save: async (request, bytes, contentType) => {
      const { userId } = (request as AuthedRequest).auth!;
      const extension = coverImageTypes[contentType as keyof typeof coverImageTypes];
      const key = `${userId}/${randomUUID()}.${extension}`;
      await s3Client.send(new PutObjectCommand({
        Bucket: s3Bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
      }));
      return key;
    },
  }),
);

const coverUploadInput = z.object({
  contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
});

app.post(
  "/api/admin/event-covers/upload",
  ...organizerOnly,
  coverUploadLimiter,
  asyncRoute(async (request, response) => {
    const parsed = coverUploadInput.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "Choose a JPEG, PNG, or WebP image" });
      return;
    }
    if (!s3Bucket || !awsRegion) {
      response
        .status(503)
        .json({ error: "Event image storage is not configured" });
      return;
    }
    const { userId } = (request as AuthedRequest).auth!;
    const extension = coverImageTypes[parsed.data.contentType];
    const key = `${userId}/${randomUUID()}.${extension}`;
    const upload = await createPresignedPost(s3Client, {
      Bucket: s3Bucket,
      Key: key,
      Expires: 300,
      Fields: { "Content-Type": parsed.data.contentType },
      Conditions: [
        ["content-length-range", 1, maxCoverImageBytes],
        ["eq", "$Content-Type", parsed.data.contentType],
        ["eq", "$key", key],
      ],
    });
    response.json({ uploadUrl: upload.url, fields: upload.fields, key });
  }),
);

app.get(
  "/api/admin/events",
  ...organizerOnly,
  asyncRoute(async (request, response) => {
    const { userId, role } = (request as AuthedRequest).auth!;
    const eventRows = await db
      .select()
      .from(events)
      .where(role === "ADMIN" ? undefined : eq(events.createdById, userId))
      .orderBy(desc(events.startsAt));
    const ids = eventRows.map((event) => event.id);
    const types = ids.length
      ? await db
          .select()
          .from(ticketTypes)
          .where(inArray(ticketTypes.eventId, ids))
      : [];
    response.json(
      await Promise.all(
        eventRows.map(async (event) => ({
          ...event,
          coverImageUrl: await signCoverImage(event.coverImageKey),
          ticketTypes: types.filter((type) => type.eventId === event.id),
        })),
      ),
    );
  }),
);

app.post(
  "/api/admin/events",
  ...eventOwnerOnly,
  asyncRoute(async (request, response) => {
    const parsed = eventInput.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: "Provide event details and at least one valid ticket type",
      });
      return;
    }
    const { ticketTypes: typeRows, ...event } = parsed.data;
    if (
      event.coverImageKey &&
      !(await verifyCoverImageKey(
        event.coverImageKey,
        (request as AuthedRequest).auth!.userId,
      ))
    ) {
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
    if (
      event.published &&
      (event.startsAt <= new Date() || typeRows.length === 0)
    ) {
      response.status(400).json({
        error:
          "Add at least one ticket type and choose a future start time before publishing",
      });
      return;
    }
    const { userId } = (request as AuthedRequest).auth!;
    const created = await db.transaction(async (tx) => {
      const id = randomUUID();
      const [createdEvent] = await tx
        .insert(events)
        .values({ ...event, id, createdById: userId, updatedAt: new Date() })
        .returning();
      const createdTypes = await tx
        .insert(ticketTypes)
        .values(
          typeRows.map((type) => ({ ...type, id: randomUUID(), eventId: id })),
        )
        .returning();
      return { ...createdEvent, ticketTypes: createdTypes };
    });
    response.status(201).json({
      ...created,
      coverImageUrl: await signCoverImage(created.coverImageKey),
    });
  }),
);

app.put(
  "/api/admin/events/:eventId",
  ...organizerOnly,
  asyncRoute(async (request, response) => {
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
    const { userId, role } = (request as AuthedRequest).auth!;
    if (
      event.coverImageKey &&
      !(await verifyCoverImageKey(event.coverImageKey, userId))
    ) {
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
    const updated = await db.transaction(async (tx) => {
      const scope =
        role === "ADMIN"
          ? eq(events.id, eventId)
          : and(eq(events.id, eventId), eq(events.createdById, userId));
      const [current] = await tx.select().from(events).where(scope).limit(1);
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
          .select({ id: ticketTypes.id })
          .from(ticketTypes)
          .where(eq(ticketTypes.eventId, eventId))
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
        .update(events)
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
            .insert(ticketTypes)
            .values(
              typeRows.map((type) => ({ ...type, id: randomUUID(), eventId })),
            )
            .returning()
        : [];
      const existingTypes = createdTypes.length
        ? createdTypes
        : await tx
            .select()
            .from(ticketTypes)
            .where(eq(ticketTypes.eventId, eventId));
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
        error:
          "Add at least one ticket type and choose a future start time before publishing",
      });
      return;
    }
    if (!updated.event) {
      response.status(404).json({ error: "Event not found" });
      return;
    }
    response.json({
      ...updated.event,
      coverImageUrl: await signCoverImage(updated.event.coverImageKey),
    });
  }),
);

app.delete(
  "/api/admin/events/:eventId",
  ...organizerOnly,
  asyncRoute(async (request, response) => {
    const eventId = request.params.eventId;
    if (typeof eventId !== "string") {
      response.status(400).json({ error: "Invalid event id" });
      return;
    }
    const { userId, role } = (request as AuthedRequest).auth!;
    const [deleted] = await db
      .delete(events)
      .where(
        role === "ADMIN"
          ? eq(events.id, eventId)
          : and(eq(events.id, eventId), eq(events.createdById, userId)),
      )
      .returning({ id: events.id });
    if (!deleted) {
      response.status(404).json({ error: "Event not found" });
      return;
    }
    response.sendStatus(204);
  }),
);

app.patch(
  "/api/admin/ticket-types/:ticketTypeId",
  ...organizerOnly,
  asyncRoute(async (request, response) => {
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
    const { userId, role } = (request as AuthedRequest).auth!;
    const updated = await db.transaction(async (tx) => {
      const [current] = await tx
        .select({ type: ticketTypes, ownerId: events.createdById })
        .from(ticketTypes)
        .innerJoin(events, eq(ticketTypes.eventId, events.id))
        .where(eq(ticketTypes.id, ticketTypeId))
        .limit(1);
      if (!current) return { type: null, invalidCapacity: false };
      if (role !== "ADMIN" && current.ownerId !== userId)
        return { type: null, invalidCapacity: false };
      const quantity = parsed.data.quantity ?? current.type.quantity;
      if (quantity < current.type.sold + current.type.reserved)
        return { type: null, invalidCapacity: true };
      const [type] = await tx
        .update(ticketTypes)
        .set(parsed.data)
        .where(eq(ticketTypes.id, ticketTypeId))
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
  }),
);

app.get(
  "/api/admin/summary",
  ...organizerOnly,
  asyncRoute(async (request, response) => {
    const { userId, role } = (request as AuthedRequest).auth!;
    const eventScope =
      role === "ADMIN" ? undefined : eq(events.createdById, userId);
    const purchaseScope =
      role === "ADMIN" ? undefined : eq(events.createdById, userId);
    const [eventCount] = await db
      .select({ value: count() })
      .from(events)
      .where(eventScope);
    const [paidPurchases] = await db
      .select({ value: count() })
      .from(purchases)
      .innerJoin(ticketTypes, eq(purchases.ticketTypeId, ticketTypes.id))
      .innerJoin(events, eq(ticketTypes.eventId, events.id))
      .where(and(eq(purchases.status, "PAID"), purchaseScope));
    const [ticketCount] = await db
      .select({ value: count() })
      .from(tickets)
      .innerJoin(purchases, eq(tickets.purchaseId, purchases.id))
      .innerJoin(ticketTypes, eq(purchases.ticketTypeId, ticketTypes.id))
      .innerJoin(events, eq(ticketTypes.eventId, events.id))
      .where(purchaseScope);
    const [checkedInCount] = await db
      .select({ value: count() })
      .from(tickets)
      .innerJoin(purchases, eq(tickets.purchaseId, purchases.id))
      .innerJoin(ticketTypes, eq(purchases.ticketTypeId, ticketTypes.id))
      .innerJoin(events, eq(ticketTypes.eventId, events.id))
      .where(
        and(
          isNotNull(tickets.checkedInAt),
          isNull(tickets.checkedOutAt),
          purchaseScope,
        ),
      );
    const [ticketsEverCheckedIn] = await db
      .select({ value: count() })
      .from(tickets)
      .innerJoin(purchases, eq(tickets.purchaseId, purchases.id))
      .innerJoin(ticketTypes, eq(purchases.ticketTypeId, ticketTypes.id))
      .innerJoin(events, eq(ticketTypes.eventId, events.id))
      .where(and(isNotNull(tickets.checkedInAt), purchaseScope));
    const [totalCheckIns] = await db
      .select({ value: count() })
      .from(checkInLogs)
      .innerJoin(events, eq(checkInLogs.eventId, events.id))
      .where(eventScope);
    const [legacyCheckIns] = await db
      .select({ value: count() })
      .from(tickets)
      .innerJoin(purchases, eq(tickets.purchaseId, purchases.id))
      .innerJoin(ticketTypes, eq(purchases.ticketTypeId, ticketTypes.id))
      .innerJoin(events, eq(ticketTypes.eventId, events.id))
      .where(
        and(
          isNotNull(tickets.checkedInAt),
          purchaseScope,
          sql`NOT EXISTS (SELECT 1 FROM "TicketCheckIn" WHERE "TicketCheckIn"."ticketId" = ${tickets.id})`,
        ),
      );
    const revenue = await db
      .select({
        currency: purchases.currency,
        amountMinor: sum(purchases.amountMinor),
      })
      .from(purchases)
      .innerJoin(ticketTypes, eq(purchases.ticketTypeId, ticketTypes.id))
      .innerJoin(events, eq(ticketTypes.eventId, events.id))
      .where(and(eq(purchases.status, "PAID"), purchaseScope))
      .groupBy(purchases.currency);
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
  }),
);

app.get(
  "/api/admin/purchases",
  ...organizerOnly,
  asyncRoute(async (request, response) => {
    const { userId, role } = (request as AuthedRequest).auth!;
    const rows = await db
      .select({
        reference: purchases.reference,
        customer: users.name,
        email: purchases.email,
        event: events.title,
        ticketType: ticketTypes.name,
        quantity: purchases.quantity,
        amountMinor: purchases.amountMinor,
        currency: purchases.currency,
        createdAt: purchases.createdAt,
      })
      .from(purchases)
      .innerJoin(ticketTypes, eq(purchases.ticketTypeId, ticketTypes.id))
      .innerJoin(events, eq(ticketTypes.eventId, events.id))
      .leftJoin(users, eq(purchases.userId, users.id))
      .where(
        and(
          eq(purchases.status, "PAID"),
          role === "ADMIN" ? undefined : eq(events.createdById, userId),
        ),
      )
      .orderBy(desc(purchases.createdAt))
      .limit(100);
    response.json(
      rows.map((row) => ({
        ...row,
        customer: row.customer ?? "Legacy customer",
      })),
    );
  }),
);

app.get(
  "/api/admin/promotions",
  ...organizerOnly,
  asyncRoute(async (request, response) => {
    const { userId, role } = (request as AuthedRequest).auth!;
    const rows = await db
      .select()
      .from(promotions)
      .where(role === "ADMIN" ? undefined : eq(promotions.createdById, userId))
      .orderBy(desc(promotions.createdAt));
    response.json(rows);
  }),
);

app.post(
  "/api/admin/promotions",
  ...organizerOnly,
  asyncRoute(async (request, response) => {
    const { userId, role } = (request as AuthedRequest).auth!;
    if (role !== "ORGANIZER") {
      response
        .status(403)
        .json({ error: "Only event owners can create promo codes" });
      return;
    }
    const parsed = z
      .object({
        code: z
          .string()
          .trim()
          .min(4)
          .max(24)
          .regex(/^[a-zA-Z0-9_-]+$/)
          .transform((value) => value.toUpperCase()),
        percentOff: z.number().int().min(1).max(90),
        eventId: z.string().min(1).optional(),
        maxUses: z.number().int().min(1).max(100000).nullable().optional(),
        expiresAt: z.coerce.date().nullable().optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: "Provide a 4–24 character code and a discount from 1% to 90%",
      });
      return;
    }
    if (parsed.data.eventId) {
      const [event] = await db
        .select({ id: events.id })
        .from(events)
        .where(
          and(
            eq(events.id, parsed.data.eventId),
            eq(events.createdById, userId),
          ),
        )
        .limit(1);
      if (!event) {
        response.status(404).json({ error: "Event not found" });
        return;
      }
    }
    const [promo] = await db
      .insert(promotions)
      .values({ ...parsed.data, id: randomUUID(), createdById: userId })
      .returning();
    response.status(201).json(promo);
  }),
);

app.post(
  "/api/me/refund-requests",
  authenticate,
  asyncRoute(async (request, response) => {
    const parsed = z
      .object({
        purchaseId: z.string().min(1),
        reason: z.string().trim().min(5).max(1000),
      })
      .safeParse(request.body);
    if (!parsed.success) {
      response
        .status(400)
        .json({ error: "Provide a reason between 5 and 1000 characters" });
      return;
    }
    const { userId } = (request as AuthedRequest).auth!;
    const [purchase] = await db
      .select({
        id: purchases.id,
        userId: purchases.userId,
        status: purchases.status,
      })
      .from(purchases)
      .where(eq(purchases.id, parsed.data.purchaseId))
      .limit(1);
    if (!purchase || purchase.userId !== userId || purchase.status !== "PAID") {
      response.status(404).json({ error: "Paid purchase not found" });
      return;
    }
    const [refund] = await db
      .insert(refundRequests)
      .values({
        id: randomUUID(),
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
  }),
);

app.get(
  "/api/me/refund-requests",
  authenticate,
  asyncRoute(async (request, response) => {
    const { userId } = (request as AuthedRequest).auth!;
    const rows = await db
      .select({ request: refundRequests, reference: purchases.reference })
      .from(refundRequests)
      .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
      .where(eq(refundRequests.userId, userId))
      .orderBy(desc(refundRequests.createdAt));
    response.json(
      rows.map((row) => ({ ...row.request, reference: row.reference })),
    );
  }),
);

app.get(
  "/api/admin/refund-requests",
  ...organizerOnly,
  asyncRoute(async (request, response) => {
    const { userId, role } = (request as AuthedRequest).auth!;
    const rows = await db
      .select({
        request: refundRequests,
        reference: purchases.reference,
        email: purchases.email,
        eventId: events.id,
        event: events.title,
      })
      .from(refundRequests)
      .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
      .innerJoin(ticketTypes, eq(purchases.ticketTypeId, ticketTypes.id))
      .innerJoin(events, eq(ticketTypes.eventId, events.id))
      .where(role === "ADMIN" ? undefined : eq(events.createdById, userId))
      .orderBy(desc(refundRequests.createdAt));
    response.json(
      rows.map((row) => ({
        ...row.request,
        reference: row.reference,
        email: row.email,
        eventId: row.eventId,
        event: row.event,
      })),
    );
  }),
);

app.patch(
  "/api/admin/refund-requests/:requestId",
  ...organizerOnly,
  asyncRoute(async (request, response) => {
    const requestId = request.params.requestId;
    if (typeof requestId !== "string") {
      response.status(400).json({ error: "Invalid refund request id" });
      return;
    }
    const parsed = z
      .object({
        status: z.enum(["APPROVED", "REJECTED"]),
        decisionNote: z.string().trim().max(1000).optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: "Choose approved or rejected with an optional note",
      });
      return;
    }
    const { userId, role } = (request as AuthedRequest).auth!;
    const [current] = await db
      .select({ ownerId: events.createdById, request: refundRequests })
      .from(refundRequests)
      .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
      .innerJoin(ticketTypes, eq(purchases.ticketTypeId, ticketTypes.id))
      .innerJoin(events, eq(ticketTypes.eventId, events.id))
      .where(eq(refundRequests.id, requestId))
      .limit(1);
    if (!current || (role !== "ADMIN" && current.ownerId !== userId)) {
      response.status(404).json({ error: "Refund request not found" });
      return;
    }
    if (!canReviewRefundStatus(current.request.status)) {
      response.status(409).json({
        error: "Only pending refund requests can be reviewed",
      });
      return;
    }
    const [updated] = await db
      .update(refundRequests)
      .set({
        status: parsed.data.status,
        decisionNote: parsed.data.decisionNote ?? null,
        updatedAt: new Date(),
      })
      .where(eq(refundRequests.id, current.request.id))
      .returning();
    response.json(updated);
  }),
);

app.get(
  "/api/me/referral",
  authenticate,
  asyncRoute(async (request, response) => {
    const { userId } = (request as AuthedRequest).auth!;
    const [user] = await db
      .select({ referralCode: users.referralCode })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const [referrals] = await db
      .select({ value: count() })
      .from(users)
      .where(eq(users.referredById, userId));
    response.json({
      referralCode: user.referralCode,
      referralCount: referrals.value,
    });
  }),
);

app.post(
  "/api/me/tickets/:ticketId/transfer",
  authenticate,
  asyncRoute(async (request, response) => {
    const ticketId = request.params.ticketId;
    if (typeof ticketId !== "string") {
      response.status(400).json({ error: "Invalid ticket id" });
      return;
    }
    const parsed = z
      .object({
        email: z
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
    const { userId } = (request as AuthedRequest).auth!;
    const [ticket] = await db
      .select({
        ticket: tickets,
        purchase: purchases,
        startsAt: events.startsAt,
      })
      .from(tickets)
      .innerJoin(purchases, eq(tickets.purchaseId, purchases.id))
      .innerJoin(ticketTypes, eq(purchases.ticketTypeId, ticketTypes.id))
      .innerJoin(events, eq(ticketTypes.eventId, events.id))
      .where(eq(tickets.id, ticketId))
      .limit(1);
    if (
      !ticket ||
      ticket.purchase.status !== "PAID" ||
      (ticket.ticket.ownerId ?? ticket.purchase.userId) !== userId ||
      ticket.startsAt <= new Date()
    ) {
      response.status(404).json({ error: "Transferable ticket not found" });
      return;
    }
    const [recipient] = await db
      .select({ id: users.id, emailVerified: users.emailVerified })
      .from(users)
      .where(eq(users.email, parsed.data.email))
      .limit(1);
    if (!recipient || !recipient.emailVerified || recipient.id === userId) {
      response.status(400).json({
        error:
          "Recipient must be a different registered user with a verified email",
      });
      return;
    }
    const rotatedToken = randomBytes(32).toString("base64url");
    const [updated] = await db
      .update(tickets)
      .set({
        ownerId: recipient.id,
        tokenHash: createHash("sha256").update(rotatedToken).digest("hex"),
        encryptedToken: encryptTicketToken(rotatedToken),
      })
      .where(
        and(
          eq(tickets.id, ticket.ticket.id),
          isNull(tickets.checkedInAt),
          ticket.ticket.ownerId === null
            ? isNull(tickets.ownerId)
            : eq(tickets.ownerId, userId),
        ),
      )
      .returning({ id: tickets.id });
    if (!updated) {
      response.status(409).json({
        error: "Ticket is already checked in and cannot be transferred",
      });
      return;
    }
    response.json({ message: "Ticket transferred." });
  }),
);

const purchaseInput = z.object({
  ticketTypeId: z.string().min(1),
  quantity: z.number().int().min(1).max(10),
  promoCode: z.string().trim().max(24).optional(),
});

app.post(
  "/api/purchases",
  authenticate,
  asyncRoute(async (request, response) => {
    const parsed = purchaseInput.safeParse(request.body);
    if (!parsed.success) {
      response
        .status(400)
        .json({ error: "Select a ticket type and quantity from 1 to 10" });
      return;
    }
    const { userId } = (request as AuthedRequest).auth!;
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
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

    const reference = `TKT-${randomUUID().replaceAll("-", "")}`;
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    let purchase: typeof purchases.$inferSelect;
    try {
      purchase = await db.transaction(async (tx) => {
        const [type] = await tx
          .select({
            id: ticketTypes.id,
            priceMinor: ticketTypes.priceMinor,
            currency: ticketTypes.currency,
            eventPublished: events.published,
            eventStartsAt: events.startsAt,
            eventId: events.id,
          })
          .from(ticketTypes)
          .innerJoin(events, eq(ticketTypes.eventId, events.id))
          .where(eq(ticketTypes.id, parsed.data.ticketTypeId))
          .limit(1);
        if (!type || !type.eventPublished || type.eventStartsAt <= new Date())
          throw new Error("TICKETS_UNAVAILABLE");

        let promo: typeof promotions.$inferSelect | undefined;
        if (parsed.data.promoCode) {
          [promo] = await tx
            .select()
            .from(promotions)
            .where(eq(promotions.code, parsed.data.promoCode.toUpperCase()))
            .limit(1);
          if (
            !promo ||
            (promo.eventId && promo.eventId !== type.eventId) ||
            (promo.expiresAt && promo.expiresAt <= new Date()) ||
            (promo.maxUses !== null && promo.uses >= promo.maxUses)
          ) {
            throw new Error("PROMO_INVALID");
          }
          const [reservedPromo] = await tx
            .update(promotions)
            .set({ uses: sql`${promotions.uses} + 1` })
            .where(
              and(
                eq(promotions.id, promo.id),
                promo.maxUses === null
                  ? undefined
                  : sql`${promotions.uses} < ${promo.maxUses}`,
                promo.expiresAt === null
                  ? undefined
                  : gte(promotions.expiresAt, new Date()),
              ),
            )
            .returning({ id: promotions.id });
          if (!reservedPromo) throw new Error("PROMO_INVALID");
        }

        const stale = await tx
          .select({
            id: purchases.id,
            quantity: purchases.quantity,
            ticketTypeId: purchases.ticketTypeId,
            promoCodeId: purchases.promoCodeId,
          })
          .from(purchases)
          .where(
            and(
              eq(purchases.status, "PENDING"),
              lt(purchases.expiresAt, new Date()),
            ),
          );
        for (const expiredPurchase of stale) {
          const [expired] = await tx
            .update(purchases)
            .set({ status: "FAILED", updatedAt: new Date() })
            .where(
              and(
                eq(purchases.id, expiredPurchase.id),
                eq(purchases.status, "PENDING"),
              ),
            )
            .returning({ id: purchases.id });
          if (expired) {
            await tx
              .update(ticketTypes)
              .set({
                reserved: sql`${ticketTypes.reserved} - ${expiredPurchase.quantity}`,
              })
              .where(eq(ticketTypes.id, expiredPurchase.ticketTypeId));
            if (expiredPurchase.promoCodeId) {
              await tx
                .update(promotions)
                .set({ uses: sql`GREATEST(${promotions.uses} - 1, 0)` })
                .where(eq(promotions.id, expiredPurchase.promoCodeId));
            }
          }
        }

        const [available] = await tx
          .update(ticketTypes)
          .set({
            reserved: sql`${ticketTypes.reserved} + ${parsed.data.quantity}`,
          })
          .where(
            and(
              eq(ticketTypes.id, type.id),
              sql`${ticketTypes.quantity} - ${ticketTypes.sold} - ${ticketTypes.reserved} >= ${parsed.data.quantity}`,
            ),
          )
          .returning({ id: ticketTypes.id });
        if (!available) throw new Error("TICKETS_UNAVAILABLE");

        const [created] = await tx
          .insert(purchases)
          .values({
            id: randomUUID(),
            reference,
            userId,
            ticketTypeId: type.id,
            email: user.email,
            quantity: parsed.data.quantity,
            amountMinor: promo
              ? Math.floor(
                  (type.priceMinor *
                    parsed.data.quantity *
                    (100 - promo.percentOff)) /
                    100,
                )
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
    } catch (error) {
      if (error instanceof Error && error.message === "TICKETS_UNAVAILABLE") {
        response
          .status(409)
          .json({ error: "Tickets are unavailable in that quantity" });
        return;
      }
      if (error instanceof Error && error.message === "PROMO_INVALID") {
        response.status(400).json({
          error:
            "Promo code is invalid, expired, fully redeemed, or not valid for this event",
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
          callback_url:
            process.env.PAYSTACK_CALLBACK_URL || "ticketing://payment",
          metadata: { purchaseId: purchase.id, userId },
        }),
      });
      if (
        !result.data?.authorization_url ||
        result.data.reference !== reference
      ) {
        throw new Error(
          "Payment provider returned an invalid checkout session",
        );
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
    } catch (error) {
      try {
        await releaseFailedPurchase(reference);
      } catch (releaseError) {
        console.error(
          "Could not release ticket reservation after checkout initialization failed:",
          releaseError,
        );
      }
      console.error("Payment checkout initialization failed:", error);
      response.status(502).json({
        error:
          error instanceof Error
            ? `Could not start payment checkout: ${error.message}`
            : "Could not start payment checkout. Please try again.",
      });
    }
  }),
);

app.get(
  "/api/payments/verify/:reference",
  authenticate,
  asyncRoute(async (request, response) => {
    const reference = request.params.reference;
    if (typeof reference !== "string") {
      response.status(400).json({ error: "Invalid payment reference" });
      return;
    }
    const { userId } = (request as AuthedRequest).auth!;
    const [purchase] = await db
      .select()
      .from(purchases)
      .where(eq(purchases.reference, reference))
      .limit(1);
    if (!purchase || purchase.userId !== userId) {
      response.status(404).json({ error: "Purchase not found" });
      return;
    }
    try {
      const valid = await verifyPaystackPayment(purchase.reference);
      const [updated] = await db
        .select()
        .from(purchases)
        .where(eq(purchases.id, purchase.id))
        .limit(1);
      const [ticketCount] = await db
        .select({ value: count() })
        .from(tickets)
        .where(eq(tickets.purchaseId, purchase.id));
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
    } catch (error) {
      console.error("Payment verification failed:", error);
      response
        .status(502)
        .json({ error: "Could not verify payment. Please try again." });
    }
  }),
);

app.get(
  "/api/purchases",
  authenticate,
  asyncRoute(async (request, response) => {
    const { userId } = (request as AuthedRequest).auth!;
    const ownedTicketRows = await db
      .select({ purchaseId: tickets.purchaseId })
      .from(tickets)
      .where(eq(tickets.ownerId, userId));
    const ownedPurchaseIds = ownedTicketRows.map((ticket) => ticket.purchaseId);
    const rows = await db
      .select({
        id: purchases.id,
        ownerUserId: purchases.userId,
        reference: purchases.reference,
        status: purchases.status,
        amountMinor: purchases.amountMinor,
        originalAmountMinor: purchases.originalAmountMinor,
        discountPercent: purchases.discountPercent,
        currency: purchases.currency,
        quantity: purchases.quantity,
        createdAt: purchases.createdAt,
        eventTitle: events.title,
        eventId: events.id,
        venue: events.venue,
        startsAt: events.startsAt,
        endsAt: events.endsAt,
        ticketType: ticketTypes.name,
      })
      .from(purchases)
      .innerJoin(ticketTypes, eq(purchases.ticketTypeId, ticketTypes.id))
      .innerJoin(events, eq(ticketTypes.eventId, events.id))
      .where(
        or(
          eq(purchases.userId, userId),
          ownedPurchaseIds.length
            ? inArray(purchases.id, ownedPurchaseIds)
            : undefined,
        ),
      )
      .orderBy(desc(purchases.createdAt));

    const purchaseIds = rows.map((purchase) => purchase.id);
    const ticketRows = purchaseIds.length
      ? await db
          .select()
          .from(tickets)
          .where(inArray(tickets.purchaseId, purchaseIds))
      : [];
    response.json(
      rows.map((purchase) => ({
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
        tickets:
          purchase.status === "PAID"
            ? ticketRows
                .filter(
                  (ticket) =>
                    ticket.purchaseId === purchase.id &&
                    (ticket.ownerId === userId ||
                      (ticket.ownerId === null &&
                        purchase.ownerUserId === userId)) &&
                    ticket.encryptedToken,
                )
                .map((ticket) => ({
                  id: ticket.id,
                  checkedInAt: ticket.checkedInAt,
                  checkedOutAt: ticket.checkedOutAt,
                  token: decryptTicketToken(ticket.encryptedToken),
                }))
            : [],
      })),
    );
  }),
);

const checkInSchema = z.object({
  token: z.string().min(16).max(256),
  action: z.enum(["CHECK_IN", "CHECK_OUT"]).default("CHECK_IN"),
});
app.post(
  "/api/admin/check-in",
  ...organizerOnly,
  asyncRoute(async (request, response) => {
    const parsed = checkInSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "Invalid ticket token" });
      return;
    }
    const tokenHash = createHash("sha256")
      .update(parsed.data.token)
      .digest("hex");
    const { userId, role } = (request as AuthedRequest).auth!;
    const ticket = await db
      .select({
        id: tickets.id,
        eventId: events.id,
        checkedInAt: tickets.checkedInAt,
        checkedOutAt: tickets.checkedOutAt,
        status: purchases.status,
        event: events.title,
        ticketType: ticketTypes.name,
        ownerId: events.createdById,
      })
      .from(tickets)
      .innerJoin(purchases, eq(tickets.purchaseId, purchases.id))
      .innerJoin(ticketTypes, eq(purchases.ticketTypeId, ticketTypes.id))
      .innerJoin(events, eq(ticketTypes.eventId, events.id))
      .where(eq(tickets.tokenHash, tokenHash))
      .limit(1);
    const found = ticket[0];
    if (
      !found ||
      found.status !== "PAID" ||
      (role !== "ADMIN" && found.ownerId !== userId)
    ) {
      response.status(404).json({ error: "Ticket not found or not paid" });
      return;
    }
    const now = new Date();
    if (
      !canTransitionCheckIn(
        parsed.data.action,
        found.checkedInAt,
        found.checkedOutAt,
      )
    ) {
      if (parsed.data.action === "CHECK_IN") {
        response.status(409).json({
          error:
            "Ticket is already checked in. Choose check out only when the attendee is leaving.",
        });
      } else {
        response
          .status(409)
          .json({ error: "Ticket is not currently checked in." });
      }
      return;
    }
    const updated = await db.transaction(async (tx) => {
      const [ticketUpdate] = await tx
        .update(tickets)
        .set(
          parsed.data.action === "CHECK_IN"
            ? { checkedInAt: now, checkedOutAt: null }
            : { checkedOutAt: now },
        )
        .where(
          and(
            eq(tickets.id, found.id),
            parsed.data.action === "CHECK_IN"
              ? or(isNull(tickets.checkedInAt), isNotNull(tickets.checkedOutAt))
              : and(
                  isNotNull(tickets.checkedInAt),
                  isNull(tickets.checkedOutAt),
                ),
          ),
        )
        .returning({ id: tickets.id });
      if (!ticketUpdate) return null;
      if (parsed.data.action === "CHECK_IN") {
        await tx.insert(checkInLogs).values({
          id: randomUUID(),
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
  }),
);

app.use(
  (
    error: unknown,
    _request: Request,
    response: Response,
    _next: NextFunction,
  ) => {
    console.error(error);
    const code =
      typeof error === "object" && error !== null && "code" in error
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
  },
);

const server = app.listen(port, "0.0.0.0", () => {
  console.log(`Ticketing API listening on port ${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      void client.end().finally(() => process.exit(0));
    });
  });
}
