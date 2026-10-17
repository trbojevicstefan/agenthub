import { Hono } from "hono";
import type { Config } from "./config.js";

export interface AppDeps {
  config: Config;
}

export function createApp({ config }: AppDeps) {
  const app = new Hono();
  app.get("/api/health", c => c.json({ ok: true, production: config.production }));
  return app;
}
