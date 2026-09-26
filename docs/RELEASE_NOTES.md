# Opaya 0.18.0 - A setup guide for people who have never coded

- **Setup guide**: on a fresh install, Opaya opens a guide in the Opaya Agent screen. It needs no AI model: it is a scripted conversation where you pick, and Opaya does the work in a terminal you can watch. Open it any time from the Opaya Agent screen (**Setup guide**).
  - It looks at the computer first (Mac, Windows or Linux, memory, what is already installed) and never installs something twice.
  - **Which of these do you have?** ChatGPT, Claude, an API key (OpenAI, Anthropic, Google, DeepSeek, Groq, OpenRouter, Mistral, xAI, Cerebras, Ollama Cloud or any compatible service), or nothing yet: then a free model on this computer, a free key from Google, or the tools now and AI later.
  - **What would you like to make?** Websites and web apps, Python and automation, just AI agents, or everything; plus optional agents (Codex CLI, Claude Code, Gemini CLI, OpenCode).
  - **The AI comes first**: with ChatGPT or Claude, Opaya installs Codex CLI or Claude Code (with Node.js or Git first where needed), opens the sign-in, waits until you are signed in, and connects it as the Opaya Agent's brain. The Opaya Agent then installs the rest, checks versions and fixes what went wrong. You approve the plan once; you can let it install the rest without asking each time.
  - Without an AI, the guide installs everything itself and adds your agents to Opaya.
  - When a terminal asks for your computer password or a question, the guide says so in plain words. A failed step is retried once; then you can try again, ask the Opaya Agent to fix it, or continue without AI.
- **Claude Code can be the Opaya Agent's brain** (Model settings > Claude Code), next to Codex CLI and API models. It gets only the Opaya Agent's tools; its own shell, editing and web tools are off, and every change still asks you first.
- **Anthropic API keys** work for the Opaya Agent. A wrong key now says so plainly, and services without a model list still connect.
- **Node.js without Homebrew**: on a Mac without Homebrew (and Linux without apt or dnf), Node.js is installed with nvm, with no administrator password.
- **Checked on every platform**: every install, update, uninstall and sign-in command is checked against the shell it runs in (sh and bash on macOS and Linux, PowerShell's own parser on Windows) with each build.

# Opaya 0.17.0 - Share a project with the agents on your servers, one agent at a time

- **One project, no duplicates**: sharing no longer creates a second `<name> on <machine>` project. Remote agents join your local project next to your local ones, marked with ⇆, and their chats live in the same project.
- **See which agents are on each server, then share with the ones you pick**: Projects > your project > **+ Agent** lists the agents on this computer (they work in your folder directly) and, for every machine, the agents that exist there. Each has its own **Share...**; a machine with no agents in Opaya offers **Find agents there** or **install one**.
- **Agents in Docker containers can work on your projects too** (for example a Hermes or Claude Code container on your VPS): the copy goes into the container's data folder, so it survives the container being updated, and git runs inside the container. Containers use Git over SSH or a plain copy.
- **Each agent gets its own copy and its own branch** (`opaya/<agent>`), so two agents on one server never step on each other. Send and Bring back are per agent, on the project card, in the agents list and when you right-click the agent in the project.
- **Stop sharing**: right-click the agent in the project > Stop sharing, optionally deleting its copy on the server. Your folder is never touched.
- Projects shared with 0.16.0 are folded into their local project automatically, chats included.

# Opaya 0.16.0 - Remote agents on your local projects

- **Let an agent on a machine work on a local project**: Projects > your project > **Let an agent on a machine work on it** (or right-click > Work on it from a machine). Pick the machine and the agent, then how the project gets there:
  - **Git over SSH** (recommended for git repositories): your current branch goes straight to the machine with git, optionally with your uncommitted changes. Your folder and branch stay exactly as they are. The agent works on its own branch (`opaya/<agent>`). No GitHub needed.
  - **Through GitHub**: the machine clones your repository (Opaya pushes your unpushed commits first) and the agent pushes its own branch, ready for a pull request. If the machine cannot reach the repository, Opaya opens a GitHub sign-in there.
  - **Plain copy**: for folders without git. node_modules, virtual environments and build output stay home.
  - The agent gets its own copy in `~/opaya-projects/<name>`, added as a project on that machine, and a chat with it opens in that folder.
- **Send and Bring back**: the project shows its copies with **Send** (your latest changes) and **Bring back** (the agent's work).
  - Bringing back first shows what the agent did: its commits and every changed file. Then you choose: **Apply to my folder** (its changes become uncommitted edits next to your own work), **Merge commits** (when that is clean), **New branch**, or **Full diff**.
  - Nothing in your folder changes until you choose. Sending never overwrites work the agent did that you have not brought back yet; a plain copy backs up every file it replaces.

# Opaya 0.15.0 - Terminal first, split terminals, and a quieter update note

- **Chat or Terminal**: on first launch Opaya asks how you like to work.
  - **Terminal**: selecting an agent opens its own CLI (Claude Code, Codex, Hermes, Gemini CLI, OpenCode...) filling the window, with tabs and splits. The top bar keeps Chat, Files and Manage one click away. Coming back to an agent brings back its running CLI instead of starting another.
  - **Chat**: as before.
  - Switch any time in **Settings > Workspace style**, or per agent: right-click > **Open as terminal** / **Open as chat**. API connections (DeepSeek, OpenAI...) always chat.
- **Split terminals**: right-click inside any terminal, or the **Split** button, to put terminals side by side.
  - **Split right** / **Split left** open a new terminal next to the one you clicked: the same agent's shell, this computer, the agent's CLI or any machine.
  - **Show beside this** puts a running tab next to it; drag the line between terminals to resize; **Close pane** keeps its session running as a tab. The split is remembered when Opaya restarts.
  - The terminal right-click menu also has Copy, Paste, Select all, Clear, Find, New terminal, Rename, Open in separate window and End session. Shift + right-click still copies or pastes in one click.
- **Gemini CLI opens in its terminal**: Google no longer lets other apps chat with Gemini Code Assist for individuals ("migrate to Antigravity"). Discover adds Gemini CLI as a terminal agent, and any agent that answers with that message switches to its terminal by itself and tells you. With an API key you can switch it back to chat.
- **Native CLI for ACP agents**: Run native CLI for Gemini CLI and OpenCode now starts their interactive CLI instead of their chat server.
- **The updates note appears once per new version**: closing it (or letting it fade) keeps it closed until something newer comes out, also across restarts. Hermes' growing "updates behind" count no longer brings it back every hour.

# Opaya 0.14.1 - Install agents on a VPS as a Docker container

- **Regular install or Docker container**: installing an agent on a machine now asks how it should run there.
  - **Regular install**: the official installer for the SSH user, as before.
  - **Docker container**: Hermes runs from its official image; Claude Code, Codex, Gemini CLI and OpenCode are installed into a Node.js container. The container is called `opaya-<name>`, restarts with the server and keeps its data in `~/opaya-agents/<name>` (Hermes: `~/opaya-hermes/<name>`), so you can run several side by side.
  - After the install you sign in right in the terminal (Codex uses a device code that works on a server; Hermes runs its setup), and Opaya **adds the agent and connects it** by itself.
  - Without Docker on the machine, Opaya says so and offers **Install Docker there** (Docker Engine on Linux, with your user added to the docker group). An image already on the machine is reused instead of downloaded again.
- **Update and Uninstall know these containers**: Update installs the newest CLI inside the container (Hermes: newest image, same data folder); Uninstall removes the container and keeps its data folder.
- Discover's Install button on a machine goes through the same choice.

# Opaya 0.14.0 - Update checks, automatic fixes, a steadier browser and no more flicker

- **Update checks every hour**: Opaya checks every agent and CLI (Hermes, Claude Code, Codex, OpenClaw, Gemini CLI, OpenCode, Goose, Aider, Ollama) and tools (Node.js, Python, Git, uv, gh and more) on this computer and on every machine with an agent. When something is out of date you get a note and an "updates available" chip in the status bar; **Updates** lists each machine with **Update**, **Update all here** and **Check now**.
  - Latest versions come from npm, PyPI, GitHub releases and nodejs.org; Hermes counts how many updates its checkout is behind.
  - Node.js is only offered a newer version of the line you use, unless that line has reached its end of life.
- **Install shows what is already there**: installed agents and tools show their version with **Update** or **Check for update** instead of Install. "All essentials" installs only what is missing. Discover no longer lists installed CLIs as missing.
- **Automatic fixes**: when an agent does not connect because something is too old ("unknown argument", "no longer supported", "requires Node.js 20"...), Opaya updates it (or Node.js / Python) in a visible terminal and reconnects. If that does not work, the Opaya Agent takes over; if it cannot, you get the error with Copy, Connection log and Opaya Agent buttons. Turn it off in Settings > Agents and tools.
- **Opaya browser no longer gets stuck** on `browser_read` and other actions:
  - pages that open `alert`, `confirm` or "leave this page?" dialogs blocked every later action; Opaya now answers them and tells the agent;
  - pages that are still loading or busy are read right away or return a clear error; every action returns within 45 seconds.
- **The browser is for models that can see images**: Opaya knows which models have vision (Claude, GPT-4o and later, Gemini, Grok, Qwen-VL, Llama 3.2 Vision, Pixtral...) and which do not (DeepSeek, Qwen3, gpt-oss, Codestral...). Text-only models cannot get the browser; the right-click menu and Manage say why, and for unknown models you are told what works.
- **No more flicker, and right-click works during clones and other jobs**: the progress window updated by rebuilding itself several times a second, restarting its animations, and its log scrolling closed any open context menu. It now changes only what changed, and menus close on scroll only when what they belong to moves.

# Opaya 0.13.2 - Codex CLI, Gemini CLI and OpenCode are found and connect

- **Discover finds CLIs installed with nvm, Volta, fnm, bun, pnpm, asdf or mise.** An app started from the Dock or Start menu does not get your terminal's PATH, so Codex, Gemini CLI and OpenCode installed with npm under a Node version manager were invisible, on macOS especially. Opaya now also reads your login shell's PATH (zsh, bash or fish) and checks those folders, locally and over SSH.
- **Gemini CLI and OpenCode are real chat agents.** Discover adds them and Opaya chats with them over ACP (`gemini --acp`, `opencode acp`), with live activity and tool approvals, like Hermes. Older Gemini versions get `--experimental-acp`. Before, they could not be added from Discover at all and showed as not installed.
- **The Opaya Agent with the Codex CLI** starts Codex from the same paths, and says plainly when Codex is not installed instead of failing to start.
- **Windows**: npm, pnpm and Yarn launchers (`gemini.cmd`, `opencode.cmd` and others) now start the real program, so Gemini CLI and OpenCode can chat on Windows too. Volta, Scoop, pnpm, bun and nvm-windows folders are searched.

# Opaya 0.13.1 - Collapsed sidebar groups stay visible

- **Collapsing a sidebar group no longer hides it.** The group header now stays with its agent count; click it again to expand. A style meant for lists inside the Transfer and Skills library dialogs also hid collapsed sidebar headers.

# Opaya 0.13.0 - Manage, update, back up and uninstall every agent

- **Manage screen**: right-click an agent > **Manage**, or the **Manage** button above a chat. One screen with everything for that agent:
  - where it runs, how it is installed (npm, Homebrew, uv, pipx, the official installer, a Hermes profile or a Docker container), its version and how much data it has;
  - every action, grouped: Conversations, Files & terminal, Skills & tools, Name & look, Maintenance and Connection;
  - its local backups (Show in folder, Delete) and a danger zone with Uninstall and Remove connection.
- **Update any agent**: Hermes, Claude Code, Codex, OpenClaw, Gemini CLI, OpenCode, Goose, Aider and Ollama, on this computer or a VPS. Opaya runs the right updater for the installation. A Docker container made by Opaya gets the newest image and is recreated with the same data folder; a Docker Compose container is recreated with Compose.
  - **Update all agents** (Machines, or right-click the workspace) updates each installation once per machine after one approval.
- **Uninstall**: Opaya finds how the agent was installed on that machine and removes it the same way, in a visible terminal:
  - npm, Homebrew, uv, pipx, pip or the vendor's installer; `hermes uninstall` when Hermes has it;
  - a Hermes profile is deleted as a profile, so Hermes and other profiles stay; a container is removed as a container;
  - options: back up first, also delete the agent's data, and remove the connection from Opaya when it finishes;
  - agents that share the installation (Hermes profiles) are named first. Opaya never deletes a home folder.
- **Back up to this computer**: saves an agent's own data as a `.tar.gz` on this computer, from here, a VPS or inside a container. With or without chat history and API keys; the archive is readable only by your user. Hermes backs up its home without the installation or other profiles; Claude Code, Codex, OpenClaw, Gemini CLI, OpenCode and Goose back up their config folders. A small `.json` next to each archive describes the connection.
- **Right-click menu, organized**: the agent menu now has submenus: Files & terminal, Skills & tools, Name & look and Maintenance. Hover or press the right arrow to open one, left arrow or Escape to go back.
- **Machine name in the sidebar**: under each agent's name, in small letters, the machine it runs on (the provider's server for API connections like DeepSeek).
- **Rename this computer**: Machines > the pencil next to This computer: its name in Opaya, a note, and the folder where backups go. The system hostname does not change.

# Opaya 0.12.2 - Add a VPS that has no Hermes yet

- **Add a new VPS** no longer fails with "Process exited with code 1" on a server without Hermes. The connection was fine, but the last step of the check (is Hermes installed?) returned 1 and Opaya read that as a failed connection. A fresh VPS now passes: Opaya shows Docker and Hermes as "not installed" and lets you save the machine, then install Hermes from Install agents or clone an agent to it.

# Opaya 0.12.1 - Models and skills for every agent

- **Model selector**:
  - **Hermes (ACP)**: models are read from the session's model setting (`configOptions`), which newer Hermes versions use instead of the older `models` list, and are set the same way. Before, a newer Hermes looked like it had no models.
  - **Claude Code** offers `sonnet`, `opus`, `haiku`, `opusplan` and the current full model ids.
  - **Codex** reads every page of its model list.
  - An agent that reports no models no longer shows an empty dropdown. You can type the model name, and Opaya tries it and says so in the chat if the agent refuses it.
  - While Hermes loads its models, the dialog says it can take up to a minute.
- **Skills for Hermes on a VPS and in Docker**: the Skills panel now reads the agent's real Hermes home. For Hermes in a container that is inside the container; for Hermes on a VPS it is found through SSH. It uses plain `sh`, so `python3` is no longer needed on the server.

# Opaya 0.12.0 - Free models for the Opaya Agent, out of the box

- **Start free**: one click sets up the Opaya Agent with a free, open model on this computer. No account, no API key, nothing to type:
  - Opaya installs Ollama if it is missing: with winget on Windows, with Homebrew or into your Applications folder on macOS.
  - It starts Ollama, downloads the model in the progress window (size, speed, time left) and connects the Opaya Agent.
  - Choose Qwen3 4B (recommended, 2.5 GB), Llama 3.2 3B (smallest, 2 GB) or Qwen3 8B (smarter, 5.2 GB, needs 16 GB RAM). Opaya recommends the one that fits your computer's memory.
- **Zero-click on a fresh install**: if Ollama already runs with a model that can use tools, the Opaya Agent connects to it by itself on first launch.
- **More free providers** in Model settings, each marked "Free tier" with a "Get a free key" link:
  - new: **Ollama Cloud** and **Cerebras**;
  - OpenRouter now starts with its `:free` models;
  - Groq, Google Gemini and Mistral are marked as free tiers.
  - Test connection loads each provider's live model list.

# Opaya 0.11.2 - Windows updates that actually install

- **Windows: Restart and update now uses the standard Electron installer update.** Opaya starts the installer with `--updated /S --force-run`, the method electron-updater uses. The installer closes every running Opaya, including the background session service, installs over your installation and starts Opaya again. Opaya no longer relies on its own PowerShell script.
- **A failed update is no longer silent**:
  - If Opaya starts again still on the old version, the status bar says "Update did not install".
  - Settings > Updates explains what happened and offers **Run installer**, which opens the normal installer.
- The same check covers macOS updates.
- Versions 0.11.1 and earlier still use their old updater. Install 0.11.2 by hand once. Updates after that use the new method.

# Opaya 0.11.1 - An Opaya Agent that does the install for you, and terminal paste

- **The Opaya Agent installs and updates everything itself**:
  - It checks what is installed and installs missing dependencies first (Node.js, Python, Git, uv, tmux, GitHub CLI, Homebrew), then installs the agent.
  - It follows each install to the end and answers installer questions on its own (Enter, y/n, menu numbers).
  - Afterwards it discovers the new agent, adds it and connects it.
  - You are only asked for passwords and account sign-ins, which it can never type.
  - **Updates**: every agent (Hermes, Claude Code, Codex, OpenClaw, Gemini CLI, OpenCode, Goose, Aider, Ollama) and every dependency can be updated to its latest version, or all essentials at once.
  - It knows every part of the app (history, condense, transfer, skills library, clone, projects, iTrust, browser, updates) and tells you exactly where things are.
  - It no longer asks you to type commands into a terminal.
  - Linux package installs run without questions. npm tools install to your user folder when the global folder is not writable, so no sudo is needed.
- **Clone asks about cron jobs**: a new "Include cron jobs" choice, on by default only for Everything. Cloned jobs run on both agents (for example posting to Slack twice), so it is now your call. Redeploy remembers the choice.
- **Paste in the terminal works again**: the Edit menu's Ctrl+V (and Cmd+V on macOS) took the key before the terminal saw it. Every paste now arrives exactly once: Ctrl+V, Ctrl+Shift+V, Cmd+V, right-click, and in popped-out terminals.
- **macOS**:
  - Intel Macs have their own build (`mac-x64`).
  - The session service no longer waits on the keychain while starting.
  - If it cannot start, the error says at which step and why.

# Opaya 0.11.0 - Chat history, skill transfer and a skills library

- **macOS for Intel**: every macOS release now has an Intel build (`mac-x64`) next to Apple Silicon (`mac-arm64`), and in-app updates pick the right one.
- **Chat history panel**:
  - Click the clock button next to a chat, press Ctrl/Cmd+Shift+H, or right-click an agent and choose **Chat history**. The panel opens on the right, in place of Projects.
  - Chats are grouped by day. Tabs show All, Chats, Projects and Playground. You can search them and switch between one agent and all agents.
  - Project chats carry a blue label with the project name, also in the chat picker (`[project] title`). Playground chats carry a purple label.
  - Hover a chat to **Condense**, **Share** or **Delete** it. Right-click it to **Rename** it or **View essence**.
- **Delete chats**: regular, project and playground chats. Opaya deletes the chat and its transcript; the agent's own session files are not touched.
- **Condense**:
  - Reads the whole chat and keeps only its essence: goal, key points, decisions and open items.
  - A warning shows about how many tokens it will use before you start.
  - If the Opaya Agent has a model API key (DeepSeek, OpenAI, Gemini, OpenRouter and others) or a local model, that model does the work and the agent's session is not touched. Without a key, the chat's own agent condenses it, and its answer also appears in the chat.
  - The essence is saved with the chat. From it you can **Copy**, **Send to agent** or start a **New chat from essence**.
- **Share**: Copy as Markdown, Copy essence, Save as Markdown file, or **Send to another agent**, which opens a new chat with the essence or the whole chat ready to send.
- **Transfer to another agent** (right-click an agent, or the Skills panel):
  - **Skills**: all of them or the ones you select. They work across Hermes, Claude Code, Codex and OpenClaw, on this computer or a VPS.
  - **Credentials**: all or selected API keys from a Hermes `.env`. Keys are merged by name into the other agent's `.env`, which stays private (0600). The UI only ever shows key names, never values.
  - **Tools & MCP servers** the agent uses, and optionally its saved gateway token.
  - The transfer runs in the progress window.
- **Skills library**: global skills kept by Opaya.
  - Add skills from any agent or from a folder.
  - Install them to one or many agents in one go, or remove them.
  - Find it in Settings, the workspace menu and the Skills panel.
- **Fixes**:
  - A terminal tab of a removed agent can now always be closed.
  - Fixed a rare hang in cloning when the copy finished very quickly.
  - On a slow first launch (older Intel Macs, Gatekeeper scan), Opaya now waits up to a minute for its session service instead of 15 seconds.

# Opaya 0.10.2 - A clone window worth watching

- **Clone and Redeploy run in their own window**:
  - A route from the source agent to the target machine, with packets moving while files copy.
  - A large live percentage and progress bar showing copied size, speed, time left and elapsed time.
  - A checklist of every step (check target, find source, choose files, copy, start container, add to Opaya, connect), plus a live log of what is happening.
  - **Minimize** it to a progress ring in the status bar and keep working. Click the ring to bring it back. It shows again after Opaya restarts.
  - When it finishes: **Open** the new agent, or **Copy log**. If the target is missing Hermes, **Install Hermes there** is one click away.
- **No more timeouts**:
  - Clones run in the background with no request timeout, and copying may take up to two hours.
  - The size is measured first and files are sent uncompressed through tar (SSH compresses on the network), so the percentage is accurate.
- **No second "Trust this agent?"**: you already confirmed the clone, so Opaya no longer asks again at the end (that prompt could time out).
- **Approvals wait 10 minutes** (was 2). When Opaya is not in front, a system notification and a flashing taskbar button tell you an approval is waiting, and also when a clone or redeploy finishes or fails.

## Earlier: 0.10.1 - Updates that finish

- **Windows: Restart and update now installs and reopens Opaya.** Before, Opaya closed and started the installer silently. If anything went wrong (for example the session service or a helper still running), nothing happened and Opaya did not come back. Now:
  - Opaya waits until every Opaya process from its install folder has exited, and stops any that hang.
  - It runs the installer into the same folder, checks the result and starts Opaya again.
  - If the silent install fails, it opens the normal installer so you can see why.
  - Each step is logged to `update.log` next to the download.
- After an update, Opaya confirms it: "Opaya updated to 0.10.1".
- Versions 0.8.0 to 0.10.0 still use their old updater, so install 0.10.1 by hand once; later updates use the fixed one.

## Earlier: 0.10.0 - Clone agents, new VPS in minutes, clearer Discover, a friendlier Opaya Agent

- **Clone a Hermes agent** (right-click > Clone):
  - Choose what to copy: **Everything**, **Skills + personality** (skills, SOUL.md, USER.md), **Skills** or **Memory**, with or without API keys.
  - Choose where: **this computer** or any saved **VPS**.
  - Choose how it runs: as a **Hermes profile**, or as a **Docker container** (`nousresearch/hermes-agent`, restarts automatically).
  - Opaya copies the files straight across (this computer to a VPS, a VPS to this computer, or one VPS to another) and adds the clone as a ready connection.
  - As with Hermes' own `--clone-all`, chat history and OAuth logins are never copied.
- **Redeploy**: right-click a clone > Redeploy from its source copies the same parts again (and restarts its container). Its chat history stays.
- **Add a new VPS** (Machines > + New VPS, also in Discover and in the Clone dialog):
  - Opaya creates an SSH key just for that server in `~/.ssh` and shows the public key to copy into your provider's panel.
  - If you only have a password, Opaya can install the key for you in a terminal.
  - Opaya then tests the connection, trusting the server on first connect, and checks for Docker and Hermes.
- **Discover**:
  - Tabs for this computer and each machine.
  - Agents found but not yet in Opaya come first.
  - Agents that are not installed on that machine get one-click **Install** buttons.
  - Agents already in Opaya are hidden in a collapsed group.
- **Machines**: *This computer* has its own row (Terminal, Discover, Files), separate from remote machines.
- **Opaya Agent**:
  - **Chat history**: keep several chats, switch between them, start new ones and delete old ones. Older history becomes the first chat.
  - **Proactive, gently**: a small card now and then. It says hello once a day, checks in when an agent has been working for more than five minutes, and points out useful features for your setup. At most one card at a time, spaced at least 20 minutes apart (check-ins about long-running work show right away), and each one only once.
  - The Opaya logo now moves only while the Opaya Agent is working.

## Earlier: 0.9.0 - iTrust, the Opaya browser, rich messages and a flexible layout

- **iTrust mode**: tool requests (commands, file edits and other actions an agent asks permission for) are approved automatically.
  - Turn it on for one agent (right-click > Turn on iTrust), for all agents, or for the Opaya Agent (Settings > iTrust mode, or the iTrust switch in the Opaya Agent's top bar).
  - Trusted agents show an iT mark in the sidebar and an iTrust badge in the top bar, and each automatic approval appears in the chat.
  - Works with Hermes and other ACP agents, Codex and Claude Code; Claude Code runs in bypass-permissions mode.
  - The Opaya Agent still asks before removing connections or machines.
- **The Opaya browser**: a real browser pane inside Opaya (globe button in the top bar).
  - Links in agent replies open there; Ctrl+click opens them in your own browser.
  - Give an agent the Opaya browser (right-click > Give Opaya browser) and it can open pages, read them, take screenshots, click, type and scroll while you watch. An "Agent browsing" badge shows when it does.
  - Available to agents on this computer that use ACP (Hermes) or Claude Code; they get it from their next conversation.
  - The browser has its own sandboxed profile, opens only web addresses, and refuses camera, microphone, location and other permission requests.
- **Rich messages**: agent replies render headings, tables, task lists, nested lists, quotes, images, links and code blocks with Copy. HTML and SVG blocks have a Preview that opens in the Opaya browser.
- **Customizable layout**:
  - The terminal and the browser dock at the bottom (side by side) or on the right (stacked). Move them with the dock button in each panel.
  - Drag the edges to resize, and use the expand button to maximize. Opaya remembers the layout.

## Earlier: 0.8.0 - Terminal rebuilt, updates inside the app

- **In-app updates**: Opaya checks GitHub for a new version shortly after it starts and every six hours. When one is out, a notice appears in the status bar; click it, then **Download update** and **Restart and update**. The download is checked against the release's SHA-256 list first.
  - Windows installs silently into the same folder and opens Opaya again.
  - macOS replaces Opaya.app, keeping the old copy until the new one is in place.
  - You can also check any time from Settings > Updates. This version has to be installed by hand once; after that, updates happen inside Opaya.
- **No more duplicate lines in the terminal**:
  - On Windows, xterm now runs in ConPTY mode, so it no longer rewraps lines Windows has already wrapped.
  - Unicode 11 character widths keep emoji and symbols in agent status bars aligned.
  - Opaya tells the program about a resize only when the size actually changes.
  - Reopening a running agent CLI makes it redraw the screen cleanly.
- **Sharper and faster**: GPU (WebGL) rendering with a fallback, a tuned color palette for dark and light themes, 10,000 lines of scrollback and a better monospace font stack.
- **Compact toolbar**:
  - One slim row: session tabs (close with the x or a middle click) on the left and small icon buttons on the right: Shell, CLI, Search, Pop out, End, Expand and Hide.
  - The large Detach and End session buttons are gone.
- **Search** the terminal output with Ctrl+F or the search button (Enter for next, Shift+Enter for previous).
- **Copy and paste**:
  - Ctrl+C copies when text is selected and interrupts otherwise; Ctrl+V or Ctrl+Shift+V pastes, and Ctrl+Shift+C copies.
  - Right-click copies the selection, or pastes when nothing is selected.
- **Links**: Ctrl+click (Cmd+click on macOS) opens web links from the terminal.
- The popped-out terminal window gets all of the above.

## Earlier: 0.7.0 - Projects panel with git

- **Projects panel** on the right. Open or close it with the folder button in the top bar or Ctrl/Cmd + Shift + P; it takes no space while closed, and Opaya remembers whether it was open.
- **A project is a folder** on this computer or a saved machine, plus the agents that work in it. Add an existing folder (with suggestions from your agents' working folders) or clone a repository.
- **Chats in projects**: click an agent in a project to start a chat in that folder. Hermes and other ACP agents, Codex and Claude Code start in the folder. Gateway agents are told the folder. Each project lists its chats from every agent, and the top bar shows which project a chat belongs to.
- **Change agents in a project** from the panel (+ Agent), by right-clicking an agent chip, or from an agent's right-click menu > Projects.
- **Git and GitHub CLI** (right-click a project, or click its branch):
  - git: status, pull, push, fetch, commit, commit and push, stash, new branch, switch branch, merge and history;
  - GitHub CLI (`gh`): create a pull request, list PRs, PR status and checks, open a PR in the browser, check out a PR, merge a PR and sign in.
  - Commands run in the project's own visible terminal. Branch names, commit messages and PR numbers are checked before they are used.
- The branch and the number of uncommitted changes show next to each project.
- **GitHub CLI** is in the installable dependencies.
- **Opaya Agent** can list projects.

## Earlier: 0.6.0 - Skills, tools and MCP servers

- **Skills**: the new **Skills** button (and right-click > Skills, tools & MCP) lists the skills installed for an agent, read from their SKILL.md folders, for Hermes, Claude Code, Codex and OpenClaw, on this computer or over SSH. **Use** puts `/skill` in the message box.
- **Install Hermes skills**: enter a hub id (for example `official/security/1password`) or a link to a SKILL.md, or open the Hermes skills hub. Installs run with `hermes skills install` in a visible terminal after you approve them.
- **/ in the message box** lists the agent's commands (Hermes: /tools, /model, /compress ...) and its skills. Use the arrow keys and Enter or Tab to pick one.
- **MCP servers** (Settings > MCP servers): add a program (stdio) or an HTTP/SSE server once, then choose which agents use it. Opaya passes them to Hermes and other ACP agents when a conversation starts, and to Claude Code on this computer. Environment variables and headers (API keys) are stored in the OS-encrypted vault and are never shown again.
- **Opaya Agent** can list skills, install Hermes skills (with your approval) and list MCP servers (names only, never values).
- **Local Hermes that never answers**: the Connection log now shows the Hermes version. If Hermes is still starting its terminal after 30 seconds, the chat says so. This is a known Hermes-on-Windows problem with Git Bash under ACP, and the chat suggests the fix: run `hermes update`, or use the Hermes gateway API. On Windows, Opaya now passes `HERMES_HOME` and `HERMES_GIT_BASH_PATH` from your user settings to Hermes, even when Hermes was installed after Opaya started.

## Earlier: 0.5.3 - Readable Hermes logs

- **Connection log stays readable**: a retry loop that repeats the same error thousands of times, such as the Hermes Slack reconnect bug (`slack_bolt ... Session is closed`), is collapsed into one entry with a repeat count. Opaya reads more of each log file, so the lines around the problem stay visible.
- **Opaya Agent knows the Hermes Slack bug**: it recognizes the known Hermes gateway Slack reconnect loop (NousResearch/hermes-agent#83662) and suggests restarting the Hermes gateway.

## Earlier: 0.5.2 - Hang diagnostics and the Windows icon

- **Windows icon is back** in the taskbar, window and shortcuts. Every size in the .ico is now a plain bitmap, so Windows always draws it, and the installer and uninstaller use the Opaya icon too.
- **Long Hermes runs no longer time out**: the 10-minute cap on a local ACP answer is gone. A command or terminal run can take as long as it needs, and Stop still cancels it.
- **Approvals are visible**: when Hermes asks permission to run a command, the chat shows "Waiting for your approval". "Always allow" requests are answered too.
- **Live turn watch**: every running answer shows how long it has run and when the agent last sent anything. After 45 seconds of silence it says so and offers Connection log and Stop.
- **Connection log** (right-click an agent, or the button in a running answer): shows what Opaya and the agent exchanged, the agent's stderr, running tools, pending approvals and the tail of the Hermes log files. It refreshes live and redacts secrets. "Ask the Opaya Agent" hands it to the new `agent_diagnostics` tool.

## Earlier: 0.5.1 - Local Hermes visibility and Codex-powered Opaya Agent

- **Local Hermes live activity**: Hermes ACP thinking, plan and tool updates now appear while it works, with useful status and file/location context instead of a silent spinner.
- **No cropped working view**: the conversation shell no longer creates a second vertical scrollbar; messages scroll independently while the composer and Stop control remain visible.
- **Local Codex for Opaya Agent**: the built-in Opaya Agent can run through the installed Codex CLI and its native app-server protocol, including scoped Opaya tools and live streamed replies.
- **More model providers**: DeepSeek, OpenAI, Gemini, OpenRouter, xAI, Groq, Mistral, Ollama and LM Studio have ready-to-use default endpoints.
- **Model dropdowns**: provider models are selected from presets or the provider's live `/models` response instead of being typed manually. DeepSeek includes `deepseek-v4-pro` and `deepseek-v4-flash`.

## Earlier: 0.5.0 - Groups, tags and Playground

- **Groups and tags**: put agents into named groups and give them tags (right-click > Group & tags, or the connection settings). The sidebar shows pinned agents, each group, then local and remote agents; every section collapses and expands and remembers it. Right-click a section to rename, ungroup, collapse or expand all, or connect everything in it. Filter the Workspace by tag; search matches groups and tags.
- **Drag and drop**: drag agents in the sidebar to reorder them, or drop them on a section header to move them into that group (or Pinned). The up/down arrows and the dots button are gone; right-click has every action.
- **Connect all**: connect every agent at once from the Workspace, the Playground, the workspace right-click menu or a group's menu. Agents that fail are listed without stopping the others.
- **Playground**: pick two agents, ask one question and watch both answers side by side, with Swap, Keep context, Stop both and Open in chat. Your open agent does not change.

## Earlier: 0.4.0 - Opaya Agent preview

- **Opaya Agent**: a built-in assistant for installing, connecting, maintaining and troubleshooting agents, machines and SSH keys. It connects to any OpenAI-compatible model API (OpenAI, Anthropic, OpenRouter, Ollama, LM Studio, a Hermes gateway). Changes and commands always need your approval; it never sees API tokens and cannot modify the app.
- **One-click installs** of Hermes Agent, Claude Code, Codex, OpenClaw, Gemini CLI, OpenCode, Goose, Aider and Ollama, locally or on a saved SSH machine, in a visible terminal.
- **Own window frame** with Opaya window controls on Windows, Linux and macOS.
- **Dependencies on click**: Node.js, Python, Git, uv, tmux, OpenSSH and Homebrew, plus an **All essentials** bundle that installs only what is missing, here or on a VPS; the Opaya Agent checks prerequisites and installs them too. On Windows, newly installed tools are found without restarting Opaya.
- **Hermes on Windows** installs with the official `install.ps1`.
- **Sharp icons**: the Windows icon now contains every size from 16 to 256 px, and the window, taskbar and tray use dedicated icons instead of a scaled-down Mac icon.
- **Files panel**: browse folders, preview files and see project info (git branch, changes, recent commits, project files) for any agent, this computer or a VPS over SSH. Read-only, with Terminal here and Mention in message. The Opaya Agent can read projects too, but never secret files such as `.env` or keys.
- **Default model per agent**: Models sets the agent default for every chat, or a model for the current chat only.
- **Stop keeps the agent connected**: Stop now cancels only the current answer (HTTP abort, ACP cancel, Codex interrupt, Claude turn) and keeps the partial text; the connection is only reset if an agent ignores the cancel for 15 seconds.
- **Hermes communication**: long tool runs no longer drop after 5 minutes of silence (no fetch body/header timeout for chat, inactivity limit of 15 minutes instead of a hard 10-minute cap), streams that end with `finish_reason` but no `[DONE]` are complete, reasoning shows as "Thinking", array content is read, and gateway errors include the gateway's message.
- **Codex icon** instead of the OpenAI logo, and an **icon library** (33 icons) plus image upload per agent.

## Earlier: 0.3.0 - Windows and macOS preview

**One place. All your agents.** AgentHub is now **Opaya** ([opaya.dev](https://opaya.dev)).

- New name, the OPAYA green logo as app icon and animated brand mark, and the official Hermes, Claude Code, Codex and OpenClaw logos (same brand pack as opaya.dev).
- Light theme reworked: every screen (Settings, Help, Machines, forms, switcher, chat) now adapts; status colors and accent are tuned for white. Existing AgentHub workspaces are reused automatically; stop all sessions from the tray before upgrading on Windows.
- macOS build (Apple Silicon DMG/ZIP), ad-hoc signed, not notarized: right-click > Open on first launch.
- Right-click menus for sidebar agents, Workspace cards, terminal tabs and the workspace. Pin and rename no longer drop a live connection.
- Motion: staggered sidebar and card entrances, view transitions, animated status, dialogs, toasts, terminal panel and new messages. Respects reduce-motion.
- Native copy/paste menu in text fields and selections.

## Earlier: 0.2.0 - Windows persistent-session preview

Standalone Windows x64 desktop hub. This release is unsigned.

- Independent local session service: closing the UI keeps native agent processes and PTYs alive.
- Conversations, exact native session identifiers, per-conversation drafts, selection and terminal scrollback persist.
- Partial responses are checkpointed; corrupt workspace recovery preserves the original file.
- Quick SSH address entry, saved SSH config import, selected-host discovery, private gateway tunnels and explicit tmux session attachment.
- xterm.js + node-pty integrated terminal with replay sequence numbers and remote tmux reattachment.
- Native startup diagnostics, safe-graphics mode, sandboxed renderer, OS-encrypted tokens, approval prompts which default to deny when no UI is present.
- Windows CI tests real UI exit/restart and real terminal output, builds an NSIS installer, installs it and repeats those checks against the installed EXE.

The published release assets exist only after the native checks succeed. See the run logs and included BUILDINFO.json for the source commit. Live connections to the owner's agents are not part of unattended CI. Local processes cannot survive OS reboot; saved history remains, and remote tmux survives disconnection but not necessarily host reboot. Automatic Docker/WSL discovery and import of existing Hermes REST sessions are not implemented.
