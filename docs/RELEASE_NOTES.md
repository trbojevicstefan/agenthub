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
