import { serve } from "@hono/node-server";
import { createAuth } from "./auth.js";
import { loadConfig } from "./config.js";
import { postgres } from "./db.js";
import { createSigner } from "./entitlements.js";
import { consoleMailer, resendMailer } from "./mail.js";
import { migrate } from "./migrate.js";
import { createApp } from "./server.js";

const config = await loadConfig();
const db = postgres(config.secrets.DATABASE_URL!);
const mailer = config.secrets.RESEND_API_KEY ? resendMailer({ apiKey: config.secrets.RESEND_API_KEY, from: config.emailFrom }) : consoleMailer;
const auth = createAuth({ config, db, mailer });
const changes = await migrate(auth, db);
if (changes.created.length || changes.added.length) console.log(`Database updated. New tables: ${changes.created.join(", ") || "none"}. New columns in: ${changes.added.join(", ") || "none"}.`);
const signer = await createSigner(config.secrets.ENTITLEMENTS_PRIVATE_KEY!, config.baseURL);
const app = createApp({ config, auth, db, signer });
const server = serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }, info => {
  console.log(`Opaya web listens on port ${info.port} for ${config.baseURL}.`);
});
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () =>
    server.close(() => {
      void db.destroy().finally(() => process.exit(0));
    }),
  );
