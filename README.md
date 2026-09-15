# AgentHub

A standalone, local-first desktop hub for your agents and machines. No A2Agent account or service is required.

This repository is being populated with the desktop implementation, persistent conversations, SSH discovery, and a Windows installer pipeline.

## Product contract

- Add local agents or your own SSH hosts; never scan unrelated networks.
- Keep each agent's conversations, drafts, provider session identifiers, and terminal identity separate.
- Closing a window detaches the UI; it must not silently terminate an active session.
- Persist remote terminal sessions through tmux, and show the distinction between saved history and a live process.
- Build and test a real Windows executable, with reproducible source and checksums.

The first implementation is an unsigned preview. Live-provider access and signing require owner credentials and are not implied by a successful build.
