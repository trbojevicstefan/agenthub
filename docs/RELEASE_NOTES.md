# Opaya 0.4.0 - Opaya Agent preview

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
