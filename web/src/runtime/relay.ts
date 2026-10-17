// The web app's transport: one WebSocket per browser tab at /app/ws (ui/web-transport.js is the other end). A tab
// reaches only its own user's runtime, after the session cookie, the origin and the plan (web access) are checked.
// Calls are relayed from an allowlist; events from the runtime go to every tab of that user.
import { readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage, Server } from "node:http";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { Auth } from "../auth.js";
import type { Config } from "../config.js";
import type { Database } from "../db.js";
import { entitlementsFor } from "../entitlements.js";
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
}

interface Approval {
  id: string;
  kind?: string;
  agent?: { name?: string };
  title?: string;
  detail?: string;
}

// All tabs of one user share the runtime connection.
class Room {
  tabs = new Set<WebSocket>();
  approvals = new Map<string, { key: string; secret: boolean; expires: number }>();
  rules: Set<string> | null = null;
  constructor(
    public userId: string,
    public client: ServiceClient,
    private dir: string,
  ) {
    for (const event of ["state", "terminal", "job", "notice", "reply"]) client.on(event, value => this.broadcast(event, value));
    client.on("approval", (request: Approval) => void this.approval(request));
    client.on("closed", () => {
      for (const tab of this.tabs) tab.close(4503, "The runtime stopped.");
    });
  }
  broadcast(event: string, value: unknown) {
    const line = JSON.stringify({ kind: "event", event, value });
    for (const tab of this.tabs) if (tab.readyState === 1) tab.send(line);
  }
  private async loadRules() {
    this.rules ??= new Set(await readFile(join(this.dir, "approval-rules.json"), "utf8").then(t => JSON.parse(t) as string[], () => []));
    return this.rules;
  }
  // An approval with no tab open is denied at once, as the desktop app does with no window.
  private async approval(request: Approval) {
    const key = JSON.stringify([request.agent, request.title, request.detail]);
    if (!this.tabs.size) return this.client.answer(request.id, false);
    if (request.kind !== "secret" && (await this.loadRules()).has(key)) return this.client.answer(request.id, true);
    this.approvals.set(request.id, { key, secret: request.kind === "secret", expires: Date.now() + 10 * 60 * 1000 });
    this.broadcast("approval", request);
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
      rules.add(pending.key);
      await writeFile(join(this.dir, "approval-rules.json"), JSON.stringify([...rules]), { mode: 0o600 });
    }
    const allow = x.choice === "once" || x.choice === "always";
    this.client.answer(id, allow);
    for (const tab of this.tabs) if (tab.readyState === 1) tab.send(JSON.stringify({ kind: "event", event: "approval-done", value: { id } }));
    return allow;
  }
}

export function attachRelay(server: Server, { config, auth, db, manager, usersDir }: RelayDeps) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 24 * 1024 * 1024 });
  const rooms = new Map<string, Room>();
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
      wss.handleUpgrade(req, socket, head, ws => void bridge(ws, { id: session.user.id, organizationId, hostLimit: entitlements.limits.hosts }));
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
    if (!room || room.client !== client) rooms.set(user.id, (room = new Room(user.id, client, join(usersDir, user.id))));
    const current = room;
    current.tabs.add(ws);
    ws.on("close", () => {
      current.tabs.delete(ws);
      manager.detach(user.id, ws);
    });
    ws.on("message", data => void handle(current, ws, data.toString()));
    ws.send(JSON.stringify({ kind: "hello", value: await client.call("snapshot").catch(() => null) }));
  }

  async function handle(room: Room, ws: WebSocket, text: string) {
    let m: { kind?: string; id?: number; method?: string; input?: any };
    try {
      m = JSON.parse(text);
    } catch {
      return ws.close(1003, "Bad message.");
    }
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
  return wss;
}
