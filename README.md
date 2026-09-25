# Opaya

**One place. All your agents.** [opaya.dev](https://opaya.dev)

Opaya is a local-first desktop app for your own AI agents: **Hermes, Claude Code, Codex, OpenClaw**, and any other CLI or OpenAI-compatible API. It works with agents on this computer, on your VPS machines over SSH, and in Docker containers. Chat with them, watch their terminals, give them a browser, and share skills and tools between them, all from one window. Opaya needs no hosted account, collects no telemetry and sends nothing through a third-party relay.

**Current version: 0.12.2.** See [what's new](docs/RELEASE_NOTES.md) and the [roadmap](docs/ROADMAP.md).

## Download

All builds are on this repository's [Releases](https://github.com/trbojevicstefan/agenthub/releases) page.

- **Windows 10/11 x64:** get **Opaya-…-Setup-x64.exe** from the latest `v…-build.*` release. The build is an unsigned preview, so Windows SmartScreen may ask you to confirm: choose *More info* > *Run anyway*.
- **macOS:** get the DMG from the latest `v…-mac.*` release and drag Opaya to Applications:
  - **Opaya-…-mac-arm64.dmg** for Apple Silicon (M1 and later);
  - **Opaya-…-mac-x64.dmg** for Intel Macs.

  Not sure which one? Apple menu > About This Mac: *Chip* means Apple Silicon, *Processor … Intel* means Intel. The builds are ad-hoc signed but not notarized, so the first launch needs one approval: right-click Opaya, choose **Open**, or use System Settings > Privacy & Security > **Open Anyway**.

**Updates are built in (0.10.1 and later).** Opaya checks this repository's releases and shows **Update available** in the status bar. **Update now** downloads the new version and checks it against the release's SHA-256 checksums. **Install and restart** then replaces the app in place and opens it again. On Windows the update installs silently into the same folder; on macOS the app bundle is swapped. You do not need to uninstall first.

**Coming from AgentHub?** Choose **Stop all sessions and exit** in the tray, then run the Opaya installer. Opaya reuses your AgentHub workspace (agents, chats, drafts, saved tokens).

The installed app does not need Node.js. Agent CLIs, OpenSSH and their own logins are separate. Opaya finds them on your computer, and **Install agents** can set them up for you.

## What you can do

### Chat with every agent
- Every agent gets its own chats, and each chat keeps its exact provider session.
- **Rich messages:** Markdown, tables, task lists, code blocks with Copy, and HTML/SVG preview.
- **Slash commands and skills:** type `/` in the message box to run them.
- **Models** sets an agent's default model, or overrides it for one chat only.
- **Playground** asks two agents the same question and shows the answers side by side.

### Chat history (0.11)
- **History** opens on the right. Use the clock button next to a chat, **Ctrl/Cmd+Shift+H**, or right-click an agent and choose **Chat history**.
- Chats are grouped by day, with tabs for **All / Chats / Projects / Playground**. You can search them and switch between one agent and all agents.
- **Labels:** project chats show the project name in blue, and playground chats are marked in purple.
- **Delete** any chat (regular, project or playground). Its transcript is deleted too, but the agent's own session files are left alone.
- **Condense:**
  - Reduces a long chat to its essence: goal, key points, decisions and open items.
  - Before it starts, Opaya shows a warning with an estimate of the tokens it will use.
  - If the Opaya Agent has a model API key, that model does the work. Otherwise the chat's own agent condenses it.
  - From the essence you can copy it, send it to another agent, or start a **new chat from the essence**.
- **Share:** copy a chat as Markdown, save it as a file, or **send it to another agent**.

### Projects
- The **Projects** panel (right side, **Ctrl/Cmd+Shift+P**) groups a folder with the agents that work in it. The folder can be on this computer or on an SSH machine.
- Chats started from a project run in that folder.
- The panel shows the git branch and uncommitted changes.
- Right-click a project for **git** and **GitHub CLI** actions: pull, push, commit, branches, merge and pull requests.
- You can add an existing folder or clone a repository.

### Terminals
- Integrated xterm.js terminals come with tabs, search, rename and **pop-out windows**.
- You can open a shell or the agent's native CLI.
- Terminals keep running when you close the window.
- Remote terminals use **tmux**, so they survive a dropped SSH connection.

### Opaya browser
- Links from agents open in a built-in browser pane.
- **Give Opaya browser** (right-click an agent) lets that agent open pages, read them, click and type while you watch. It works through an MCP bridge, for local ACP agents and Claude Code.

### Custom layout
- Put the terminal and the browser **side by side** with the chat or **at the bottom**, and resize them.
- The layout is remembered.

### Skills, tools and MCP servers
- **Skills** (agent header) lists an agent's skills and commands and installs Hermes skills.
- **MCP servers:** add stdio or HTTP servers once in Settings, then choose which agents use them. Opaya passes them to Hermes over ACP and to Claude Code.
- **Transfer to another agent** (right-click an agent):
  - **Skills:** all of them or only the ones you select. They work across Hermes, Claude Code, Codex and OpenClaw, local or remote.
  - **Credentials:** all or selected API keys from a Hermes `.env`. The UI shows only key names, never values.
  - **MCP servers** the agent uses, and optionally its saved gateway token.
- **Skills library:** global skills kept by Opaya.
  - Add skills from any agent or from a folder.
  - Install them to many agents at once.

### Clone and redeploy (Hermes)
- Right-click a Hermes agent and choose **Clone**. You pick:
  - **What to copy:** Everything, Skills + personality (SOUL.md, USER.md), Skills, or Memory. You can also include API keys.
  - **Where:** this computer or any saved VPS.
  - **How it runs:** as a Hermes profile or a Docker container.
- A progress window shows the route, a live percentage, speed, time left, each step and a log. You can minimize it to the status bar.
- **Redeploy** copies the same parts again with one click. Chat history and OAuth logins are never copied.

### Machines and VPS
- **Machines** lists this computer and your SSH machines, local and remote kept apart.
- **Add a new VPS:**
  1. Opaya creates an SSH key in `~/.ssh`.
  2. You add the public key in your provider's panel. If you only have a password, Opaya can install the key for you.
  3. Opaya checks the connection and whether Docker and Hermes are installed there.
- You can also import `~/.ssh/config` aliases.

### Discover and install agents
- **Discover** separates installed agents from ones you can still add, and local from remote. Agents you have already added are hidden.
- **Install agents** installs these in one click, on this computer or a VPS:
  - agents: Hermes Agent, Claude Code, Codex, OpenClaw, Gemini CLI, OpenCode, Goose, Aider or Ollama;
  - dependencies: Node.js, Python, Git, uv, tmux, OpenSSH, Homebrew, or **All essentials**.
- You see the exact vendor command first, and it runs in a terminal you can watch.

### iTrust mode
- Approves an agent's tool requests (commands, file edits and other actions) automatically.
- Turn it on for **all agents** in Settings, or **per agent** by right-clicking it.
- It also works for the **Opaya Agent**, where removals still ask.
- An **iTrust** label marks agents that have it on.

### Opaya Agent
The **Opaya Agent** at the top of the sidebar is a built-in assistant for Opaya itself:
- It installs agents, connects and repairs them, manages machines and keys, and runs diagnostics when an agent hangs.
- It keeps its own chat sessions, and offers a friendly tip now and then when something useful applies.

**Start free**: one click installs Ollama and a free open model (Qwen3 or Llama) on this computer and connects the Opaya Agent. No account, no key. If Ollama already runs with a model that can use tools, it connects by itself. Free tiers with an account are marked in Model settings: Ollama Cloud, OpenRouter `:free` models, Groq, Cerebras, Gemini and Mistral.

Or connect it to any model in **Model settings**: DeepSeek, OpenAI, Google Gemini, OpenRouter, xAI, Groq, Mistral, a local Ollama or LM Studio model, a Hermes gateway, the Codex CLI, or any OpenAI-compatible `/v1` API. The API key is stored with OS encryption.

It acts only through Opaya's own tools, and every change or command asks for your approval unless iTrust is on. It never sees API tokens or secret files, has no general shell or file access, and cannot modify the app.

### Everyday comforts
- Right-click menus everywhere: agents, workspace, terminal tabs, projects and chats.
- Groups and tags, pinning, drag to reorder, **Connect all**.
- Official agent logos, an icon library or your own icon.
- Dark and light themes.
- System notifications when an approval is waiting or a long job finishes.
- A **Connection log** for every agent.

## Persistent by design

The window is only a client. A separate local **session service** owns the agents, chats and terminals:
- Closing the window does not stop running agent turns or terminals. Reopen Opaya and it reconnects to the same process and replays the terminal output.
- **Stop all sessions and exit** in the tray (Windows) or menu bar (macOS) is the separate, confirmed way to shut everything down.

Chats, drafts, provider session IDs and view state are saved locally:
- Disk writes are atomic, and streaming output is checkpointed.
- If the workspace file gets damaged, Opaya keeps the original and can recover its last good backup.
- Interrupted work is marked. It is never silently retried.

A reboot or power loss cannot keep a local process alive, but its saved history remains. Codex, Claude Code and ACP agents resume their stored sessions where the provider supports it.

## Connections and adapters

| Agent | How Opaya talks to it |
| --- | --- |
| Hermes | ACP (local, SSH or Docker), or its OpenAI-compatible gateway with stable `X-Hermes-Session-*` headers |
| Claude Code | Streaming CLI with an exact session UUID |
| Codex | app-server JSON-RPC |
| OpenClaw | OpenAI-compatible gateway with per-conversation routing |
| Other ACP agents | Negotiated sessions, permission prompts |
| Any API | OpenAI-compatible chat (DeepSeek, OpenAI, Gemini, OpenRouter, Ollama, LM Studio and others) |
| Any other CLI | Terminal-only connection |

- **Remote agents:** gateways stay private behind a loopback-only SSH tunnel, and existing SSH keys stay on your computer.
- **Several Hermes profiles on one VPS:** add each one as its own connection.

See [compatibility](docs/COMPATIBILITY.md), [security](docs/SECURITY.md) and [architecture](docs/ARCHITECTURE.md).

## Development

- **Requirements:** Node.js 22+.
- **Commands:** `npm install`, `npm test`, `npm run check`, then `npm start`.
- **Builds:** `npm run dist:win` builds the Windows installer on Windows, and `npm run dist:mac` (Apple Silicon) and `npm run dist:mac:x64` (Intel) build the macOS app on a Mac of that type. Native dependencies must be rebuilt for the target Electron runtime.
- **Safe mode:** `npm run start:safe` turns off GPU acceleration but keeps the sandbox.
- **Light theme:** after changing colors in `ui/style.css`, run `node scripts/generate-light-theme.cjs`.

`npm test` runs offline protocol, security, persistence, clone, transfer and history tests. CI runs the following for every build and publishes the result only if they pass:
- **Windows:** CI installs the packaged app, then starts two separate UI processes against one session service. The second must find the same service, live terminal, chat and draft.
- **macOS:** CI builds natively on Apple Silicon and on Intel, and runs the same restart check on each packaged app.

Each release includes `SHA256SUMS`, which the in-app updater verifies.

CI does not test your private VPS accounts or installed provider versions. No sample agents or credentials are ever added to a real workspace.
