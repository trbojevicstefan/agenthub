# Opaya

**One place. All your agents.** [opaya.dev](https://opaya.dev)

Opaya (formerly AgentHub) is a standalone, local-first desktop hub for your own Hermes, Codex, Claude Code, OpenClaw and terminal-based agents. Add a local installation or SSH machine, keep conversations separate, and switch without losing the process behind the window. No hosted account, telemetry, billing or third-party relay is required.

## Windows

Download the **Opaya-…-Setup-x64.exe** from this repository's Releases. This is an **unsigned preview** for Windows 10/11 x64. Install it and open Opaya.

**Upgrading from AgentHub:** first use the tray icon's **Stop all sessions and exit**, then run the Opaya installer. Opaya keeps using your existing AgentHub workspace (agents, conversations, drafts and saved tokens), so nothing needs to be re-added. The installer uses the same application ID and normally replaces AgentHub; if an old AgentHub entry remains in Settings > Apps, uninstall it (your workspace is kept).

## macOS

Download **Opaya-…-mac-arm64.dmg** (Apple Silicon, M1 and later; Intel Macs are not built yet) from the Releases marked *macOS preview*, open it and drag Opaya to Applications. The build is ad-hoc signed but not notarized, so the first launch needs one approval: right-click Opaya in Applications and choose **Open** (or System Settings > Privacy & Security > **Open Anyway**). Terminal alternative: `xattr -dr com.apple.quarantine /Applications/Opaya.app`. The session service runs without a Dock icon; the menu bar icon has **Stop all sessions and exit**. `npm run dist:mac` builds it on a Mac. You do not need Node.js to use the installed app. Agent CLIs, OpenSSH and their own authentication are separate prerequisites, discovered from your computer.

For source development: Node.js 22+, `npm install`, `npm test`, `npm start`. `npm run dist:win` builds the NSIS installer on Windows; its native dependencies must be rebuilt for the target Electron runtime, not copied from another operating system. `npm run start:safe` disables GPU acceleration without disabling Electron sandboxing.

## Persistent by design

The renderer is a client of a separate local Electron session process. Closing the window or exiting the UI does **not** kill the session process, running agent turns or terminal PTYs. Reopen Opaya to attach to that same process and replay buffered terminal output. The tray menu exposes **Stop all sessions and exit** as a distinct, confirmed action.

Conversations, drafts, exact provider session IDs, selected conversations and window view state are persisted locally. Streaming output and terminal scrollback are checkpointed. A damaged workspace preserves the original and can recover its last valid backup. Interrupted work is marked explicitly; it is never silently retried or resumed into the provider's unrelated "latest" session.

A power loss, OS reboot or explicitly stopping the session service cannot keep a **local OS process** alive. Its saved history remains. Codex and Claude structured chat resume stored provider IDs where supported. ACP resume support is negotiated. Remote terminals use **tmux** so they survive an SSH client disconnect; reboot survival requires the remote machine's own service/session setup. Saved terminal history is clearly distinguished from a live process.

## Opaya Agent

The **Opaya Agent** (top of the sidebar) is a built-in assistant for the app itself: it installs agent frameworks, connects and maintains agents, manages SSH machines and keys, and troubleshoots agents that do not work. Connect it to a model in **Model settings**, like a Hermes gateway: OpenAI, Anthropic, OpenRouter, a local Ollama or LM Studio model, a Hermes gateway, or any OpenAI-compatible `/v1` API. The key is stored with OS encryption.

Safety boundary: it acts only through Opaya's own tools (connections and machines through the same validation as the UI, read-only discovery, fixed diagnostics, and vendor install commands from `desktop/catalog.cjs`). Every change and every command opens a native approval dialog and runs in a visible terminal. It never receives API tokens, has no generic shell or file access, and cannot modify the app. Its config, chat and notes live in `<app data>/opaya-agent`.

## Install agents

**Install agents** (Workspace, the Add dialog, right-click the sidebar, or ask the Opaya Agent) installs Hermes Agent, Claude Code, Codex, OpenClaw, Gemini CLI, OpenCode, Goose, Aider or Ollama, and the dependencies they need (Node.js, Python, Git, uv, tmux, OpenSSH, Homebrew, or **All essentials** for whatever is missing) with one click, on this computer or on a saved SSH machine. Opaya shows the exact vendor command first and runs it in a terminal you can watch. Then run Discover to add the agent.

## Files and models

**Files** (agent header, the Opaya Agent header, Machines, or right-click) opens a read-only side panel for the agent's folder, this computer or a saved SSH machine: folders, file previews up to 256 KB, and project info (git branch, uncommitted changes, recent commits, project files). **Terminal here** opens a shell in that folder, **Mention in message** puts the path into your message. Remote browsing needs `python3` on the machine.

**Models** sets an agent's default model for every chat, or overrides it for the current chat only.

## Icons and window

Agents show their official logos. Right-click an agent and choose **Change icon** to pick one of 33 library icons (LobeHub Icons, MIT) or upload a PNG, JPEG or WebP. Opaya draws its own window controls on Windows, Linux and macOS.

## Everyday use

Right-click any agent in the sidebar or on the Workspace cards (or use its `⋯` button) to open, start a new conversation, connect/disconnect, open a shell or the native CLI, pin, rename, reorder, edit or remove it. Pinning and renaming do not interrupt a live connection. Right-click a terminal tab to rename it, move it to its own window or end it; right-click empty sidebar space for Discover, Add connection, Machines, a local terminal and the theme. Text fields and selections keep the standard copy/paste menu. Animations follow the OS *reduce motion* setting.

## Add agents

- **Local:** Discover scans known executable/config locations and a small set of loopback API ports. Review any result before adding. It does not launch discovered programs or scan a LAN.
- **Remote:** Machines -> paste `user@host:22` or import `~/.ssh/config` aliases. Open the machine's terminal to verify its host fingerprint and authenticate; then Discover searches only that selected host. Existing SSH keys remain local. A gateway token may be imported from a specific Hermes profile only after approval.
- **Four Hermes profiles:** use four gateway connections (separate loopback ports or profile-specific `/p/<name>/v1` routes). The SSH tunnel stays private. The chat adapter sends stable Hermes transcript/memory headers and saved history. Existing tmux sessions can also be discovered and attached without creating another agent writer.

Remote terminal persistence requires `tmux` on the host; Opaya does not silently install software. Gateway chat does not require tmux. Remote discovery inventories running Hermes Docker containers. Other Docker/WSL launchers can be configured manually. See [the compatibility matrix](docs/COMPATIBILITY.md) for supported operations and remaining validation.

## Adapters

Hermes/custom: OpenAI-compatible chat with full persisted transcript; Hermes gets stable `X-Hermes-Session-Id` and `X-Hermes-Session-Key` headers. OpenClaw: stable per-conversation `user` routing with only the new turn sent. Codex: app-server JSON RPC. Claude Code: streaming CLI with an exact session UUID. Hermes/other ACP agents: negotiated session persistence, permission prompts, and isolated per-conversation state. Any other CLI: terminal-only connection.

The API compatibility layer does not import all pre-existing Hermes server sessions or guarantee reattachment to an HTTP task after a full service failure. A window-only close does not disconnect that task because the session process remains alive. See `docs/SECURITY.md` and `docs/VERIFICATION.md` for boundaries.

## Verification

`npm test` runs offline protocol, security, persistence and actual loopback-HTTP tests. `npm run smoke:restart` launches two actual Electron UI processes in sequence against one isolated session service and real native PTY. The second must recover the same service PID, live terminal, output, conversation and draft. The Windows workflow repeats this against the **installed executable**, then publishes immutable build-tagged installer assets and SHA-256 checksums. The macOS workflow builds Apple Silicon DMG/ZIP files, ad-hoc signs them, runs the same restart test against the packaged app and publishes a separate macOS preview release.

A successful CI run is evidence of native Windows startup/packaging, not evidence that the owner's private VPS accounts and installed provider versions have been tested. No sample agents or credentials are added to production workspaces.
