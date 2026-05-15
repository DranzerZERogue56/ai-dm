import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Env } from "../index";
import * as schema from "./schema";

export type DB = PostgresJsDatabase<typeof schema>;

let cached: DB | null = null;

export function getDb(env: Env): DB | null {
  if (cached) return cached;
  const connStr = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  if (!connStr) return null;
  const sql = postgres(connStr, { max: 5, fetch_types: false, prepare: false });
  cached = drizzle(sql, { schema });
  return cached;
}
