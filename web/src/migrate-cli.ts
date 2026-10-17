// npm run migrate: update the tables without starting the server.
import { createAuth } from "./auth.js";
import { loadConfig } from "./config.js";
import { postgres } from "./db.js";
import { consoleMailer } from "./mail.js";
import { migrate } from "./migrate.js";

const config = await loadConfig();
const db = postgres(config.secrets.DATABASE_URL!);
const changes = await migrate(createAuth({ config, db, mailer: consoleMailer }), db);
console.log(`New tables: ${changes.created.join(", ") || "none"}. New columns in: ${changes.added.join(", ") || "none"}.`);
await db.destroy();
