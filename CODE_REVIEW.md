# AgentHub code review

Review date: 2026-10-06.
Source: `main`, commit `048421b469af6cc37eab21c6f9a61f95297ce610`, version `0.31.0`.

The review covers all 15 areas in [the checklist](docs/CODE_REVIEW_CHECKLIST.md).
Four agents, including the lead reviewer, performed the review.
The review identifies 21 confirmed defects: five P1, fifteen P2, and one P3.
The application code remains unchanged.

P1 identifies an urgent security or correctness defect.
P2 identifies a functional defect that needs correction.
P3 identifies a defect with limited impact.

## Findings

### F01 — P1: ACP command arguments can bypass approval

Location: [desktop/adapters/acp.cjs:60–64](desktop/adapters/acp.cjs#L60-L64).

The automatic approval check searches the tool title and `rawInput` for Opaya tool names.
A shell command containing `opaya-browser` therefore bypasses approval when iTrust is disabled.
The check can select `allow_always` for that command.

Evidence: A fake ACP request used `kind: 'execute'` and a command containing `printf opaya-browser`.
The approval callback always denied requests.
The adapter never called it and returned the `allow_always` option.
The probe did not execute the command.

Correction: Identify trusted tools through verified tool metadata.
Do not use titles or command arguments to establish tool identity.

### F02 — P1: Transfer filenames can execute commands through tar

- [x] Fixed on 2026-10-06 in both archive producers, for local and remote commands.

The producers put `--` before member paths and prefix filenames that start with `-` with `./`.
The prefix also prevents macOS tar from interpreting `-C` after `--`.
Regression tests verify filenames, contents, and transfer exclusions through real tar operations and a local SSH substitute.

Locations: [desktop/clone.cjs:70–73](desktop/clone.cjs#L70-L73) and [desktop/maintenance.cjs:296–298](desktop/maintenance.cjs#L296-L298).

The archive producers pass filenames to `tar` without an option terminator.
The project copy path gets these names from `readdir()` in [desktop/remote-work.cjs:168–173](desktop/remote-work.cjs#L168-L173).
A filename beginning with a supported tar option can therefore change the command behavior.

Evidence: A disposable project contained a file named `--use-compress-program=touch REVIEW_MARKER`.
The transfer created `REVIEW_MARKER` in a disposable working directory.
The transfer then failed, but the command had already executed.
The reproduction used local macOS tar.

Correction: Put `--` before member paths in both archive producers.
Apply this correction to the local and remote commands.

### F03 — P1: Updating a CLI Docker clone replaces it with Hermes

Location: [desktop/maintenance.cjs:109–114](desktop/maintenance.cjs#L109-L114).

The update code treats every managed Docker clone as a Hermes container.
The update removes the existing container and recreates it with `nousresearch/hermes-agent`.
Codex, Claude Code, OpenCode, and DeepSeek Harness clones can enter this branch.
Their saved connections then target the wrong framework.

Evidence: A valid Codex clone produced commands that pull the Hermes image, remove the Codex container, and start Hermes.
The generated command also replaces the expected data mount with `/opt/data`.
The probe inspected commands without executing Docker.

Correction: Restrict the Hermes recreation branch to Hermes.
Use the existing framework-specific update paths for other clones.

### F04 — P1: Symbolic links bypass file disclosure restrictions

Locations: [desktop/attachments.cjs:85–90](desktop/attachments.cjs#L85-L90), [desktop/files.cjs:62–64](desktop/files.cjs#L62-L64), and [desktop/opaya-agent.cjs:1109](desktop/opaya-agent.cjs#L1109).

The file checks inspect the requested path, but the reads follow symbolic links.
The file reader returns the unresolved path, so the second secret check also misses the target.
An ordinary project filename can expose a protected file to the model.
The same method bypasses attachment restrictions for Opaya data files.

Evidence: The actual `read_file` tool rejected a disposable `.netrc` file.
It returned the synthetic password through a `readme.txt` link, including after output redaction.
A separate attachment probe blocked a direct `vault.json` path but accepted its link.

Correction: Check both the requested path and the resolved path before reading.
Apply equivalent checks to remote reads and attachment restrictions.

### F05 — P1: Stop permits later Opaya Agent tool calls

Location: [desktop/opaya-agent.cjs:409–414](desktop/opaya-agent.cjs#L409-L414).

The HTTP tool loop does not check cancellation between tool calls.
If the user selects Stop while one tool waits, the next tool still runs.
With iTrust enabled, a later command can run without another approval.
The approval helper also lacks a cancellation check after its wait.

Evidence: An isolated model response contained `read_notes`, followed by `write_notes`.
The probe paused `read_notes`, called `stop()`, and then released the first tool.
The real `write_notes` implementation changed a disposable file after Stop.

Correction: Check cancellation before each tool and after approval waits.
Prevent further actions when the current turn has stopped.

### F06 — P2: OpenClaw copies retain tokens when keys are excluded

Locations: [desktop/clone-cli.cjs:30–48](desktop/clone-cli.cjs#L30-L48) and [desktop/maintenance.cjs:281–286](desktop/maintenance.cjs#L281-L286).

The exclusion lists omit `openclaw.json`.
That file contains `gateway.auth.token`, which [desktop/credentials.cjs:18–22](desktop/credentials.cjs#L18-L22) reads as a credential.
Clones and backups therefore retain the gateway token when the user excludes keys.
The backup metadata still reports that keys are excluded.

Evidence: A disposable OpenClaw configuration contained a synthetic gateway token.
Both `clone-cli.copy()` and `maintenance.backup()` retained the complete token with `keys: false`.

Correction: Remove credential fields when keys are excluded.
Alternatively, exclude the file and explain the required configuration step.

### F07 — P2: Container profiles fail after copying their files

Location: [desktop/discovery.cjs:9–12](desktop/discovery.cjs#L9-L12).

Docker connection fingerprints omit the effective profile home and OpenClaw model.
These values distinguish profiles inside one container.
The new profile consequently matches the base connection.
The broker rejects it after the clone has copied its files.

Evidence: A Codex profile with `HOME=/root/opaya-profiles/reviewer` produced the base container fingerprint.
Saving it returned `This connection already exists as Codex box.`
An OpenClaw profile also produced the base fingerprint.
The copy precedes the save in [desktop/broker.cjs:314–317](desktop/broker.cjs#L314-L317).

Correction: Include the profile home and OpenClaw model in Docker connection identity.
Check for duplicate identity before copying files.

### F08 — P2: The remote bridge corrupts split UTF-8 characters

Location: [desktop/remote-bridge.cjs:98](desktop/remote-bridge.cjs#L98).

The bridge decodes each received buffer separately.
A buffer boundary can split a UTF-8 character.
The resulting replacement characters change MCP arguments, paths, or text.

Evidence: A stub connection received one JSON message in two buffers, split inside `€`.
The bridge changed `/tmp/€uro.txt` to `/tmp/���uro.txt`.

Correction: Use one `StringDecoder` per connection.
Alternatively, retain bytes until a complete message is available.

### F09 — P2: Refreshing ACP models can select the wrong project folder

Locations: [desktop/adapters/acp.cjs:99–107](desktop/adapters/acp.cjs#L99-L107) and [desktop/adapters/acp.cjs:180–182](desktop/adapters/acp.cjs#L180-L182).

`listModels()` prepares a session in the agent's default folder.
The next new conversation reuses that session without checking its folder.
Opening the model picker before a project message can therefore select the wrong working directory.
The agent can read or change another project's files.

Evidence: A fixture refreshed models in `/default-project`, then requested a conversation in `/selected-project`.
The only `session/new` request used `/default-project`.

Correction: Record the prepared session's working directory.
Reuse it only when that directory matches the conversation.

### F10 — P2: Early Codex cancellation permits stale turn events

Locations: [desktop/adapters/codex.cjs:113–123](desktop/adapters/codex.cjs#L113-L123) and [desktop/adapters/codex.cjs:78–87](desktop/adapters/codex.cjs#L78-L87).

Stop can occur before `turn/start` returns its turn ID.
The adapter then clears the active turn without sending an interrupt.
The late response does not interrupt the earlier turn.
Notifications check the thread ID without checking the turn ID.
An earlier turn can consequently change or complete the next turn in that thread.

Evidence: A fake Codex process delayed the first start response until after cancellation.
The adapter sent zero interrupts.
Earlier-turn events inserted `OLD TURN OUTPUT` into the second turn and completed it.

Correction: Retain cancellation until the start response supplies the turn ID.
Interrupt that turn and reject notifications for other turn IDs.

### F11 — P2: A display change can prevent default model changes

Locations: [desktop/broker.cjs:225–237](desktop/broker.cjs#L225-L237) and [desktop/broker.cjs:464–472](desktop/broker.cjs#L464-L472).

Connected adapters retain the original agent object.
Pinning, renaming, or regrouping an agent replaces that object.
A later default model change updates only the replacement object.
The UI shows the new model, but requests still use the previous model.
`moveAgent()` has the same reference problem.

Evidence: A real `HttpAdapter` used an injected fetch implementation.
After connecting, pinning, and changing the model, the UI showed `new-model` while the request contained `old-model`.

Correction: Preserve the agent object's identity during display changes.
Alternatively, update the connected adapter's reference whenever the broker replaces the object.

### F12 — P2: Restart re-enables disabled Vault access

Location: [desktop/broker.cjs:53–54](desktop/broker.cjs#L53-L54).

The Vault switch saves `settings.vaultMcp: false`.
Broker initialization reconstructs settings without that property.
The MCP configuration treats the missing property as enabled.
Agents receive the Vault server again after a service restart.

Evidence: A disposable workspace saved `vaultMcp: false`.
A fresh broker restored the value as `undefined` and attached `opaya-vault`.

Correction: Preserve `vaultMcp` during initialization, with the intended default.

### F13 — P2: Restart can omit the active chat transcript

Location: [desktop/broker.cjs:62–64](desktop/broker.cjs#L62-L64).

Initialization loads the latest 100 conversations and the conversations in docked windows.
It can omit an older active conversation.
The initial snapshot retains its ID but lacks its transcript.
The chat therefore appears empty until the user selects it again.
The transcript remains on disk.

Evidence: A disposable workspace contained 101 conversations and selected the first conversation.
Its saved transcript contained a message, but the initial snapshot omitted that transcript.

Correction: Always load the active conversation during initialization.
Apply interrupted-turn recovery to its transcript too.

### F14 — P2: Deleting a Claude chat retains its native session

Location: [desktop/opaya-agent.cjs:294–299](desktop/opaya-agent.cjs#L294-L299).

Deleting the active Opaya Agent chat changes the visible chat without clearing `claudeSessionId`.
`runClaude()` then resumes the deleted chat's native session.
The next message uses context that does not match the visible chat.

Evidence: A disposable fixture created chats A and B, then deleted active chat B.
The active chat changed to A, but the Claude session ID remained B's ID.
The resume argument uses that ID in [desktop/opaya-agent.cjs:522–524](desktop/opaya-agent.cjs#L522-L524).

Correction: Clear the Claude session ID when deleting the active chat.

### F15 — P2: Changing a schedule's agent prevents its next message

Locations: [desktop/schedules.cjs:53–57](desktop/schedules.cjs#L53-L57) and [desktop/service.cjs:259–261](desktop/service.cjs#L259-L261).

The schedule editor permits changing the target agent.
The saved schedule retains the previous agent's conversation ID.
The runner selects that conversation by ID without checking its owner.
The broker then rejects the scheduled message.

Evidence: A fixture changed a schedule from agent A to agent B after creating its conversation.
The next send returned `Conversation does not belong to this agent.`

Correction: Clear the conversation ID when the target agent changes.
Also verify conversation ownership in the runner.

### F16 — P2: A Sunday schedule runs on Monday

Location: [ui/app.js:2642–2643](ui/app.js#L2642-L2643).

The weekly schedule conversion uses `Number(f.day) || 1`.
Sunday has value `0`, so the conversion replaces it with Monday's value `1`.

Evidence: The actual `cronOf()` function received `when: 'week'`, `day: '0'`, and `time: '09:00'`.
It returned `0 9 * * 1`.

Correction: Preserve zero as a valid day value.
Use the default only when the selected value is missing or invalid.

### F17 — P2: The MCP listing omits IDs required for management

Location: [desktop/opaya-agent.cjs:1120](desktop/opaya-agent.cjs#L1120).

`list_mcp_servers` returns names and configuration but omits each saved server ID.
The enable, disable, remove, and transfer tools require those IDs.
The Opaya Agent cannot obtain them through the supplied listing tool.

Evidence: A fixture saved a server, called the listing tool, and received no ID.
Using its returned name as the ID failed in `setAgentMcp()`.

Correction: Return each server's saved ID alongside its name.

### F18 — P2: Update write failures leave the download pending

Location: [desktop/updater.cjs:77–80](desktop/updater.cjs#L77-L80).

The download code does not handle the output stream's `error` event.
Its backpressure wait listens only for `drain`.
A disk error bypasses the normal error state and can leave the download pending.
The application invokes this code in the main process.

Evidence: A stub writable stream emitted `ENOSPC` during backpressure.
Without an outer exception handler, the Node probe exited with an uncaught error.
With an outer handler, the promise remained pending and the status remained `downloading`.
Native Electron failure behavior remains unverified.

Correction: Propagate stream errors through the download promise, including backpressure waits.
Close the stream and remove the incomplete file after failure.

### F19 — P2: Separate terminal windows lose initialization events

Location: [ui/terminal-window.js:9–20](ui/terminal-window.js#L9-L20).

The window reads its terminal state and awaits a snapshot before subscribing to events.
Output and exit events during that interval disappear from the window.
A lost exit event leaves the window marked as live.
The Enter restart action then remains unavailable.

Evidence: A VM fixture emitted final output and an exit during the snapshot request.
The window displayed only the earlier buffer and retained `exited: false`.

Correction: Subscribe before requesting the initial state.
Buffer events and replay those newer than the returned sequence.

### F20 — P2: Browser addresses with hostname ports fail

Location: [desktop/browser.cjs:10–11](desktop/browser.cjs#L10-L11).

The address normalizer treats `localhost:3000` and `example.com:8443/path` as existing URL schemes.
It then rejects them.
The browser tool advertises the first format, and the address field passes it unchanged.

Evidence: Direct calls rejected both addresses.
`127.0.0.1:3000` and `http://localhost:3000` succeeded.

Correction: Recognize hostname and port inputs before checking other URL schemes.

### F21 — P3: The Opaya Agent loses its terminal layout

Locations: [desktop/broker.cjs:191](desktop/broker.cjs#L191) and [ui/app.js:4270](ui/app.js#L4270).

The renderer uses the reserved terminal context `opaya`.
The persistence and restoration filters accept only contexts in the normal agent list.
The Opaya Agent is absent from that list.
Its terminal windows remain, but their split layout, ratios, dock position, and active pane reset.

Evidence: A `Broker.saveView()` fixture preserved `agent_1` and removed `opaya` from saved terminal workspaces.

Correction: Accept the reserved `opaya` context in both filters.

## Review coverage

Each row includes relevant callers, UI paths, and existing tests.
Completed review does not mean that the area has no defects or that native behavior passed validation.

| Area | Main inspected code | Findings |
| --- | --- | --- |
| Desktop application and session service | `main.cjs`, `preload.cjs`, `service.cjs`, `host-client.cjs`, `wire.cjs`, `rpc.cjs` | Related findings F01, F05, F12, F18; no separate finding |
| User interface and navigation | `ui/app.js`, themes, dialogs, navigation, `stage3d.js` | F16, F21 |
| Agent connections and model providers | All adapters, `broker.cjs`, `providers.cjs`, `effort.cjs` | F01, F09, F10, F11 |
| Chat and conversation management | Broker conversations, adapter turns, `condense.cjs`, chat UI | F10, F13, F14 |
| Opaya Agent and schedules | `opaya-agent.cjs`, `opaya-tools-mcp.cjs`, `free-model.cjs`, `schedules.cjs`, service actions | F05, F14, F15, F16, F17 |
| Terminals and process management | `terminal.cjs`, `process.cjs`, `clipboard.cjs`, terminal renderer modules | F19, F21 |
| Browser and computer tools | Browser modules, cookie import, SQLite reader, `screen.cjs`, `vision.cjs` | F08, F20 |
| Projects and files | `projects.cjs`, `remote-work.cjs`, `files.cjs`, `attachments.cjs` | F02, F04 |
| Machines and SSH connections | `vps.cjs`, `tunnel.cjs`, `remote-bridge.cjs`, process helpers | F08 |
| Containers, profiles, and cloning | Container modules, `profiles.cjs`, both clone modules, discovery identity | F03, F07 |
| Agent installation and maintenance | Discovery, catalog, toolchain, management, maintenance, updates, versions, diagnostics | F02, F03, F06 |
| Vault and credentials | `store.cjs`, `secrets.cjs`, Vault modules, credential import, secret actions, key transfer | F04, F06, F12 |
| Skills and MCP servers | `skills.cjs`, `mcp.cjs`, `mcp-config.cjs`, `transfer.cjs`, MCP bridges | F01, F17 |
| Data storage and recovery | `store.cjs`, `schema.cjs`, broker initialization, saved views, assistant sessions | F12, F13, F14, F21 |
| Builds, releases, and application updates | Package configuration, CI workflows, updater, signing, checksum and verification scripts | F18 |

No additional confirmed defects emerged from the inspected paths.
The review excludes style preferences and unverified defect candidates.

## Validation and limits

- `npm run check` passes. It checks 123 JavaScript files and the configured static boundaries.
- `npm test` reports 324 tests: 320 pass, two fail, and two skip.
- Isolated probes reproduce the reported failure conditions with disposable files, fake protocol processes, VM fixtures, or dependency stubs.
- The report distinguishes generated commands from executed operations.

The two suite failures depend on the local environment:

| Test | Observed cause | Required test correction |
| --- | --- | --- |
| `tests/cli-discovery.test.cjs:27` | Discovery selects installed `/opt/homebrew/bin/opencode` before the fixture's nvm executable. | Isolate executable lookup from installed tools. |
| `tests/mcp-skills.test.cjs:33` | Hermes skill lookup includes the user's default skills alongside the disposable profile. | Isolate all skill roots in the fixture. |

These failures do not establish separate application defects.
The full test suite does not pass in this environment.
The review does not change the environment or the tests to force a passing result.

The reviewers did not execute live provider calls, SSH operations, Docker operations, installations, or production actions.
They did not run the installed application, native UI checks, packaging, signing, or update installation.
Native window behavior, real browser cookies, GPU behavior, external protocol compatibility, and Windows execution remain unverified.
The reported reproductions do not replace those acceptance checks.
