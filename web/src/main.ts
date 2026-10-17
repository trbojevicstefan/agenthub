import { serve } from "@hono/node-server";
import { createAuth } from "./auth.js";
import { loadConfig } from "./config.js";
import { postgres } from "./db.js";
import { createSigner } from "./entitlements.js";
import { consoleMailer, resendMailer } from "./mail.js";
import { migrate } from "./migrate.js";
import { createApp } from "./server.js";
import { RuntimeManager, launcherConnection } from "./runtime/manager.js";
import { attachRelay } from "./runtime/relay.js";
import { cloudKms, kmsSecretStore, localKeyWrapper } from "./secret-store.js";
import type { Server } from "node:http";

const config = await loadConfig();
const db = postgres(config.secrets.DATABASE_URL!);
const mailer = config.secrets.RESEND_API_KEY ? resendMailer({ apiKey: config.secrets.RESEND_API_KEY, from: config.emailFrom }) : consoleMailer;
const auth = createAuth({ config, db, mailer });
const changes = await migrate(auth, db);
if (changes.created.length || changes.added.length) console.log(`Database updated. New tables: ${changes.created.join(", ") || "none"}. New columns in: ${changes.added.join(", ") || "none"}.`);
const signer = await createSigner(config.secrets.ENTITLEMENTS_PRIVATE_KEY!, config.baseURL);
// The web app (Phase 2): runtime containers through the launcher, user secrets with Cloud KMS.
let manager: RuntimeManager | null = null, secrets: ((organizationId: string) => ReturnType<typeof kmsSecretStore>) | undefined;
if (config.runtime) {
  if (!config.runtime.kmsKey) console.warn("OPAYA_KMS_KEY is not set: user secrets use a key that lives only in this process (development only).");
  const kms = config.runtime.kmsKey ? cloudKms(config.runtime.kmsKey) : localKeyWrapper();
  secrets = organizationId => kmsSecretStore({ db, kms, organizationId });
  manager = new RuntimeManager({ usersDir: config.runtime.usersDir, launcher: launcherConnection(config.runtime.launcherDir), secrets });
  // Runtimes an older web server started have its old Vault tokens.
  await manager.stopAll().catch(error => console.warn(`Could not stop old runtimes: ${error?.message ?? error}`));
}
const app = createApp({ config, auth, db, signer, secrets });
const server = serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }, info => {
  console.log(`Opaya web listens on port ${info.port} for ${config.baseURL}.`);
});
if (manager && config.runtime) attachRelay(server as Server, { config, auth, db, manager, usersDir: config.runtime.usersDir });
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () =>
    server.close(() => {
      void (manager?.stopAll() ?? Promise.resolve())
        .catch(() => {})
        .finally(() => void db.destroy().finally(() => process.exit(0)));
    }),
  );
