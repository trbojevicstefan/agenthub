import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { createApp } from "./server.js";

const config = await loadConfig();
const app = createApp({ config });
const server = serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }, info => {
  console.log(`Opaya web listens on port ${info.port} for ${config.baseURL}.`);
});
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => server.close(() => process.exit(0)));
