# Opaya development checkpoints

## Implemented
- [x] Standalone application identity and local sandboxed Electron UI.
- [x] Local/SSH agent inventory, quick SSH address parser and existing SSH config import.
- [x] Hermes, custom HTTP, Codex app-server, Claude CLI and ACP adapters.
- [x] Isolated per-agent conversations and exact provider-session IDs.
- [x] Separate authenticated local session process (named pipe on Windows).
- [x] UI detach/reconnect without stopping the session process or local PTYs.
- [x] Durable conversation drafts and current selection.
- [x] Atomic disk writes, fsync, workspace backup/recovery and partial-output checkpoints.
- [x] xterm.js/node-pty terminal replay and scrollback checkpoints.
- [x] Remote tmux create-or-attach and discovery of existing named sessions.
- [x] Native Windows restart test and installed-EXE packaging workflow.
- [x] Opaya rebrand with automatic reuse of existing AgentHub workspaces.
- [x] macOS Apple Silicon DMG and ZIP workflow with ad-hoc signing and packaged-app restart test.
- [x] Context menus for agents, terminal tabs and the workspace; first-appearance motion system.
- [x] Opaya Agent with approved tools, diagnostics, chat sessions and gentle tips.
- [x] Install agents and dependencies locally or over SSH; Discover split into installed/available and local/remote.
- [x] Skills, commands and MCP servers per agent; skill transfer between agents and a global skills library.
- [x] Projects panel with git and GitHub CLI actions.
- [x] In-app updater with SHA-256 verification (Windows silent install, macOS bundle swap).
- [x] iTrust mode (global, per agent, Opaya Agent), Opaya browser with an MCP bridge, rich Markdown messages, customizable dock layout.
- [x] Hermes clone and redeploy (local, VPS, Docker) with a background progress window; New VPS with SSH key generation.
- [x] Chat history panel: labels, delete, rename, condense, share.

## Acceptance still requiring the owner's machines
- [ ] Connect the actual four Hermes profiles and verify authentication/model settings.
- [ ] Verify installed versions of Codex, Claude and OpenClaw against their live accounts.
- [ ] Verify passphrase-protected SSH key UX on the owner's Windows machine.
- [ ] Validate behavior through real VPS network interruption and remote service restart.

## Explicit follow-on scope
- [ ] Import/attach existing Hermes REST sessions with capability/version negotiation.
- [ ] Automatic container/WSL inventory beyond manual launchers.
- [ ] Local process survival across reboot through provider-specific recovery (not possible through a retained PID alone).
- [ ] Code-signing certificate and macOS notarization.

The forward plan lives in [docs/ROADMAP.md](docs/ROADMAP.md).
