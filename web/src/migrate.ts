// Creates and updates the database tables at start: the better-auth tables (with its migration planner, which only
// adds tables, columns and indexes) and the server's own tables.
import { getMigrations } from "better-auth/db/migration";
import { sql } from "kysely";
import type { Auth } from "./auth.js";
import type { Database } from "./db.js";
import { SECRET_TABLE } from "./secret-store.js";
import { SYNC_TABLES } from "./sync.js";
import { PUSH_TABLE } from "./push.js";

const OWN_TABLES = [
  // The computer name the desktop app sent with a device code, for the /device page and the session list. Rows older
  // than one hour are removed when a new code is made.
  sql`create table if not exists opaya_device_name (
    device_code text primary key,
    user_code text not null unique,
    name text not null,
    created_at timestamptz not null default now()
  )`,
  // User secrets (Phase 2), encrypted with Cloud KMS envelope encryption (secret-store.ts).
  SECRET_TABLE,
  // Sync between the desktop app and the web app (sync.ts, SYNC_PLAN.md).
  ...SYNC_TABLES,
  // Web Push subscriptions of the web app's browsers (push.ts).
  PUSH_TABLE,
];

export async function migrate(auth: Auth, db: Database) {
  const { runMigrations, toBeCreated, toBeAdded } = await getMigrations(auth.options);
  await runMigrations();
  for (const statement of OWN_TABLES) await statement.execute(db);
  return { created: toBeCreated.map(t => t.table), added: toBeAdded.map(t => t.table) };
}
