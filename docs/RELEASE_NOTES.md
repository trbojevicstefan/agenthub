# Opaya 0.6.0 - Skills, tools and MCP servers

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
