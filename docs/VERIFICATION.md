# Verification - v0.2.0

The offline implementation environment ran **68 Node tests successfully** and syntax/static checks. The tests cover actual loopback HTTP servers, authenticated local IPC, detach/reconnect, atomic storage, draft/session isolation, partial-output checkpoint/recovery, SSH parsing and tmux command construction. PTY and provider protocol unit tests use explicit fixtures.

The Windows workflow is the source of truth for native results. It installs dependencies, records a lockfile, runs tests, launches actual Electron windows and real node-pty shells, builds an NSIS installer, silently installs it into an isolated directory, and repeats the window-restart test against the installed executable. A release is published only if these steps pass. `native-smoke-write.json` and `native-smoke-read.json` report the actual process reuse, terminal output, session, draft and renderer security assertions.

No private user credentials are used in CI. Live VPS discovery, provider account authentication and the user's own SSH config cannot be verified from the offline test environment. Screenshot data in smoke runs is deliberately test-only, not the user's discovered inventory.
