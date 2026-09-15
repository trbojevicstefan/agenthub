# Security boundaries

The Electron renderer has context isolation, sandboxing, no Node integration, no webviews, denied navigation/permissions and a small explicit preload API. It cannot invoke arbitrary main-process methods. UI assets are served from an allowlisted local custom protocol with a restrictive CSP; messages and remote names are escaped.

A separate per-user session process owns PTYs, protocols and credentials. The UI connects over a local Windows named pipe or POSIX Unix socket, not a TCP listener. Each request requires a 256-bit random token stored in the per-user profile; Unix directories/files/sockets are restricted to the user. The token is never sent to the renderer. This is not a security boundary against malicious code already running as the same OS user.

API tokens are encrypted by Electron safeStorage/OS credentials. Insecure Linux basic_text storage is refused; users may choose memory-only tokens. SSH private keys remain at their existing paths, interpreted by OpenSSH. Automatic SSH actions require a previously trusted host key. Interactive terminal verification asks the user. SSH agent forwarding is disabled. Gateway forwarding binds only to loopback.

Native agents and terminals can execute commands with their OS account's permissions. Executable configuration and credential import require a native approval. When the UI is absent, new structured-protocol approvals default to deny; ongoing previously-authorized agent work may still continue. The original provider's own sandbox/approval policy remains important. Do not connect untrusted agents or hosts.

Chat transcripts, drafts and terminal scrollback are stored locally in plaintext, just like a terminal log. They can contain sensitive output or secrets typed into a shell. Use full-disk encryption and the OS account's protection. Application diagnostics do not intentionally record API tokens, but error redaction is not a guarantee that arbitrary third-party output contains no secrets. The client does not enable xterm clipboard escape writes or automatic external-link opening.

Normal UI close retains the session process. **Stop all sessions and exit** explicitly terminates local work, with confirmation. Remote tmux is detached rather than deleted. No autonomous LAN scanning, remote software installation, automatic trust-on-first-use or blind task resubmission is performed.

The first Windows release is unsigned. Inspect the repository's immutable build tag, SHA-256 checksums and Actions results. Do not disable system security controls to run it. Code signing and authenticated auto-update are future release requirements, not capabilities claimed by this preview.
