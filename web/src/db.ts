import { Kysely, PostgresDialect, type Dialect } from "kysely";
import pg from "pg";

// One Kysely instance serves better-auth and the server's own tables. Production uses a pg pool; the tests use PGlite.
export type Database = Kysely<any>;

export function createDatabase(dialect: Dialect): Database {
  return new Kysely({ dialect });
}

export function postgres(connectionString: string): Database {
  return createDatabase(new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 }) }));
}
