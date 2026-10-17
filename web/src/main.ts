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
import { pull, purgeTombstones, push } from "./sync.js";
import { pushService } from "./push.js";
import { entitlementsFor } from "./entitlements.js";
import type { Server } from "node:http";

const config = await loadConfig();
const db = postgres(config.secrets.DATABASE_URL!);
const mailer = config.secrets.RESEND_API_KEY ? resendMailer({ apiKey: config.secrets.RESEND_API_KEY, from: config.emailFrom }) : consoleMailer;
// The web app (Phase 2), set up below: runtime containers through the launcher, user secrets with Cloud KMS.
let manager: RuntimeManager | null = null, relay: ReturnType<typeof attachRelay> | null = null, secrets: ((organizationId: string) => ReturnType<typeof kmsSecretStore>) | undefined;
const auth = createAuth({
  config,
  db,
  mailer,
  onDeleteUser: async userId => {
    relay?.closeUser(userId);
    await manager?.remove(userId);
  },
});
const changes = await migrate(auth, db);
if (changes.created.length || changes.added.length) console.log(`Database updated. New tables: ${changes.created.join(", ") || "none"}. New columns in: ${changes.added.join(", ") || "none"}.`);
const signer = await createSigner(config.secrets.ENTITLEMENTS_PRIVATE_KEY!, config.baseURL);
if (config.runtime) {
  if (!config.runtime.kmsKey) console.warn("OPAYA_KMS_KEY is not set: user secrets use a key that lives only in this process (development only).");
  const kms = config.runtime.kmsKey ? cloudKms(config.runtime.kmsKey) : localKeyWrapper();
  secrets = organizationId => kmsSecretStore({ db, kms, organizationId });
  manager = new RuntimeManager({ usersDir: config.runtime.usersDir, launcher: launcherConnection(config.runtime.launcherDir), secrets, sync: organizationId => {
    // A runtime may outlive a plan change: each sync call checks the plan again.
    const allowed = async () => {
      if (!(await entitlementsFor(db, organizationId)).features.sync) throw new Error("Sync comes with Pro and Fleet.");
    };
    return { pull: async since => (await allowed(), pull(db, organizationId, since)), push: async records => (await allowed(), push(db, organizationId, records)) };
  } });
  // Runtimes an older web server started have its old Vault tokens.
  await manager.stopAll().catch(error => console.warn(`Could not stop old runtimes: ${error?.message ?? error}`));
}
// Web Push, when the VAPID keys are in Secret Manager.
const webPush = config.runtime && config.secrets.WEB_PUSH_PUBLIC_KEY && config.secrets.WEB_PUSH_PRIVATE_KEY ? pushService({ db, publicKey: config.secrets.WEB_PUSH_PUBLIC_KEY, privateKey: config.secrets.WEB_PUSH_PRIVATE_KEY, subject: process.env.OPAYA_PUSH_SUBJECT || undefined }) : undefined;
const app = createApp({ config, auth, db, signer, secrets, push: webPush });
// Old sync tombstones go once a day (SYNC_PLAN.md).
setInterval(() => void purgeTombstones(db).catch(error => console.warn(`Tombstone purge failed: ${error?.message ?? error}`)), 24 * 60 * 60 * 1000).unref();
const server = serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }, info => {
  console.log(`Opaya web listens on port ${info.port} for ${config.baseURL}.`);
});
if (manager && config.runtime) relay = attachRelay(server as Server, { config, auth, db, manager, usersDir: config.runtime.usersDir, push: webPush });
// One failed background task must not stop the server for all users.
process.on("unhandledRejection", error => console.error(`Unhandled error: ${(error as Error)?.stack ?? error}`));
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () =>
    server.close(() => {
      void (manager?.stopAll() ?? Promise.resolve())
        .catch(() => {})
        .finally(() => void db.destroy().finally(() => process.exit(0)));
    }),
  );
