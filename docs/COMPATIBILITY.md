# Compatibility and Verification

AgentHub targets independent installations, not a particular owner's machines.
Private deployments are integration examples. Their hostnames, credentials,
container names and model choices must never become production defaults.

## Support Matrix

| Layer | Implemented | Verification and limits |
| --- | --- | --- |
| Desktop | Windows, macOS and Linux packaging definitions | Windows x64 installer and Electron UI tested locally. macOS/Linux releases still need native validation. |
| Execution | Local process, verified SSH, Docker exec | Windows CLIs and Linux SSH/Docker tested. Local Docker command construction is covered; Docker Desktop still needs native end-to-end testing. |
| Chat | OpenAI-compatible HTTP/SSE, ACP, Codex app-server, Claude stream-json | Contract tests plus real authenticated agents. Versions can add or remove capabilities. |
| Models | HTTP catalog, Hermes authenticated model inventory, ACP session models, Codex model list, explicit Claude model ID | Models advertised by a provider are not proof that the current account can use or afford them. |
| Gateway | Hermes/OpenClaw native status and restart; Hermes s6 profile service detection | Preserve explicit executable, user and profile settings. No generic restart for arbitrary hosted APIs. |
| Terminal | PTY input, resize, window detach/dock, tab rename/close, remote tmux | Local Windows UI tested, Linux tmux tested. POSIX shell and tmux prerequisites must be reported clearly. |
| Persistence | Saved transcripts, drafts, terminal history, exact external session IDs | ACP resume depends on the server's negotiated capabilities. Saved output is not a live process. |

## Rules for New Integrations

- Keep provider protocol, execution transport and gateway lifecycle separate.
- Discover capabilities and profile metadata; retain explicit configuration overrides.
- Keep deployment-specific diagnostics outside the packaged application.
- Do not infer that an installed CLI means a running, authenticated gateway.
- Never turn an unavailable API into a successful chat connection, or silently change providers/models after billing or authentication errors.
- Add contract coverage for failures, cancellation, reconnect and session isolation.
- Mark unsupported operations explicitly instead of guessing a service or killing unrelated processes.

## Next Coverage

1. Docker Desktop, Podman, WSL, SSH jump hosts and remote Docker contexts.
2. Windows/macOS/Linux native packaging and keyboard/terminal verification in CI.
3. Stopped containers, rootless runtimes, arbitrary mount paths, users and profile layouts.
4. Optional management adapters for systemd, launchd, Windows services and other supervisors.
5. Proxy/TLS/auth variants, token rotation, offline startup, rate limits and expired logins.
6. Version negotiation, model capability changes, unavailable models and interrupted streaming.

Passing one deployment's tests does not establish universal support. This matrix
should change only when implementation and verification justify the claim.
