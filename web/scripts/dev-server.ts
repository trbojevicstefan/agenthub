// A development server with Postgres in memory (PGlite): no database to install. Data is lost when it stops.
//   npm run dev:memory --workspace web
// Emails are printed in this terminal. Set STRIPE_SECRET_KEY (test mode) and STRIPE_WEBHOOK_SECRET from `stripe listen`
// to try checkout.
// The web app: set OPAYA_USERS_DIR to a short folder (for example /tmp/opaya-users). Runtimes then run as local
// processes (runtime/process-launcher.ts), with no isolation. DEV_PLAN=pro gives every new account a Pro trial, so
// /app opens without Stripe.
import { serve } from "@hono/node-server";
import { PGlite } from "@electric-sql/pglite";
import { PGliteDialect } from "kysely-pglite-dialect";
import { createAuth } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/db.js";
import { createSigner, newKey } from "../src/entitlements.js";
import { consoleMailer } from "../src/mail.js";
import { migrate } from "../src/migrate.js";
import { createApp } from "../src/server.js";
import type { Server } from "node:http";
import { RuntimeManager } from "../src/runtime/manager.js";
import { processLauncher } from "../src/runtime/process-launcher.js";
import { attachRelay } from "../src/runtime/relay.js";
import { kmsSecretStore, localKeyWrapper } from "../src/secret-store.js";

const config = await loadConfig({ BETTER_AUTH_SECRET: "development-only-secret-0123456789abcdef", DATABASE_URL: "pglite://memory", ENTITLEMENTS_PRIVATE_KEY: JSON.stringify(await newKey("development")), ...process.env });
const db = createDatabase(new PGliteDialect(new PGlite()));
const auth = createAuth({ config, db, mailer: consoleMailer });
await migrate(auth, db);
const signer = await createSigner(config.secrets.ENTITLEMENTS_PRIVATE_KEY!, config.baseURL);
const server = serve({ fetch: createApp({ config, auth, db, signer }).fetch, port: config.port }, info => console.log(`Opaya web (memory database) on http://localhost:${info.port}`)) as Server;
if (config.runtime) {
  const kms = localKeyWrapper(), { launcher } = processLauncher(config.runtime.usersDir, { log: true });
  const manager = new RuntimeManager({ usersDir: config.runtime.usersDir, launcher: async () => launcher, secrets: organizationId => kmsSecretStore({ db, kms, organizationId }) });
  attachRelay(server, { config, auth, db, manager, usersDir: config.runtime.usersDir });
  console.log(`Web app runtimes run as local processes in ${config.runtime.usersDir}.`);
}
if (process.env.DEV_PLAN === "pro")
  setInterval(async () => {
    for (const org of await db.selectFrom("organization").select("id").where(eb => eb.not(eb.exists(eb.selectFrom("subscription").select("id").whereRef("subscription.referenceId", "=", "organization.id")))).execute())
      await db.insertInto("subscription").values({ id: `dev_${org.id}`, plan: "pro", referenceId: org.id, status: "trialing", trialStart: new Date(), trialEnd: new Date(Date.now() + 14 * 86400_000), periodEnd: new Date(Date.now() + 14 * 86400_000), cancelAtPeriodEnd: false }).execute();
  }, 1000).unref();
