# AgentHub

A standalone, local-first desktop hub for your own Hermes, Codex, Claude Code, OpenClaw and terminal-based agents. Add a local installation or SSH machine, keep conversations separate, and switch without losing the process behind the window. No hosted account, telemetry, billing or third-party relay is required.

## Windows

Download the **Setup-x64.exe** from this repository's Releases. This is an **unsigned preview** for Windows 10/11 x64. Install it and open AgentHub. You do not need Node.js to use the installed app. Agent CLIs, OpenSSH and their own authentication are separate prerequisites, discovered from your computer.

For source development: Node.js 22+, `npm install`, `npm test`, `npm start`. `npm run dist:win` builds the NSIS installer on Windows; its native dependencies must be rebuilt for the target Electron runtime, not copied from another operating system. `npm run start:safe` disables GPU acceleration without disabling Electron sandboxing.

## Persistent by design

The renderer is a client of a separate local Electron session process. Closing the window or exiting the UI does **not** kill the session process, running agent turns or terminal PTYs. Reopen AgentHub to attach to that same process and replay buffered terminal output. The tray menu exposes **Stop all sessions and exit** as a distinct, confirmed action.

Conversations, drafts, exact provider session IDs, selected conversations and window view state are persisted locally. Streaming output and terminal scrollback are checkpointed. A damaged workspace preserves the original and can recover its last valid backup. Interrupted work is marked explicitly; it is never silently retried or resumed into the provider's unrelated "latest" session.

A power loss, OS reboot or explicitly stopping the session service cannot keep a **local OS process** alive. Its saved history remains. Codex and Claude structured chat resume stored provider IDs where supported. ACP resume support is negotiated. Remote terminals use **tmux** so they survive an SSH client disconnect; reboot survival requires the remote machine's own service/session setup. Saved terminal history is clearly distinguished from a live process.

## Add agents

- **Local:** Discover scans known executable/config locations and a small set of loopback API ports. Review any result before adding. It does not launch discovered programs or scan a LAN.
- **Remote:** Machines -> paste `user@host:22` or import `~/.ssh/config` aliases. Open the machine's terminal to verify its host fingerprint and authenticate; then Discover searches only that selected host. Existing SSH keys remain local. A gateway token may be imported from a specific Hermes profile only after approval.
- **Four Hermes profiles:** use four gateway connections (separate loopback ports or profile-specific `/p/<name>/v1` routes). The SSH tunnel stays private. The chat adapter sends stable Hermes transcript/memory headers and saved history. Existing tmux sessions can also be discovered and attached without creating another agent writer.

Remote terminal persistence requires `tmux` on the host; AgentHub does not silently install software. Gateway chat does not require tmux. Docker/WSL custom launchers can be added manually; automatic container inventory is not implemented.

## Adapters

Hermes/custom: OpenAI-compatible chat with full persisted transcript; Hermes gets stable `X-Hermes-Session-Id` and `X-Hermes-Session-Key` headers. OpenClaw: stable per-conversation `user` routing with only the new turn sent. Codex: app-server JSON RPC. Claude Code: streaming CLI with an exact session UUID. Hermes/other ACP agents: negotiated session persistence, permission prompts, and isolated per-conversation state. Any other CLI: terminal-only connection.

The API compatibility layer does not import all pre-existing Hermes server sessions or guarantee reattachment to an HTTP task after a full service failure. A window-only close does not disconnect that task because the session process remains alive. See `docs/SECURITY.md` and `docs/VERIFICATION.md` for boundaries.

## Verification

`npm test` runs offline protocol, security, persistence and actual loopback-HTTP tests. `npm run smoke:restart` launches two actual Electron UI processes in sequence against one isolated session service and real native PTY. The second must recover the same service PID, live terminal, output, conversation and draft. The Windows workflow repeats this against the **installed executable**, then publishes immutable build-tagged installer assets and SHA-256 checksums.

A successful CI run is evidence of native Windows startup/packaging, not evidence that the owner's private VPS accounts and installed provider versions have been tested. No sample agents or credentials are added to production workspaces.
