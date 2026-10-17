// Sync between the desktop app and the web app (SYNC_PLAN.md). The server keeps one copy of each organization's synced
// records with a change counter (rev); clients pull what changed after the last rev they saw, then push their own
// changes. The version the server receives last wins. Deleted items stay as tombstones for 90 days.
import { sql } from "kysely";
import type { Database } from "./db.js";

export const KINDS = new Set(["host", "agent", "mcp", "conversation", "transcript", "secret", "settings"]);
export const LIMITS = { record: 256 * 1024, transcript: 1024 * 1024, push: 500, page: 500, organization: 100 * 1024 * 1024 };
export const TOMBSTONE_DAYS = 90;
const ID = /^[A-Za-z0-9_-]{1,80}$/;

export const SYNC_TABLES = [
  sql`create table if not exists opaya_sync_record (
    organization_id text not null,
    kind text not null,
    id text not null,
    rev bigint not null,
    deleted boolean not null default false,
    data jsonb,
    size integer not null default 0,
    updated_at timestamptz not null default now(),
    primary key (organization_id, kind, id)
  )`,
  sql`create index if not exists opaya_sync_record_rev on opaya_sync_record (organization_id, rev)`,
  // rev: the last change. floor: the newest tombstone that was purged; a client older than it must start again.
  sql`create table if not exists opaya_sync_state (
    organization_id text primary key,
    rev bigint not null default 0,
    floor bigint not null default 0
  )`,
];

export interface SyncRecord {
  kind: string;
  id: string;
  rev?: number;
  deleted?: boolean;
  data?: unknown;
}

export class SyncError extends Error {
  constructor(
    message: string,
    public status: 400 | 403 | 413,
  ) {
    super(message);
  }
}

function check(record: unknown): { kind: string; id: string; deleted: boolean; data: unknown; json: string | null; size: number } {
  const r = (record ?? {}) as SyncRecord;
  if (typeof r.kind !== "string" || !KINDS.has(r.kind)) throw new SyncError("Unknown record kind.", 400);
  if (typeof r.id !== "string" || !ID.test(r.id)) throw new SyncError("Invalid record ID.", 400);
  const deleted = r.deleted === true;
  if (!deleted && (r.data === null || typeof r.data !== "object" || Array.isArray(r.data))) throw new SyncError("A record needs data.", 400);
  const json = deleted ? null : JSON.stringify(r.data);
  const size = json ? Buffer.byteLength(json) : 0;
  if (size > (r.kind === "transcript" ? LIMITS.transcript : LIMITS.record)) throw new SyncError(`The ${r.kind} ${r.id} is larger than the sync limit.`, 413);
  return { kind: r.kind, id: r.id, deleted, data: deleted ? null : r.data, json, size };
}

const toRecord = (row: { kind: string; id: string; rev: string | number; deleted: boolean; data: unknown }): SyncRecord => ({ kind: row.kind, id: row.id, rev: Number(row.rev), deleted: row.deleted, ...(row.deleted ? {} : { data: typeof row.data === "string" ? JSON.parse(row.data) : row.data }) });

export async function pull(db: Database, organizationId: string, since: number) {
  if (!Number.isSafeInteger(since) || since < 0) throw new SyncError("Invalid rev.", 400);
  const state = await db.selectFrom("opaya_sync_state").selectAll().where("organization_id", "=", organizationId).executeTakeFirst();
  const floor = Number(state?.floor ?? 0), current = Number(state?.rev ?? 0);
  // Older than the purged tombstones (or newer than this server knows): start again from 0.
  const reset = since > current || (since > 0 && since < floor);
  const from = reset ? 0 : since;
  const rows = await db
    .selectFrom("opaya_sync_record")
    .select(["kind", "id", "rev", "deleted", "data"])
    .where("organization_id", "=", organizationId)
    .where("rev", ">", from)
    .$if(reset || from === 0, q => q.where("deleted", "=", false))
    .orderBy("rev")
    .limit(LIMITS.page + 1)
    .execute();
  const page = rows.slice(0, LIMITS.page);
  return { records: page.map(toRecord), rev: page.length ? Number(page.at(-1)!.rev) : from === 0 ? current : from, more: rows.length > LIMITS.page, reset };
}

export async function push(db: Database, organizationId: string, input: unknown) {
  if (!Array.isArray(input)) throw new SyncError("Send a list of records.", 400);
  if (input.length > LIMITS.push) throw new SyncError(`At most ${LIMITS.push} records in one push.`, 413);
  const records = input.map(check);
  return db.transaction().execute(async tx => {
    await tx.insertInto("opaya_sync_state").values({ organization_id: organizationId, rev: 0, floor: 0 }).onConflict(oc => oc.column("organization_id").doNothing()).execute();
    const state = await sql<{ rev: string }>`select rev from opaya_sync_state where organization_id = ${organizationId} for update`.execute(tx);
    let rev = Number(state.rows[0]!.rev);
    // The organization's size after this push.
    const old = records.length
      ? await tx
          .selectFrom("opaya_sync_record")
          .select(["kind", "id", "size"])
          .where("organization_id", "=", organizationId)
          .where(eb => eb.or(records.map(r => eb.and([eb("kind", "=", r.kind), eb("id", "=", r.id)]))))
          .execute()
      : [];
    const total = Number((await tx.selectFrom("opaya_sync_record").select(eb => eb.fn.sum<string>("size").as("total")).where("organization_id", "=", organizationId).executeTakeFirst())?.total ?? 0);
    const delta = records.reduce((n, r) => n + r.size, 0) - old.reduce((n, r) => n + Number(r.size), 0);
    if (delta > 0 && total + delta > LIMITS.organization) throw new SyncError("The synced data is over the 100 MB limit. Delete old chats, then try again.", 413);
    const revs: { kind: string; id: string; rev: number }[] = [];
    for (const r of records) {
      rev += 1;
      const row = { organization_id: organizationId, kind: r.kind, id: r.id, rev, deleted: r.deleted, data: r.json, size: r.size, updated_at: new Date() };
      await tx
        .insertInto("opaya_sync_record")
        .values(row)
        .onConflict(oc => oc.columns(["organization_id", "kind", "id"]).doUpdateSet({ rev, deleted: r.deleted, data: r.json, size: r.size, updated_at: new Date() }))
        .execute();
      revs.push({ kind: r.kind, id: r.id, rev });
    }
    await tx.updateTable("opaya_sync_state").set({ rev }).where("organization_id", "=", organizationId).execute();
    return { revs, rev };
  });
}

// Tombstones older than 90 days go; the floor tells older clients to start again.
export async function purgeTombstones(db: Database, now = Date.now()) {
  const before = new Date(now - TOMBSTONE_DAYS * 86400_000);
  const purged = await db.deleteFrom("opaya_sync_record").where("deleted", "=", true).where("updated_at", "<", before).returning(["organization_id", "rev"]).execute();
  const floors = new Map<string, number>();
  for (const p of purged) floors.set(p.organization_id as string, Math.max(floors.get(p.organization_id as string) ?? 0, Number(p.rev)));
  for (const [organizationId, floor] of floors) await db.updateTable("opaya_sync_state").set({ floor: sql`greatest(floor, ${floor})` }).where("organization_id", "=", organizationId).execute();
  return purged.length;
}

// Desktop key values ("Sync to web") go straight to the organization's KMS store, under their own Vault key name.
export const SECRET_KEY = /^opaya-secret-[0-9a-f-]{36}$/;
