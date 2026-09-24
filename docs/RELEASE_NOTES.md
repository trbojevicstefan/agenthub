# Opaya 0.3.0 - Windows and macOS preview

**One place. All your agents.** AgentHub is now **Opaya** ([opaya.dev](https://opaya.dev)).

- New name, icon and animated brand mark. Existing AgentHub workspaces are reused automatically; stop all sessions from the tray before upgrading on Windows.
- macOS build (Apple Silicon and Intel DMG/ZIP), ad-hoc signed, not notarized: right-click > Open on first launch.
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
