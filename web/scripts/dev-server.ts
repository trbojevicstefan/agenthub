// A development server with Postgres in memory (PGlite): no database to install. Data is lost when it stops.
//   npm run dev:memory --workspace web
// Emails are printed in this terminal. Set STRIPE_SECRET_KEY (test mode) and STRIPE_WEBHOOK_SECRET from `stripe listen`
// to try checkout.
import { serve } from "@hono/node-server";
import { PGlite } from "@electric-sql/pglite";
import { PGliteDialect } from "kysely-pglite-dialect";
import { createAuth } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/db.js";
import { consoleMailer } from "../src/mail.js";
import { migrate } from "../src/migrate.js";
import { createApp } from "../src/server.js";

const config = await loadConfig({ BETTER_AUTH_SECRET: "development-only-secret-0123456789abcdef", DATABASE_URL: "pglite://memory", ENTITLEMENTS_PRIVATE_KEY: "development", ...process.env });
const db = createDatabase(new PGliteDialect(new PGlite()));
const auth = createAuth({ config, db, mailer: consoleMailer });
await migrate(auth, db);
serve({ fetch: createApp({ config, auth, db }).fetch, port: config.port }, info => console.log(`Opaya web (memory database) on http://localhost:${info.port}`));
