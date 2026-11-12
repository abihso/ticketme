import "dotenv/config";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL must be configured");
}

export const client = postgres(databaseUrl, {
  max: 10,
  prepare: false,
  connect_timeout: 10,
  idle_timeout: 20,
});

export const db = drizzle(client, { schema });
