# Opaya Sync Between the Desktop App and the Web App

Status: built on 17 October 2026 (`desktop/sync.cjs`, `web/src/sync.ts`). Two changes from the first version of this plan are marked **Changed**.

## Objective

A user with a plan that includes sync (Pro and higher) sees the same machines, agents, MCP servers, chats and chosen Vault keys in the desktop app and in the web app.

Sync is off until the user turns it on in the desktop app (Settings > Account > **Sync with the web app**). The web app always syncs when the plan allows it.

## Model

The web server keeps one copy of the synced data for each organization. The desktop app and the user's web runtime are two clients of that copy. They never talk to each other directly.

A **record** is one synced item:

| Field | Meaning |
| --- | --- |
| `kind` | `host`, `agent`, `conversation`, `transcript`, `secret` or `settings` (`mcp` is reserved) |
| `id` | The item's own ID (the same on both sides; Opaya IDs are UUIDs) |
| `rev` | The organization's change counter when the server stored this version |
| `deleted` | `true` for a deleted item (a tombstone) |
| `data` | The item, or `null` for a tombstone |

The server keeps one counter for each organization. Each stored change gets the next value. A client asks for everything after the last `rev` it saw.

## What Syncs

| Kind | Data | Rules |
| --- | --- | --- |
| `host` | name, hostname, username, port | No identity file and no OpenSSH alias: the desktop key never leaves the desktop. A host with only an alias does not sync. |
| `agent` | the saved connection | Only agents on a machine (SSH, also in Docker there) and HTTP API agents with a public address. Agents on "this computer" do not sync. |
| `conversation` | title, agent, project, times | Only for synced agents. |
| `transcript` | the messages | Text only, no attachments. The newest messages up to 1 MB. |
| `secret` | name, the service address, notes | Only Vault keys marked **Sync to web**. The value goes to the web server's KMS store through its own call, never in a record. |
| `settings` | send key, tips, notifications | A fixed list of interface settings. |

**Changed:** MCP servers do not sync in v1. A stdio MCP server starts a program on the machines where agents run, and Opaya asks the user to trust it on each computer ("Trust this MCP server?"). A background sync cannot ask that question at the right time.

What does not sync: MCP servers, the desktop SSH key, Vault keys not marked for sync, agent connection tokens (they are Vault keys), agents on "this computer", the Opaya Agent's own chats, schedules, projects with local folders, and the skills library files.

Secret values sync in one direction only: from the desktop app to the web app. A key added in the web app stays there.

## Changes and Conflicts

- A client finds its changes by hashing each record's data and comparing it with the hash of the last version it synced (kept in `sync-state.json`).
- Each sync round first pulls, then applies the remote records, then pushes the local changes. So a client pushes only after it has seen the newest remote versions.
- If two clients change the same record between two rounds, the version the server receives last wins (last writer wins, for each record). The other version is lost. This is acceptable for v1: one person uses both clients.
- A remote change to an agent with an active turn, or a new address for a machine with an active turn, waits for the next round. A new name applies at once.
- A synced change keeps the agent and chat that are open, and disconnects an agent only when its connection changed.
- Records come in change order, so a chat can come before its agent. A record whose machine, agent or chat is not there yet waits for the end of the same round.
- A record that cannot be applied (for example a newer app's data, or the 2000-chat limit) is skipped. Its children are skipped too. The sync status shows the number. It is tried again when it changes on the server.
- An item that stops syncing but stays here (a machine with only an alias now, an agent moved to this computer) is not deleted on the server. The other app keeps its copy, and changes from the server leave the local item as it is.
- Messages of the same chat merge by message ID, so a chat used on both sides loses no message.
- **Changed:** trust stays on each computer. A synced agent with a new or changed executable (also the same one on another machine) is saved with `trustPending`, and Opaya asks "Trust this agent executable?" before its program first runs there (a connection or its CLI in a terminal). This holds on both sides, so a changed record on the server cannot start a new program on the user's machines without the user. iTrust (approve tool requests automatically) does not sync.

## Deletes

- Deleting an item makes a tombstone (`deleted: true`). A client that gets a tombstone deletes the item.
- The server keeps tombstones for 90 days. A client whose last `rev` is older than the oldest tombstone the server still has gets `reset: true` and downloads everything again; local items that the server does not have are pushed again only if they changed after the reset.

## Limits

- A record's data: 256 KB at most; a transcript: 1 MB (older messages are left out of the synced copy).
- One push: 500 records and about 8 MB at most (the server takes 16 MB). One pull page: 500 records.
- An organization: 100 MB of record data. A push over the limit is refused with HTTP 413, and the client shows the error.
- Sync needs `features.sync` in the entitlements. Without it, the server answers HTTP 403 and the client stops syncing until the plan changes.

## Transport and Timing

- Desktop app: `GET /api/sync?since=<rev>` and `POST /api/sync` with its desktop session (the desktop allowlist includes them), and `POST /api/sync/secrets` for key values.
- Web runtime: the same operations over its per-user Unix socket (the Vault socket), so it needs no credentials.
- Each client syncs at start, every 60 seconds, and 5 seconds after a local change.

## Acceptance Criteria

- A machine and an SSH agent added in the desktop app appear in the web app within one round, and the reverse.
- Deleting an agent on one side deletes it on the other.
- A chat with a synced agent shows the same messages on both sides.
- A Vault key marked **Sync to web** is in the web runtime's Vault; an unmarked key is not.
- With a Free plan, the server refuses sync, and nothing changes on either side.
