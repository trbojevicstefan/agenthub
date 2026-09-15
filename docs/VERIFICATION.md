# Verification - AgentHub 0.2.0

## Published Windows executable

Verified on 2026-09-15. The installer is a real, unsigned Windows x64 NSIS executable, not a source archive.

- Release: https://github.com/trbojevicstefan/agenthub/releases/tag/v0.2.0-build.2
- Installer: https://github.com/trbojevicstefan/agenthub/releases/download/v0.2.0-build.2/AgentHub-0.2.0-Setup-x64.exe
- Successful run: https://github.com/trbojevicstefan/agenthub/actions/runs/34939077706
- Exact source commit: `d695b8a2a6b0a5bbdd2408050b4df1dc4c969b13`
- Installer size: 120248055 bytes.
- SHA-256: `496292ab85a6c712540f68c1af20b6ae0fbbb218ba917c376bd4984b33e5f580`
- Electron: 44.3.0. Build host: GitHub windows-2022 with Visual Studio 2022 and Python 3.12.

The downloaded artifact ZIP and extracted executable were checked against their recorded SHA-256 values. Release assets include BUILDINFO.json and win32-x64-SHA256SUMS.txt.

## Passed checks

- Linux offline suite: 68 passed, zero failed.
- Windows suite: 66 passed, zero failed, two POSIX-only tests explicitly skipped.
- Windows static/syntax checks: 31 JavaScript files, renderer sandbox checks and standalone boundaries passed.
- Production dependency audit: zero reported vulnerabilities at build time.
- Development Electron: actual UI startup, native PTY output, complete UI process exit, second UI process startup.
- Packaged distribution: NSIS installer built successfully and was silently installed into an isolated Windows directory.
- Installed AgentHub.exe: actual UI startup and real native terminal, followed by the same whole-UI-process restart test.
- Both native test runs retained the SAME session-service PID and SAME live terminal, including output, selected conversation and saved draft.
- Renderer checks passed: sandbox, context isolation, no renderer Node integration, narrow preload bridge, no generic IPC and no horizontal overflow.

The Windows verification artifact contains unit-test logs, dependency logs, native JSON assertions and captured screenshots. Screenshots contain deliberate test fixtures, not discovered user agents. GPU acceleration is disabled only in smoke/host/safe-graphics modes; these checks do not validate every consumer GPU driver.

## Scope and remaining live acceptance

No private user credentials are used in CI. Connections to the owner's four Hermes instances, actual Codex/Claude/OpenClaw accounts, passphrase-protected keys and live VPS interruptions have NOT been tested. Adapter unit tests use explicit protocol fixtures and loopback HTTP servers. The Windows runner is not a substitute for manual testing on the owner's Windows 10/11 computer.

Closing the UI retains local processes in a separate service. Stopping that service or rebooting Windows cannot preserve a local OS process; saved history remains and supported providers can resume stored session identifiers. Remote tmux survives client disconnect, not necessarily VPS reboot. Existing Hermes REST session import, automatic container/WSL inventory, code signing and signed updates are follow-on scope.

This documentation-only commit records the existing binary's evidence and does not change or rebuild that binary.
