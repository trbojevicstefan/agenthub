# Opaya

**One place. All your agents.** [opaya.dev](https://opaya.dev)

Opaya is a local-first desktop app for your own AI agents: **Hermes, Claude Code, Codex, OpenClaw**, and any other CLI or OpenAI-compatible API. It works with agents on this computer, on your VPS machines over SSH, and in Docker containers. Chat with them, watch their terminals, give them a browser, and share skills and tools between them, all from one window. Opaya needs no hosted account, collects no telemetry and sends nothing through a third-party relay.

**Current version: 0.31.3.** See [what's new](docs/RELEASE_NOTES.md) and the [roadmap](docs/ROADMAP.md).

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

### The Opaya browser for every agent, cookies, files in chat, schedules (0.31)
- **The Opaya browser is on by default** for every agent that can use it, now including **Codex** and **Hermes on your machines or in Docker** (through a relay over Opaya's own SSH or docker exec channel). Each agent has its own tab and cookies; close one with ✕ or `browser_close`.
- **Import cookies from Chrome and Edge** (or a cookies.txt / JSON export) into your tab or agents' tabs.
- **Files agents mention by full path** show in chat with Open, Save and Show in folder.
- **Schedules**: send a message to any agent on a schedule, and see the agents' own cron jobs.
- Terminals stay on the screen they belong to; every question is an Opaya dialog; unread counts clear when you open the agent.

### Keys agents can read, DeepSeek V4.1 Flash, the browser for every agent, Vault backups (0.30)
- **Keys given to agents in Docker stay readable** by the agent's own user (Hermes runs as `hermes`).
- **DeepSeek V4.1 Flash** (`deepseek-flash`) is known to see images and is in the model lists; the Model dialog takes any model name.
- **Every model can use the Opaya browser**: pages come back as text with links and form fields; models that see images also get screenshots. Hermes and other ACP agents, Claude Code and Codex on this computer, in the chat that is open.
- **Back up & restore the Vault**: one file encrypted with your password, to restore here or on a new computer.

### Manage on one page, Settings by topic (0.29)
- **Manage is one page.** Everything about an agent, from its model to its Danger zone, is on one page. The agent's sidebar is the table of contents: a click (or the section's letter) scrolls there, and the section you are reading is marked in the sidebar and the top bar. The facts at the top (version, keys, last backup) open their section too.
- **Machines, clearer.** Pick a machine and its panel opens right under it: system, memory, disk and address, Terminal, Files and Install agents, its tools, and its Docker with every container side by side. Test all and Update all are in the ⋯ menu.
- **Settings by topic.** A page per topic on the left (Appearance, Chat & Terminal, Notifications & startup, Agents, Keys & skills, Machines & data, Shortcuts, Updates & about) and a filter that searches all of them.
- **Dialogs close when you click beside them**, like Esc. If you typed something in one, it stays open so nothing is lost.
- Switches in Settings no longer scroll the dialog away.

### Chat, Terminal and Manage, easy to find (0.28)
- **Three places for every agent** at the top of its screen: **Chat** (talk to it), **Terminal** (its own CLI and a shell) and **Manage** (settings and maintenance). The one you use is highlighted, and in Manage the section you are in is shown next to it. Opaya remembers where you were for each agent.
- **Split terminals any way:** the split button in a window's title bar opens a new terminal **right, below, left or above** it. Each window can be maximized, hidden or opened in its own window. Ctrl/Cmd+Shift+Arrow moves between windows; the layout is kept per agent.
- **Manage at a glance:** the Overview starts with big buttons for **Update**, **Clone**, **Back up**, **Settings** and **Machines**. When one cannot be used, it says why.
- **A clear first launch:** with no agents yet, Home shows three ways to start: **Find agents on this computer** (recommended), **Install an agent** or **Chat with the Opaya Agent**, plus adding a connection or a server and importing keys.
- **Fix it from the chat:** when an agent cannot connect, the message offers **Let the Opaya Agent fix it** and **Try again**, with links to edit the connection or open its terminal.
- **What's new** shows after each update (and from Search), with a button to the map of the app in Help.

### Everything in its place (0.27)
- **Find anything:** **Search** at the top of every screen, or **Ctrl/Cmd+K**, finds your agents, every agent's Manage sections and actions (Back up, Update, Clone, API keys...), places (Vault, Docker manager, Install agents...), settings, machines, chats and vault keys. Each result shows **where it lives**, for example *Hermes › Keys & tools* or *Settings › Theme*, so you also learn where to find it next time. Without an agent's name, actions are the selected agent's; type a name ("codex keys") to pick another.
- **Back:** the arrow at the top left, **Alt+Left** or your mouse's back button returns to the previous screen.
- **Three areas in the sidebar:** the Opaya Agent at the top, your agents in the middle, and under **Workspace** the shared things: Playground, Machines, Vault, **Skills & tools**, Settings and Help.
- **The Library:** Keys (the Vault), Skills (the skills library) and MCP servers share one tab bar: everything shared by all your agents.
- **Right-click mirrors the sidebar:** an agent's menu has its quick actions, then one submenu per Manage section with the same items in the same order.
- **One Machines screen:** every Machines entry opens the Machines board; **Add existing** adds a server by its address or from `~/.ssh/config`.
- **Settings** opens with chips for every section and a filter, and stays where you are when you change an option.

### The Opaya Vault: your keys in one place (0.26)
**Vault** in the sidebar (key icon) keeps your API keys, tokens and passwords, encrypted by your OS, and gives each one to the agents that need it. Values are never shown or sent into a chat.
- **Import keys** you already have: from a **.env, JSON, YAML or any text file** (choose it, or drop it on the Vault), from **pasted text**, or **from your tools**: every agent's own key file, your shell profiles, the environment Opaya started with, the GitHub CLI, npm, AWS and Hugging Face. Opaya lists what it found by name and a masked preview; you tick what to keep and can rename each key. Keys already in the Vault, and the same key found in two places, are marked.
- **Every key shows who has it.** **Give to...** opens your agents right under the key (the ones that have it say *Has it*) and **Every agent**. Opaya writes the key where each agent reads keys and tells the agent its name, never the value.
- **+ Add key** can keep a key, give it to chosen agents or to every agent.
- An MCP server that needs a key (GitHub, Brave Search, Context7) can take it straight from the Vault.
- On an agent's **Keys & tools**, drag a key from the Vault onto an agent, or click it; keys the agent has are marked.

### Docker manager (0.26)
**Docker manager** (Home, Machines, or **Open manager** in an agent's Machine & Docker) has a tab per machine, search, **All / Running / Stopped** and **Live** CPU and memory. Each container is a card with its state, ports (a port on this computer opens in your browser), CPU, memory, network and processes, the agents in it, and buttons for **Start / Stop**, **Restart**, **Pause / Resume**, **Logs** (its last 200 lines inside the card, or follow them in a terminal), **Shell**, **Details** and **Remove**. **Images** show their size and which containers use each, with Pull, Remove and Prune.

### Every agent has its own sidebar (0.24)
Selecting an agent opens its **chat** and, next to your agents, **the agent's own sidebar**: its status with a power button, **Chat**, **Terminal** and **Overview**, its recent chats (+ for a new one, **Search chats** for History), and its **Manage** sections, from general to specific:
- **Model & skills**: model, reasoning, skills and commands, Share skills with another agent, skills library.
- **Keys & tools**: API keys by name, the Opaya Vault, MCP servers, Share with another agent, gateway, iTrust and the Opaya browser.
- **Machine & Docker**: where it runs, files, its CLI and shell, installed tools, its container and Docker.
- **Deploy & clone**: Clone, Dockerize, Redeploy, New VPS, and targets to drag it onto.
- **Projects**: its folders with git.
- **Updates & backups**: Update, Back up, saved backups, Check & fix, Connection log.
- **Profile & connection**: name, icon, group, pin, Reconnect, Connection settings, launch command and ID.
- **Danger zone**: Uninstall, Remove connection.

The **Opaya Agent** has its own sidebar too (chat, setup guide, its chats, model, iTrust, vault and tools). **Ctrl/Cmd+1 to 9** open agents in sidebar order; hold Ctrl/Cmd to see their numbers. Your agents' sidebar shows names or only icons as a slim strip: switch it with the « / » button at its bottom or in Settings > Sidebar. Either way the selected agent flows into its own sidebar.

**Manage is one page** with every section of the agent, one after another. The agent's sidebar is its table of contents: click a section, or press Q W E R A S D F on Manage, to scroll there, and the section you are reading is marked as you scroll; Esc goes back to the top. Each section is a set of cards: a setting, its value and one action. Terminal opens the agent's terminal windows next to or below the chat unless Settings > Chat and Terminal says full screen.
- **The stage:** a live 3D view of the agent and what it is connected to (its machine, container, keys, projects, skills and chats). It glows when the agent is connected and pulses while it works.
- **Deploy & clone:** one card per machine with **Install** and **Docker**: drag the agent onto either, or click it. Progress shows there. **Clones** lists the agent it was cloned from and its own copies, each with **Redeploy**.
- **Docker:** the containers on the agent's machine, its own container first, as Docker manager cards: live CPU and memory, **Logs** inside the card, **Shell**, **Restart**, **Pause / Resume**, **Stop / Start**, **Details** (image, mounts, ports, restart policy and health; environment variables by name only) and **Remove**. Pull a newer image and prune unused ones. **Dockerize** runs a copy of an agent in its own container.
- **Keys & access:** drag a key from the Opaya Vault onto any agent, on this screen or in the sidebar, to give it that key. Click a key for the same thing without dragging.
- **Projects & git:** pull, commit and push, or start a chat in a project, from the screen.
- Every other action is here too: model and effort, skills and tools, files, update, back up, connection (restart, copy ID or launch command), name and look, and removal.

### The fleet (0.23)
- **Machines** in the sidebar opens **the fleet board**. It shows every machine as a column with its agents, its status, OS, memory and disk, and its Docker.
  - Drag an agent onto another machine: **Clone to**, **Clone into Docker on**, **Migrate to** or **Migrate into Docker on** it. A migration is a clone; when the copy is ready, Opaya offers to uninstall the original, remove only its connection, or keep both.
  - Drop an agent on another agent to **share** its skills, API keys and MCP servers with it.
  - Each agent's ⋯ menu has Clone to, Migrate to and Share with, plus update, back up, uninstall and remove. Each machine's ⋯ menu tests it, opens its terminal, files, Discover, Install agents and Docker, connects or updates all its agents, and edits or removes it.
  - Click a machine for its details: installed tools and versions, and its Docker.
- The sidebar toggle is at the bottom of the sidebar (**Hide sidebar**, Ctrl/Cmd+B). While the sidebar is hidden, a small button at the top left brings it back.

### Chats in the background and terminal windows (0.24)
- **Chat** always opens the full chat view. **Another agent's chat** can open as a window: a column beside the page that covers nothing (right-click the agent > Open chat window).
- **The tray** in the status bar holds chats in the background: minimize a chat window, or leave a chat while its agent still works, and it waits there with a spinner while the agent works and a count of new replies (also shown on the agent in the sidebar). Click it to open it beside the page.
- **Terminal windows, no tabs:** every session is a window with its own title bar (hide, separate window, end). Arrange them **side by side, stacked or in a grid**, below the chat or beside it, and drag the gaps to resize. Windows belong to the agent you opened them from; hidden ones keep running and come back from the agent's Terminal menu or the toolbar.
- **Chat and terminal together:** shell code in a reply has **Run**, which pastes the command into the agent's shell window (Enter runs it); right-click text in a terminal > **Ask the agent about this** puts it in the chat box as a quote.

### Chat with every agent
- Every agent gets its own chats, and each chat keeps its exact provider session.
- **Rich messages:** Markdown, tables, task lists, code blocks with Copy, and HTML/SVG preview.
- **Slash commands and skills:** type `/` in the message box to run them.
- **Under the message box:** the model and the reasoning effort for this chat (or make them the agent's default), and a paperclip to attach files. You can also paste or drop files: text files go into the message, images go to models that can see them, and other files reach the agent by path (copied first to a machine or container).
- **Playground** asks two agents the same question and shows the answers side by side.

### Chat history (0.11)
- **History** opens on the right. Use **Search chats** in the agent's sidebar, the clock button next to a chat, **Ctrl/Cmd+Shift+H**, or right-click an agent and choose **Chat history**.
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
- Integrated xterm.js terminals: every session is a window, with search, rename and **pop-out windows**.
- You can open a shell or the agent's native CLI. The switch at the top left, above the Opaya Agent, opens the selected agent as a chat or in its terminal.
- **Paste** text, screenshots (as the path of a saved PNG) and files copied in Finder or Explorer (as quoted paths). On an SSH machine or in a container the files are copied there first.
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
- **MCP servers:** add the Opaya browser, GitHub, Context7, Playwright, Files, Fetch, Memory, Brave Search and more with one click (or any stdio or HTTP server by hand), then choose which agents use them. Opaya passes them to Hermes and other ACP agents per session, and writes them into the config of Claude Code, Codex and OpenClaw after you approve.
- **Share with another agent** (right-click an agent, or Keys & tools):
  - **Skills:** all of them or only the ones you select. They work across Hermes, Claude Code, Codex and OpenClaw, local or remote.
  - **Credentials:** all or selected API keys, between any agents: each key goes where the other agent reads it (.env, Claude Code settings, Codex sign-in, OpenCode, an API connection's token). The UI shows only key names, never values.
  - **MCP servers** the agent uses, and optionally its saved gateway token.
- **Skills library:** global skills kept by Opaya.
  - Add skills from any agent or from a folder.
  - Install them to many agents at once.

### Clone and redeploy (Hermes)
- Open the agent's **Deploy & clone** (R) and drag it onto a machine, or right-click it and choose **Clone**. You pick, from general to specific (a line under the choices says what will happen):
  - **Where:** this computer or any saved VPS.
  - **How it runs:** as a Hermes profile, a Docker container, or a profile in a Docker container you already have (Hermes as a profile, OpenClaw as another agent of the same gateway, Claude Code, Codex or OpenCode with their own home).
  - **What to copy:** Everything, Skills + personality (SOUL.md, USER.md), Skills, or Memory. You can also include API keys.
- A progress window shows the route, a live percentage, speed, time left, each step and a log. You can minimize it to the status bar.
- **Redeploy** copies the same parts again with one click. Chat history and OAuth logins are never copied.

### Machines and VPS
- **Machines** (the board) shows this computer and your SSH machines, each with its agents, status and Docker. It is the one place for machines.
- **Add a new VPS:**
  1. Opaya creates an SSH key in `~/.ssh`.
  2. You add the public key in your provider's panel. If you only have a password, Opaya can install the key for you.
  3. Opaya checks the connection and shows the system, uptime, free disk and memory, and the tools installed there (Docker, Hermes, OpenClaw, Claude Code, Codex, Node.js, Python, Git, tmux).
- Each machine's ⋯ menu tests it, opens its terminal, files, Discover, Install agents and its Docker manager, connects or updates its agents, copies its SSH command, and edits or removes it. **Test all** checks every server; click a machine for its installed tools and versions.
- **Add existing** adds a server you already use by its SSH address, or imports your `~/.ssh/config` aliases (nothing is contacted).

### Discover and install agents
- **Discover** separates installed agents from ones you can still add, and local from remote. Agents you have already added are hidden.
- **Install agents** installs these in one click, on this computer or a VPS:
  - agents: Hermes Agent, Claude Code, Codex, OpenClaw, OpenCode, Goose, Aider or Ollama;
  - dependencies: Node.js, Python, Git, uv, tmux, OpenSSH, Homebrew, or **All essentials**.
- You see the exact vendor command first, and it runs in a terminal you can watch.
- **Updates** use the way each tool was installed (Homebrew, npm under nvm, fnm or volta, npx, pnpm, bun, the vendor's updater, uv, pipx, winget, scoop or choco). Tick several and update them together; whatever fails, the Opaya Agent finishes.

### iTrust mode
- Approves an agent's tool requests (commands, file edits and other actions) automatically.
- Turn it on for **all agents** in Settings, or **per agent** by right-clicking it.
- It also works for the **Opaya Agent**, where removals still ask.
- An **iTrust** label marks agents that have it on.

### Opaya Agent
The **Opaya Agent** is the button at the top of the sidebar, next to **Discover agents**. It is a built-in assistant for Opaya itself:
- It installs agents, connects and repairs them, manages machines and keys, and runs diagnostics when an agent hangs.
- It keeps its own chat sessions, and offers a friendly tip now and then when something useful applies.
- **Give it keys:** paste an API key, token or password into its chat, use the key button next to its message box, or type it into the secure prompt it opens. The value goes straight into Opaya's encrypted vault and the model only gets a reference such as `[secret S1 · OPENAI_API_KEY · sk-p…9f3a]`. It then saves the key where each agent reads it: the `.env` of Hermes or OpenClaw, Claude Code's settings, `codex login`, or an API connection's token, or types it into a password prompt in a terminal.

**Start free**: one click installs Ollama and a free open model (Qwen3 or Llama) on this computer and connects the Opaya Agent. No account, no key. If Ollama already runs with a model that can use tools, it connects by itself. Free tiers with an account are marked in Model settings: Ollama Cloud, OpenRouter `:free` models, Groq, Cerebras, Gemini and Mistral.

Or connect it to any model in **Model settings**: DeepSeek, OpenAI, Google Gemini, OpenRouter, xAI, Groq, Mistral, a local Ollama or LM Studio model, a Hermes gateway, the Codex CLI, or any OpenAI-compatible `/v1` API. The API key is stored with OS encryption.

It acts only through Opaya's own tools and terminals you can watch, and every change or command asks for your approval unless iTrust is on (removals always ask). Opaya's tools never show it the values of API keys, tokens or secret files, and it cannot modify the app.

### Everyday comforts
- Right-click menus everywhere: agents, workspace, terminal windows, projects and chats.
- Groups and tags, pinning, drag to reorder, **Connect all**.
- Official agent logos, an icon library or your own icon.
- Dark and light themes.
- System notifications while Opaya is not in front: an agent or the Opaya Agent replied, an approval is waiting or a long job finished. Click one to open that chat. Each kind can be turned off in Settings.
- **Home** filters agents by status and place, and each card has Manage, Connect, Terminal and Fix.
- **The top bar is the same on every screen:** the agent and the page on the left, that page's own controls, then the browser and projects. Switch agents in the sidebar.
- **Sidebar:** Discover next to the Opaya Agent, Home, your agents, and at the bottom Playground, Machines (the fleet board), Vault, Settings and Help. **Settings > Sidebar** hides the items you do not use.
- **Help** opens with **Where is what**: a map of the app (your agents, the Manage sections and their keys, API keys, skills, clone and deploy, Docker, machines and the Opaya Agent), each with a button to open it.
- Hide or show the sidebar with the button at the top left or **Cmd/Ctrl+B**.
- **Files:** mention a file or folder in the chat or in a terminal on the same machine.
- **Settings:** theme, Enter or Ctrl/Cmd+Enter to send, terminal text size and position, start Opaya when you sign in, connect agents at start, notifications, tips and keyboard shortcuts.
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
