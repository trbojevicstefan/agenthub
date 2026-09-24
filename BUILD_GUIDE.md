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

## Acceptance still requiring the owner's machines
- [ ] Connect the actual four Hermes profiles and verify authentication/model settings.
- [ ] Verify installed versions of Codex, Claude and OpenClaw against their live accounts.
- [ ] Verify passphrase-protected SSH key UX on the owner's Windows machine.
- [ ] Validate behavior through real VPS network interruption and remote service restart.

## Explicit follow-on scope
- [ ] Import/attach existing Hermes REST sessions with capability/version negotiation.
- [ ] Automatic container/WSL inventory beyond manual launchers.
- [ ] Local process survival across reboot through provider-specific recovery (not possible through a retained PID alone).
- [ ] Code-signing certificate, signed updates and macOS notarization.
