# Opaya roadmap

These are plans, not promises. Shipped work is listed in [RELEASE_NOTES.md](RELEASE_NOTES.md).

## Next

- **Condense with Jev (TypeSafe / SafeType model):**
  - Add Jev as a model provider for **Condense** and for the Opaya Agent.
  - If the user has a Jev API key, Condense uses Jev. Without one, it uses the Opaya Agent's model, or else the chat's own agent (the current behavior).
  - The key is stored with OS encryption like other keys, and only its name is shown.
  - Waiting on the provider's API details (base URL, auth, model names).
- **Condense for Opaya Agent chats**, and "continue from essence" as a one-click new session.
- **Share a chat as a file bundle**: Markdown plus attachments, and optionally the essence only.
- **Scheduled redeploys and transfers**, for example "sync skills from Tuco to all VPS agents every night".

## Platform

- A Linux AppImage and deb.
- Code signing on Windows and notarization on macOS, so first launch needs no extra approval.

## Agents and machines

- Import and reattach existing Hermes REST sessions, with version negotiation.
- Automatic inventory of Podman, WSL and remote Docker contexts, not only Docker.
- Credential transfer for Claude Code, Codex and OpenClaw (today only Hermes `.env` keys move).
- MCP servers for Codex (`~/.codex/config.toml`) and for Claude Code over SSH.

## Acceptance on real machines

- Four Hermes profiles on a VPS, verified end to end.
- Live Codex, Claude Code and OpenClaw accounts.
- Passphrase-protected SSH keys on Windows.
- VPS network drops and remote service restarts.
