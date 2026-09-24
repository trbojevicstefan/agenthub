# Opaya desktop architecture

`Electron UI -> narrow preload IPC -> authenticated local pipe -> independent Electron session service -> agent adapters / node-pty / OpenSSH`

The visible app is detachable. `desktop/main.cjs` attaches through `host-client.cjs` to the existing per-user service or starts it once. `service.cjs` owns Broker, Vault and Terminals without creating a BrowserWindow. `wire.cjs` implements bounded, token-authenticated JSON-line RPC and pushes snapshots/terminal events. No network-facing daemon port is opened.

`broker.cjs` keeps per-agent protocol adapters and per-conversation native session IDs. Sending twice to the same busy agent is rejected before asynchronous work begins. Disk state uses an ordered write queue, atomic replace and fsync; streaming output is checkpointed. A full service failure leaves interrupted work marked for explicit inspection rather than automatic retry.

`terminal.cjs` retains actual native PTYs while UI clients disconnect. Bounded scrollback and monotonic sequence numbers allow replay without duplicate events when a new UI attaches. Remote terminals execute tmux attach/create through the user's existing OpenSSH client. Existing discovered tmux sessions are attached, not overwritten.

Adapters are deliberately small: HTTP chat, ACP, Codex app-server and Claude streaming CLI. Credentials remain in the service. Native approval decisions are requested from a currently attached UI and deny on timeout/detachment. The service does not impersonate a provider account or centralize third-party subscriptions.

Feature modules added since 0.5 live next to the broker in the session service: `opaya-agent.cjs` (built-in assistant with approved tools), `skills.cjs` and `mcp.cjs` (skills and MCP servers), `projects.cjs` (project folders, git and gh), `clone.cjs` (tar streams between this computer, SSH and containers), `transfer.cjs` (skills, `.env` keys and the global skills library), `condense.cjs` (chat essence), `browser.cjs` and `browser-mcp.cjs` (the Opaya browser and its MCP bridge) and `updater.cjs` (GitHub releases with checksum verification). Long operations run as background jobs whose progress is pushed to the UI, so they are not bound by an IPC timeout.
