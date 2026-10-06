# AgentHub code review checklist

Mark each area with `[x]` when its review is complete.
Include the related UI, tests, error handling, and security checks in each review.

Review completed on 2026-10-06 at commit `048421b`.
The checked boxes indicate completed reviews, not corrected defects.
See [CODE_REVIEW.md](../CODE_REVIEW.md) for findings and validation limits.

- [x] **Desktop application and session service** — Startup, shutdown, windows, tray, IPC, and service connections.
- [x] **User interface and navigation** — Home, sidebar, search, settings, dialogs, themes, accessibility, and 3D views.
- [x] **Agent connections and model providers** — Protocol adapters, provider settings, model selection, reasoning effort, and connection handling.
- [x] **Chat and conversation management** — Messages, streaming, approvals, history, summaries, sharing, and Playground.
- [x] **Opaya Agent and schedules** — Built-in assistant, approved tools, local model setup, scheduled messages, and agent cron jobs.
- [x] **Terminals and process management** — Shells, agent CLI sessions, terminal layouts, separate windows, clipboard, and process cleanup.
- [x] **Browser and computer tools** — Browser tabs, agent browser access, cookies, screenshots, screen control, and image support.
- [x] **Projects and files** — Project folders, Git actions, remote project copies, file access, and chat attachments.
- [x] **Machines and SSH connections** — Machine setup, SSH discovery, connection checks, tunnels, and remote bridges.
- [x] **Containers, profiles, and cloning** — Docker management, agent profiles, cloning, deployment, and redeployment.
- [x] **Agent installation and maintenance** — Discovery, installation, version checks, updates, removal, diagnostics, and agent backups.
- [x] **Vault and credentials** — Secret storage, key import, credential sharing, agent access, and encrypted Vault backups.
- [x] **Skills and MCP servers** — Skills library, skill sharing, server configuration, tool connections, and agent integration.
- [x] **Data storage and recovery** — State schemas, validation, saved settings, transcripts, atomic writes, and restart recovery.
- [x] **Builds, releases, and application updates** — Packaging, signing, CI workflows, checksums, update installation, and verification scripts.
