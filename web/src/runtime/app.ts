// /app: the desktop app's own interface (ui/), served to the browser with ui/web-transport.js in place of the Electron
// preload. The files are public; the WebSocket (relay.ts) checks the session and the plan.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";
import type { AppDeps, Env } from "../server.js";
import { entitlementsFor } from "../entitlements.js";

const require = createRequire(import.meta.url);
const UI = fileURLToPath(new URL("../../../ui/", import.meta.url));
const pkg = (name: string) => dirname(require.resolve(`${name}/package.json`));
const TYPES: Record<string, string> = { js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", html: "text/html; charset=utf-8", png: "image/png", svg: "image/svg+xml" };

// The same files as the agenthub:// protocol of the desktop window (desktop/main.cjs).
function files() {
  const xterm = (name: string, file: string) => join(pkg(`@xterm/${name}`), file);
  const three = dirname(require.resolve("three"));
  return new Map<string, string>([
    ["app.js", join(UI, "app.js")],
    ["web-transport.js", join(UI, "web-transport.js")],
    ["sw.js", join(UI, "web-sw.js")],
    ["terminal-window.js", join(UI, "terminal-window.js")],
    ["style.css", join(UI, "style.css")],
    ["theme-light.css", join(UI, "theme-light.css")],
    ["stage3d.js", join(UI, "stage3d.js")],
    ["markdown.js", join(UI, "markdown.js")],
    ["terminal-layout.js", join(UI, "terminal-layout.js")],
    ["terminal-core.js", join(UI, "terminal-core.js")],
    ["assets/opaya-logo.png", join(UI, "assets/opaya-logo.png")],
    ["assets/agents/hermes.png", join(UI, "assets/agents/hermes.png")],
    ["assets/agents/claude.png", join(UI, "assets/agents/claude.png")],
    ["assets/agents/codex.svg", join(UI, "assets/agents/codex.svg")],
    ["assets/agents/openclaw.svg", join(UI, "assets/agents/openclaw.svg")],
    ["vendor/xterm.js", xterm("xterm", "lib/xterm.js")],
    ["vendor/xterm.css", xterm("xterm", "css/xterm.css")],
    ["vendor/addon-fit.js", xterm("addon-fit", "lib/addon-fit.js")],
    ["vendor/addon-unicode11.js", xterm("addon-unicode11", "lib/addon-unicode11.js")],
    ["vendor/addon-webgl.js", xterm("addon-webgl", "lib/addon-webgl.js")],
    ["vendor/addon-search.js", xterm("addon-search", "lib/addon-search.js")],
    ["vendor/addon-web-links.js", xterm("addon-web-links", "lib/addon-web-links.js")],
    ["vendor/three.module.js", join(three, "three.module.js")],
    ["vendor/three.core.js", join(three, "three.core.js")],
  ]);
}

// The page's own files only. Styles may be inline (the interface sets some); connections go to this origin (the
// WebSocket); images may come from agents' web pages, as in the desktop window.
export const APP_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const withTransport = (html: string, before: string) => html.replace(`<script defer src="${before}"></script>`, `<script defer src="web-transport.js"></script><script defer src="${before}"></script>`);

export function appRoutes(app: Hono<Env>, { db, auth }: AppDeps) {
  const map = files();
  const cache = new Map<string, Promise<Buffer>>();
  const read = (file: string) => {
    let p = cache.get(file);
    if (!p) cache.set(file, (p = readFile(file)));
    return p;
  };
  app.get("/app", c => c.redirect("/app/"));
  // The interface needs a session and a plan with the web app.
  app.get("/app/", async c => {
    const session = c.get("session");
    if (!session) return c.redirect(`/login?next=${encodeURIComponent("/app/")}`);
    const organizationId = (session.session.activeOrganizationId as string) || (await auth.personalOrganization(session.user.id));
    if (!(await entitlementsFor(db, organizationId)).features.web) return c.redirect("/pricing?web=1");
    const html = withTransport((await read(join(UI, "index.html"))).toString("utf8"), "app.js");
    return c.html(html, 200, { "content-security-policy": APP_CSP, "cache-control": "no-store" });
  });
  app.get("/app/terminal.html", async c => {
    const html = withTransport((await read(join(UI, "terminal.html"))).toString("utf8"), "terminal-window.js");
    return c.html(html, 200, { "content-security-policy": APP_CSP, "cache-control": "no-store" });
  });
  app.get("/app/*", async c => {
    const rel = c.req.path.slice("/app/".length);
    const icon = /^assets\/icons\/[a-z0-9-]{1,40}\.svg$/.test(rel) ? join(UI, rel) : null;
    const file = map.get(rel) ?? icon;
    if (!file) return c.notFound();
    try {
      return c.body(new Uint8Array(await read(file)), 200, { "content-type": TYPES[file.split(".").pop() ?? ""] ?? "application/octet-stream", "x-content-type-options": "nosniff", "cache-control": "public, max-age=300" });
    } catch {
      cache.delete(file);
      return c.notFound();
    }
  });
}
