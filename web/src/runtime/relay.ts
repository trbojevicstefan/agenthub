// The web app's transport: one WebSocket per browser tab at /app/ws (ui/web-transport.js is the other end). A tab
// reaches only its own user's runtime, after the session cookie, the origin and the plan (web access) are checked, and
// it keeps its socket only while the session and the plan last. Calls are relayed from an allowlist; events from the
// runtime go to every tab of that user.
import { lstat, mkdir } from "node:fs/promises";
import type { IncomingMessage, Server } from "node:http";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { Auth } from "../auth.js";
import type { Config } from "../config.js";
import type { Database } from "../db.js";
import { entitlementsFor } from "../entitlements.js";
import type { PushService } from "../push.js";
import { desktopModule } from "./desktop.js";
import type { RuntimeManager, ServiceClient } from "./manager.js";

// The session service actions a browser may call (what desktop/main.cjs forwards), with longer time limits where the
// desktop app has them. Everything else the browser does itself, or it is desktop-only (ui/web-transport.js).
const LONG = 11 * 60 * 1000;
export const FORWARD: Record<string, number> = Object.fromEntries([
  ...["snapshot", "saveAgent", "reorderAgents", "updateAgentDisplay", "removeAgent", "saveHost", "removeHost", "discover", "connect", "disconnect", "clearError", "select", "newConversation", "selectConversation", "stop", "saveDraft", "saveView"],
  ...["terminalOpen", "terminalAttach", "terminalWrite", "terminalResize", "terminalDetach", "terminalClose", "terminalRename", "fileInfo", "selectEffort", "agentModels", "selectModel", "gateway"],
  ...["projectRemoteInfo", "projectRemoteStart", "projectRemoteSend", "projectRemoteBring", "projectRemoteApply", "projectRemoteGithubLogin", "guideScan", "guidePlan", "opayaSignIn", "toolVersions", "toolCheckAll"],
  ...["agentInstallInfo", "agentMaintenanceCommand", "agentBackup", "agentBackups", "agentRepair", "agentChannels", "agentChannelSetup", "agentSetupChoices", "agentSetupModel", "agentChannelConnect", "agentChannelPair", "agentChannelOptions"],
  ...["feedbackState", "feedbackSend", "feedbackClear", "reportClientError", "agentSkillCreate", "agentSkillRead", "agentSkillSave", "agentSkillRemove", "skillsShare", "agentMemory", "agentMemorySave", "agentMemoryNote", "agentMemoryNoteSave", "agentMemoryCopy"],
  ...["browsersList", "signInAgain", "jobCancel", "jobInput", "backupRemove", "opayaFreeModels", "opayaFreeSetup", "agentEnvKeys", "transferStart", "renameConversation", "deleteConversation", "condenseConversation", "conversationMarkdown"],
  ...["libraryList", "libraryImport", "libraryInstall", "libraryRemove", "libraryAddFolder", "jobs", "jobDismiss", "sshKeyCreate", "hostTest", "saveSettings", "projectSave", "projectRemove", "projectInfo", "projectBranches", "projectGit", "projectClone"],
  ...["mcpSave", "mcpRemove", "agentMcp", "agentSkills", "skillAction", "agentDiagnostics", "moveAgent", "connectAll", "playground", "files", "opayaSaveConfig", "opayaTest", "opayaForgetKey", "opayaSend", "opayaNewSession", "opayaSelectSession", "opayaDeleteSession", "opayaStop", "opayaClear"],
  ...["mcpCatalog", "mcpInstall", "dockerList", "dockerTerminal", "dockerStats", "dockerInspect", "dockerLogs", "opayaHoldSecret", "opayaForgetSecret", "agentGiveSecret", "opayaGiveAll", "vaultGiveAgent", "agentKeys", "vaultImportCommit", "tokenRemove", "scheduleSave", "scheduleRemove", "scheduleRun", "agentCron", "codexLoginFinish"],
].map(m => [m, 150_000]));
Object.assign(FORWARD, { syncNow: 60_000, cloneAgent: 20 * 60 * 1000, redeployAgent: 20 * 60 * 1000, agentUpdate: LONG, agentUpdateAll: LONG, agentUninstall: LONG, toolUpdate: LONG, installFramework: LONG, projectRemoteStop: LONG, guideStart: LONG, terminalRestart: LONG, terminalPaste: LONG, dockerAction: 3 * 60 * 1000, agentWeb: 3 * 60 * 1000, opayaUpdateSecret: 5 * 60 * 1000, vaultImportScan: 2 * 60 * 1000, agentFile: 130_000, agentCronDo: 150_000 });

const DOCS: Record<string, string> = { hermes: "https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server", acp: "https://hermes-agent.nousresearch.com/docs/user-guide/features/acp", profiles: "https://hermes-agent.nousresearch.com/docs/user-guide/profiles/", codex: "https://developers.openai.com/codex/app-server/", claude: "https://code.claude.com/docs/en/headless", openclaw: "https://docs.openclaw.ai/gateway/openai-http-api" };
const attachments = desktopModule<{ stage: (input: unknown, root: string) => Promise<{ input: { attachments?: { path?: string }[] }; files: string[] }>; unstage: (files: string[]) => Promise<void> }>("attachments.cjs");
const catalog = desktopModule<{ FRAMEWORKS: { id: string; docs: string }[] }>("catalog.cjs");

export interface RelayDeps {
  config: Config;
  auth: Auth;
  db: Database;
  manager: RuntimeManager;
  usersDir: string;
  push?: PushService;
  // Tests: a shorter time between session checks.
  recheckMs?: number;
}

interface Approval {
  id: string;
  kind?: string;
  agent?: { name?: string };
  title?: string;
  detail?: string;
}

// "Always allow" answers of each user (the table opaya_approval_rule). They live in Postgres, not in the user's folder:
// the runtime can write there.
const MAX_RULES = 500, MAX_RULE = 4000;
// How often open sockets are checked against their session and plan.
const RECHECK_MS = 30_000;

const snippet = (text: unknown) => String(text ?? "").replace(/[`*_#>|]/g, "").replace(/\s+/g, " ").trim().slice(0, 180) || "Open Opaya to read it.";

// All tabs of one user share the runtime connection.
class Room {
  tabs = new Set<WebSocket>();
  // Tabs in front (the browser says so): with none, what the desktop shows as OS notifications goes to Web Push.
  visible = new Set<WebSocket>();
  approvals = new Map<string, { key: string; secret: boolean; expires: number; request: Approval }>();
  rules: Set<string> | null = null;
  settings: Record<string, unknown> = {};
  opayaBusy = false;
  constructor(
    public userId: string,
    public client: ServiceClient,
    private db: Database,
    private push?: PushService,
  ) {
    for (const event of ["state", "terminal", "job", "notice", "reply"]) client.on(event, value => this.broadcast(event, value));
    // An approval that fails here is denied.
    client.on("approval", (request: Approval) =>
      void this.approval(request).catch(() => {
        if (!client.socket.destroyed) client.answer(request.id, false);
      }),
    );
    client.on("state", (state: { settings?: Record<string, unknown>; opayaAgent?: { busy?: boolean; messages?: { role: string; content?: string; error?: string }[] } }) => {
      if (state?.settings) this.settings = state.settings;
      const o = state?.opayaAgent;
      if (!o) return;
      if (this.opayaBusy && !o.busy) {
        const last = [...(o.messages ?? [])].reverse().find(m => m.role === "assistant");
        if (last) this.notify("notifyReplies", { title: last.error ? "Opaya Agent stopped with an error" : "Opaya Agent replied", body: snippet(last.error || last.content), tag: "opaya-agent" });
      }
      this.opayaBusy = Boolean(o.busy);
    });
    client.on("reply", (r: { agentId?: string; agentName?: string; status?: string; text?: string }) => {
      if (r?.agentId) this.notify("notifyReplies", { title: r.status === "error" ? `${r.agentName} stopped with an error` : `${r.agentName} replied`, body: snippet(r.text), tag: `reply-${r.agentId}` });
    });
    client.on("job", (j: { status?: string; kind?: string; title?: string; detail?: string; error?: string }) => {
      if (j?.status === "done") this.notify("notifyJobs", { title: j.kind === "clone" ? "Clone finished" : `${j.title ?? "Job"} finished`, body: snippet(j.detail || j.title), tag: "job" });
      else if (j?.status === "error") this.notify("notifyJobs", { title: `${j.title ?? "Job"} failed`, body: snippet(j.error), tag: "job" });
    });
    client.on("closed", () => {
      for (const tab of this.tabs) tab.close(4503, "The runtime stopped.");
    });
  }
  broadcast(event: string, value: unknown) {
    const line = JSON.stringify({ kind: "event", event, value });
    for (const tab of this.tabs) if (tab.readyState === 1) tab.send(line);
  }
  private async loadRules() {
    this.rules ??= new Set((await this.db.selectFrom("opaya_approval_rule").select("rule").where("user_id", "=", this.userId).execute()).map(r => r.rule as string));
    return this.rules;
  }
  // Web Push when no Opaya tab is in front, for the kinds the user's Notifications settings allow.
  private notify(setting: string, payload: { title: string; body: string; tag: string }) {
    if (!this.push || this.visible.size || this.settings[setting] === false) return;
    void this.push.notify(this.userId, payload).catch(() => {});
  }
  // An approval with no tab open waits for one when the user gets Web Push (up to the service's 10 minutes); without
  // Web Push it is denied at once, as the desktop app does with no window.
  private async approval(request: Approval) {
    const key = JSON.stringify([request.agent, request.title, request.detail]);
    if (request.kind !== "secret" && (await this.loadRules()).has(key)) return this.client.answer(request.id, true);
    if (!this.tabs.size && !(this.push && (await this.push.has(this.userId).catch(() => false)))) return this.client.answer(request.id, false);
    this.approvals.set(request.id, { key, secret: request.kind === "secret", expires: Date.now() + 10 * 60 * 1000, request });
    this.broadcast("approval", request);
    this.notify("notifyApprovals", { title: "Opaya needs your approval", body: snippet(`${request.agent?.name ?? "Agent"}: ${request.title ?? ""}`), tag: `approval-${request.id}` });
  }
  // A tab that opens gets the approvals that still wait.
  join(tab: WebSocket) {
    this.tabs.add(tab);
    for (const [, a] of this.approvals) if (Date.now() < a.expires && tab.readyState === 1) tab.send(JSON.stringify({ kind: "event", event: "approval", value: a.request }));
  }
  leave(tab: WebSocket) {
    this.tabs.delete(tab);
    this.visible.delete(tab);
  }
  presence(tab: WebSocket, visible: boolean) {
    if (visible) this.visible.add(tab);
    else this.visible.delete(tab);
  }
  async answer(x: { id?: unknown; choice?: unknown; value?: unknown }) {
    const id = String(x.id ?? ""), pending = this.approvals.get(id);
    if (!pending) return false;
    this.approvals.delete(id);
    if (Date.now() > pending.expires) return this.client.answer(id, false), false;
    // A secure prompt carries the typed value, only for this request, and never becomes a rule.
    if (pending.secret) {
      const value = x.choice === "once" && typeof x.value === "string" ? x.value : "";
      this.client.answer(id, Boolean(value), value || undefined);
      return Boolean(value);
    }
    if (x.choice === "always") {
      const rules = await this.loadRules();
      if (!rules.has(pending.key) && rules.size < MAX_RULES && pending.key.length <= MAX_RULE) {
        await this.db.insertInto("opaya_approval_rule").values({ user_id: this.userId, rule: pending.key }).onConflict(oc => oc.columns(["user_id", "rule"]).doNothing()).execute();
        rules.add(pending.key);
      }
    }
    const allow = x.choice === "once" || x.choice === "always";
    this.client.answer(id, allow);
    for (const tab of this.tabs) if (tab.readyState === 1) tab.send(JSON.stringify({ kind: "event", event: "approval-done", value: { id } }));
    return allow;
  }
}

// The folders the relay writes uploads to, made when they are missing. The runtime can change its own folder, so
// each part must be a real folder, not a link to another place.
async function realFolders(root: string, ...parts: string[]) {
  let dir = root;
  for (const part of parts) {
    dir = join(dir, part);
    await mkdir(dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    if (!(await lstat(dir)).isDirectory()) throw new Error("The files could not be sent. Try again.");
  }
}

export function attachRelay(server: Server, { config, auth, db, manager, usersDir, push, recheckMs = RECHECK_MS }: RelayDeps) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 24 * 1024 * 1024 });
  const rooms = new Map<string, Room>();
  // Each open socket's session and organization, checked again every RECHECK_MS: sign-out, a revoked session, a
  // deleted account or a plan without the web app closes it.
  const tabs = new Map<WebSocket, { sessionId: string; userId: string; organizationId: string }>();
  const recheck = setInterval(() => void checkTabs().catch(error => console.warn(`Session check failed: ${(error as Error)?.message ?? error}`)), recheckMs);
  recheck.unref();
  server.on("close", () => clearInterval(recheck));
  async function checkTabs() {
    const open = [...tabs];
    if (!open.length) return;
    const ids = [...new Set(open.map(([, tab]) => tab.sessionId))];
    const live = new Set((await db.selectFrom("session").select("id").where("id", "in", ids).where("expiresAt", ">", new Date()).execute()).map(r => r.id as string));
    const web = new Map<string, boolean>();
    for (const [ws, tab] of open) {
      if (!live.has(tab.sessionId)) {
        ws.close(4401, "The session ended. Sign in again.");
        continue;
      }
      if (!web.has(tab.organizationId)) web.set(tab.organizationId, (await entitlementsFor(db, tab.organizationId)).features.web);
      if (!web.get(tab.organizationId)) ws.close(4402, "The web app comes with Pro and Fleet.");
    }
  }
  const refuse = (socket: Duplex, status: number) => {
    socket.write(`HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Not Found"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };
  const closeWith = (req: IncomingMessage, socket: Duplex, head: Buffer, code: number, reason: string) => wss.handleUpgrade(req, socket, head, ws => ws.close(code, reason));

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    void (async () => {
      if (new URL(req.url ?? "/", "http://x").pathname !== "/app/ws") return refuse(socket, 404);
      // Only Opaya's own pages may open it (a page on another site would send its own origin).
      if (req.headers.origin !== config.baseURL) return refuse(socket, 403);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      const session = await auth.api.getSession({ headers }).catch(() => null);
      if (!session || (session.session as { client?: string }).client === "desktop") return closeWith(req, socket, head, 4401, "Sign in first.");
      const organizationId = ((session.session as { activeOrganizationId?: string }).activeOrganizationId as string) || (await auth.personalOrganization(session.user.id));
      const entitlements = await entitlementsFor(db, organizationId);
      if (!entitlements.features.web) return closeWith(req, socket, head, 4402, "The web app comes with Pro and Fleet.");
      wss.handleUpgrade(req, socket, head, ws => {
        tabs.set(ws, { sessionId: session.session.id, userId: session.user.id, organizationId });
        ws.on("close", () => tabs.delete(ws));
        void bridge(ws, { id: session.user.id, organizationId, hostLimit: entitlements.limits.hosts });
      });
    })().catch(() => refuse(socket, 403));
  });

  async function bridge(ws: WebSocket, user: { id: string; organizationId: string; hostLimit: number }) {
    let client: ServiceClient;
    try {
      client = await manager.attach(user, ws);
    } catch {
      return ws.close(4503, "The runtime did not start.");
    }
    let room = rooms.get(user.id);
    if (!room || room.client !== client) rooms.set(user.id, (room = new Room(user.id, client, db, push)));
    const current = room;
    current.join(ws);
    ws.on("close", () => {
      current.leave(ws);
      manager.detach(user.id, ws);
    });
    ws.on("message", data => void handle(current, ws, data.toString()));
    ws.send(JSON.stringify({ kind: "hello", value: await client.call("snapshot").catch(() => null) }));
  }

  async function handle(room: Room, ws: WebSocket, text: string) {
    let m: { kind?: string; id?: number; method?: string; input?: any; visible?: unknown };
    try {
      m = JSON.parse(text);
    } catch {
      return ws.close(1003, "Bad message.");
    }
    if (m.kind === "presence") return room.presence(ws, m.visible === true);
    if (m.kind !== "call" || !Number.isSafeInteger(m.id) || typeof m.method !== "string") return ws.close(1003, "Bad message.");
    const reply = (value: unknown, error?: string) => ws.readyState === 1 && ws.send(JSON.stringify({ kind: "result", id: m.id, ...(error ? { error } : { value }) }));
    try {
      const input = m.input && typeof m.input === "object" ? m.input : {};
      reply(await call(room, m.method, input));
    } catch (error) {
      reply(undefined, String((error as Error)?.message ?? "Request failed.").slice(0, 2400));
    }
  }

  async function call(room: Room, method: string, input: any) {
    if (method === "approvalAnswer") return room.answer(input);
    if (method === "openDocs") {
      const topic = String(input.topic ?? "");
      const framework = topic.startsWith("framework:") && catalog.FRAMEWORKS.find(f => `framework:${f.id}` === topic);
      if (framework) return { url: framework.docs };
      if (!Object.hasOwn(DOCS, topic)) throw new Error("Unknown documentation topic.");
      return { url: DOCS[topic] };
    }
    // Files from the browser go to the user's folder; the runtime sees that folder as /data.
    if (method === "send") {
      const dir = join(usersDir, room.userId);
      // A browser has no paths of its own: only files it sends, or files already in the user's folder.
      if (Array.isArray(input.attachments)) input.attachments = input.attachments.filter((a: { data?: unknown; path?: unknown }) => a && (a.data !== undefined || (typeof a.path === "string" && a.path.startsWith("/data/") && !a.path.includes(".."))));
      if (input.attachments?.some((a: { data?: unknown }) => a.data !== undefined)) await realFolders(dir, "attachments", "pasted");
      const staged = await attachments.stage(input, dir);
      const moved = { ...staged.input, attachments: (staged.input.attachments ?? []).map(a => (a.path?.startsWith(dir + "/") ? { ...a, path: "/data" + a.path.slice(dir.length) } : a)) };
      try {
        return await room.client.call("send", moved);
      } catch (error) {
        await attachments.unstage(staged.files);
        throw error;
      }
    }
    if (!Object.hasOwn(FORWARD, method)) throw new Error("This works in the Opaya desktop app only.");
    return room.client.call(method, input, FORWARD[method]);
  }
  return {
    wss,
    // A deleted account: its tabs close at once.
    closeUser(userId: string) {
      for (const [ws, tab] of tabs) if (tab.userId === userId) ws.close(4401, "The account was deleted.");
    },
  };
}
