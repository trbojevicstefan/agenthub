# Opaya UX and Navigation Build Plan

Status: implemented. macOS builds and validation are recorded below. Required Herdr reviews remain blocked.

Source baseline: version `0.26.0`, commit `a23717a`.

Scope: terminal navigation, Manage, and Chat navigation.

## Objective

Improve access to the existing features. Make agent management a clear part of the application.

The colleague identifies updates, cloning, and removal as core management functions. He also requests better terminal splitting and navigation.

The sections below retain the approved plan and its source baseline. The final section records implementation and verification results.

## Request and Current Implementation

| Request | Meaning | Baseline implementation |
| --- | --- | --- |
| Features exist; improve UX | Improve access to existing functions. | The application already has extensive management functions. |
| Split left/right and up/down | Create terminal panes and move between them. | Global column, row, and grid arrangements exist. Individual directional splits do not exist. |
| Manage screen | Provide a clear location for agent and server settings. | Agent management has eight sections. Machines has a separate screen. |
| Chat through terminal or UI | Offer graphical chat and native CLI access. | Chat and Console exist, but Console behavior depends on a setting. |
| Management is the core function | Give management actions greater visibility. | Selecting an agent opens Chat. Management actions sit in the secondary sidebar. |

Sources:

- [Terminal renderer](ui/app.js): terminal windows, arrangements, focus, and context handling.
- [Management navigation](ui/app.js): `AN_SECTIONS`, `AN_SUB`, `agentActions()`, and `setAgentMode()`.
- [Terminal service](desktop/terminal.cjs): session creation, reuse, restart, and tmux identity.
- [Saved view](desktop/broker.cjs): `saveView()` and layout validation.

## 1. Consistent Navigation

Give each selected agent three clearly labeled destinations: **Chat**, **Terminal**, and **Manage**.

Use “Terminal” consistently in the interface where the application currently uses “Console.”

Keep the agent's name, machine, and connection status visible across all three destinations.

Remember each agent's last destination. Keep Chat as the initial destination for agents that support graphical chat.

Keep Machines as the location for server management. Link directly to the relevant machine from the agent's header and Manage screen.

Distinguish changing agents, changing destinations, and changing terminal panes. Each action must preserve the other contexts.

### Acceptance Criteria

- Users can open each supported destination through a labeled control.
- Switching destinations preserves the selected agent.
- Returning to an agent restores its last destination.
- Terminal-only agents open Terminal when Chat is unavailable.
- The agent's machine opens directly from its management context.

## 2. Directional Terminal Splits

Add **Split left**, **Split right**, **Split above**, and **Split below** to each pane's controls.

Split the selected pane without rearranging unrelated panes. Support mixed arrangements, such as one large pane beside two stacked panes.

Use a small layout tree with horizontal splits, vertical splits, and terminal leaves. Store the size ratio for each split.

Preserve existing terminal instances when users resize or rearrange panes.

Provide keyboard commands for directional focus, next/previous pane, and pane maximization. Check shortcut conflicts before assigning the final keys.

Make pane separators keyboard accessible. Show the active pane clearly.

Retain separate **Hide**, **Open in separate window**, and **End session** actions.

Keep column, row, and grid arrangements as optional presets.

### Acceptance Criteria

- Each split creates a pane on the requested side of the selected pane.
- Mixed horizontal and vertical splits preserve unrelated panes.
- Layout changes do not restart running terminal processes.
- Keyboard focus moves to the requested neighboring pane.
- Maximizing and restoring a pane preserves its previous layout.
- Hiding a pane keeps its session running.
- Ending a session removes its pane and collapses empty layout branches.
- Resizing respects minimum pane dimensions.

## 3. Independent Terminal Sessions

This step is a prerequisite for useful splitting.

The terminal service currently reuses a live session with the same agent, mode, and folder.

Therefore, opening another shell can return the existing shell instead of creating an independent session.

Add an explicit distinction between **open an existing session** and **create a new session**.

Give independent remote sessions distinct tmux identities. Preserve those identities during reconnection and restart.

Carry the source pane's agent, machine, container, and configured folder into the new session.

Do not promise the shell's current folder unless the application can detect it reliably.

Preserve the existing limit of 12 live sessions. Explain the limit when users reach it.

### Acceptance Criteria

- Splitting a shell creates a distinct session, even with the same agent and configured folder.
- Opening an existing session continues to attach to that session.
- Independent remote sessions use distinct tmux identities.
- Reconnecting a remote session uses its original tmux identity.
- Existing discovered tmux sessions remain attachable.
- Restarting one session does not attach to another matching session.
- A failed session creation leaves the existing layout intact.
- The session limit produces a clear message without creating an empty pane.

## 4. Clear Management Navigation

Reuse the existing sections:

- Model & skills
- Keys & tools
- Machine & Docker
- Deploy & clone
- Projects
- Updates & backups
- Profile & connection
- Danger zone

Give Manage an overview with status, location, version information, and active operations.

Make **Update**, **Clone**, **Back up**, and **Connection settings** easy to find.

Keep **Uninstall** separate from **Remove connection**. Explain the effect of each action.

Explain unavailable actions instead of silently removing them.

Reuse the existing action definitions, capability checks, dialogs, and operation progress.

### Acceptance Criteria

- Users can find the primary management actions from the Manage overview.
- Each action opens the existing workflow for the selected agent.
- Unavailable actions show the reason.
- Uninstall and Remove connection have distinct labels and explanations.
- Existing confirmations and capability restrictions remain effective.
- Running operations remain visible after navigation changes.

## 5. Clear Chat and Terminal Behavior

Make Chat open graphical conversation history and the message editor.

Make Terminal open the agent's terminal workspace.

Add an explicit **Show terminal beside chat** action. Let users place it below or beside Chat.

Keep drafts, selected conversations, scroll positions, and running work when users change destinations.

Show graphical chat only where the agent supports it. Distinguish an agent CLI from a machine shell.

Explain that graphical Chat and the native CLI can use different sessions. Switching views must not imply conversation transfer.

### Acceptance Criteria

- Chat and Terminal open predictable destinations.
- Users can explicitly show a terminal beside or below Chat.
- Navigation preserves drafts and selected conversations.
- Background replies and running operations remain discoverable.
- Terminal-only agents do not show an unusable graphical Chat destination.
- API connections do not offer an unavailable native CLI.
- Pane labels distinguish agent CLI sessions from shells.

## 6. Workspace Persistence

Save terminal layouts, pane sizes, active panes, and visibility separately for each agent context.

Save each agent's selected destination and Manage section.

The current saved view contains one arrangement and a limited pane list.

Add backward compatibility for existing saved layouts.

Restore valid sessions without creating duplicates. Remove stale layout references safely.

### Acceptance Criteria

- Switching agents preserves each agent's layout and active pane.
- Reopening the application restores layouts and destinations.
- Existing saved layouts migrate without losing valid session references.
- Missing or ended sessions do not leave broken layout branches.
- Hidden sessions remain hidden after restoration.
- Separate terminal windows can return to the workspace without duplicating sessions.
- UI restart preserves live sessions owned by the session service.

## Implementation Order

1. Prepare the navigation specification and representative screen sketches.
2. Add explicit creation of independent terminal sessions.
3. Implement directional layouts and pane navigation.
4. Add layout persistence and migration from existing saved views.
5. Connect Chat, Terminal, and Manage navigation.
6. Improve management visibility and unavailable-action explanations.
7. Complete accessibility checks and verification.

## Expected Files

| File | Planned responsibility |
| --- | --- |
| `ui/app.js` | Navigation, management actions, terminal controls, and view restoration. |
| `ui/index.html` | Structural controls and accessible labels. |
| `ui/style.css` | Pane layouts, focus indicators, and responsive navigation. |
| `ui/theme-light.css` | Generated light theme after style changes. |
| `ui/terminal-layout.js` | Proposed small module for layout calculations and directional pane operations. |
| `ui/terminal-core.js` | Terminal shortcut handling where required. |
| `desktop/terminal.cjs` | Independent session creation and persistent remote session identity. |
| `desktop/service.cjs` | Terminal request handling where required. |
| `desktop/broker.cjs` | Saved navigation state, layout validation, and migration. |
| `tests/terminal-mode.test.cjs` | Session and saved-view regression coverage. |
| `scripts/native-features.cjs` | Native UI checks for the current terminal interface. |
| `scripts/native-smoke.cjs` | Current terminal selectors and relevant smoke checks. |

Keep layout calculations small and testable. Reuse the existing renderer, service architecture, and IPC methods where possible.

Do not add dependencies unless implementation demonstrates a clear need.

## Verification Plan

Verify the test configuration before running tests. Use disposable workspaces, mock agents, and loopback services for automated checks.

### Automated Checks

- Test independent session creation and existing-session attachment.
- Test distinct remote session identities and reconnection.
- Test split placement, layout collapse, resizing constraints, and directional focus calculations.
- Test saved layout validation, migration, and stale session references.
- Test restoration without duplicate terminal sessions.
- Test navigation state and draft preservation.

### Native UI Checks

The existing native feature checks still reference terminal tabs that the current interface no longer renders.

Update those checks before using them as evidence for the new behavior.

- Verify directional splits and mixed layouts with real disposable terminal sessions.
- Verify keyboard focus, keyboard resizing, and pane maximization.
- Verify hiding, reopening, ending, and returning separate terminal windows.
- Verify that layout changes preserve terminal output and running processes.
- Verify that navigation preserves drafts and running work.
- Verify graphical agents, terminal-only agents, API connections, and unavailable management actions.
- Verify macOS and Windows shortcuts, including conflicts with terminal input.
- Verify small windows, both themes, and keyboard navigation.
- Verify UI restart against the isolated session service.

### Required Commands

After implementation and test configuration review:

```sh
npm test
npm run check
npm run smoke:restart
```

Regenerate the light theme after changes to source styles:

```sh
node scripts/generate-light-theme.cjs
```

Run the relevant native feature checks in an isolated workspace.

Report missing dependencies or infrastructure as validation blockers. Do not treat static checks as native runtime verification.

## Completion Conditions

- The approved navigation behavior works across Chat, Terminal, and Manage.
- Directional splits create independent sessions where requested.
- Layout and navigation state survive context changes and application reopening.
- Existing management operations retain their behavior and restrictions.
- Relevant automated and native checks pass, or the report identifies specific validation blockers.
- The final report identifies changes, verification results, and remaining limitations.

## Implementation and Verification Results

Implementation date: 2026-10-03.

The changes target `main`. Packaging includes the upstream version `0.27.0` changes through commit `1726395`.

### Implemented Behavior

- Each agent has labeled Chat, Terminal, and Manage destinations where supported.
- The header keeps the agent, machine, and status visible. Chat retains project navigation and the iTrust control.
- Each agent remembers its destination and Manage section.
- Pane controls support left, right, above, and below splits with independent sessions.
- Nested layouts support resizing, presets, directional focus, maximization, hiding, separate windows, and session termination.
- Keyboard separators preserve minimum dimensions. Small workspaces scroll when panes cannot fit.
- Layouts, active panes, visibility, and dock positions persist per agent context.
- Existing saved layouts migrate. Renderer restoration attaches to existing service sessions without duplication.
- Remote sessions receive distinct tmux identities. Reconnection preserves each identity.
- Splits use the source session's agent, mode, and configured folder through the existing terminal service.
- Chat supports an explicit terminal beside or below the conversation.
- Navigation preserves drafts, conversation selection, scroll positions, and background replies.
- Manage exposes Update, Clone, Back up, Connection settings, and Open machine with capability explanations.
- Uninstall and Remove connection keep their existing workflows and confirmations.

The implementation uses the shared Electron application. The same renderer and service changes apply to the macOS and Windows packages.

The packages remain separate operating-system builds. The existing GitHub Actions workflows build and publish previews after a push to `main`.

No application dependencies change. The light-theme generator produces no additional diff.

### Keyboard Controls

Use Command on macOS. Use Control on Windows and Linux.

| Shortcut | Action |
| --- | --- |
| Command/Control + Shift + Arrow | Focus the neighboring pane. |
| Command/Control + Shift + `[` or `]` | Focus the previous or next pane. |
| Command/Control + Shift + Enter | Maximize or restore the active pane. |
| Arrow keys on a focused separator | Resize the adjacent panes. |

The shortcuts apply inside the terminal workspace. Alt and AltGr combinations remain available to terminal programs.

### Verification Results

| Check | Result |
| --- | --- |
| `npm run check` | Pass: 114 JavaScript files and the existing static boundary checks. |
| `git diff --check` | Pass. |
| Focused terminal, persistence, layout, and container tests | Pass: 36 tests. These tests also pass in the final full suite. |
| `npm test` | 310 tests: 307 pass, two fail, one skips. |
| Native feature checks on macOS | Pass: 23 recorded behavior checks after upstream integration with disposable PTYs and a loopback chat service. |
| `npm run smoke:restart` | Pass: live service continuity, saved layout, navigation, hidden sessions, drafts, and conversation identity. |
| Computer-use verification on macOS | Directional splits, keyboard focus, maximization, restoration, and Manage navigation work. Management actions remain visible. |
| Light-theme generation | Pass. Generated output remains unchanged. |

The native checks cover both themes, small windows, all split directions, keyboard resizing, separate windows, and session limits.

They also cover failed splits, legacy migration, background replies, chat scroll restoration, and terminal-only agents.

The two full-suite failures also occur on the unchanged baseline:

- `tests/cli-discovery.test.cjs:27` detects the installed Homebrew OpenCode before the fixture's nvm OpenCode.
- `tests/mcp-skills.test.cjs:33` includes globally installed Hermes skills alongside the disposable fixture.

Neither failure is caused by this implementation. Their environment isolation remains outside this task.

Optional clipboard probes remain incomplete. The restart log reports `pasteText: false` and `clipboard.writeImage is not a function`.

The terminal context-menu paste probe passes. The restart checks do not establish complete clipboard support.

### Blocking Fixes Completed

- A delayed setup scan could replace an agent screen after navigation. Its completion now checks the active destination.
- The container test could select real Docker before its fixture. The test now fixes its PATH and bounds its subprocess duration.
- Interactive verification found delayed sidebar updates after terminal creation. The sidebar now refreshes when the session opens.
- Interactive verification found clipped management actions. Those actions now occupy a separate responsive row below the overview card.

The initial container test started a real local container before the PATH issue was found.

Only that test-created container was stopped and removed after its fixture mount and creation time were verified.

### Remaining Validation Limits

- Windows packaging and installer checks run through the existing Windows GitHub Actions workflow after the push.
- Intel macOS runtime checks use Rosetta locally. The existing macOS workflow also uses an Intel runner.
- SSH and tmux identity checks use mocked processes. No live remote machine was changed.
- Docker inheritance checks use fixtures. No production agent was updated, cloned, uninstalled, or removed.
- The required overengineering and defect reviews remain blocked.

The `make-change` skill requires both Herdr review phases in order.

Herdr reports a compatible client and server, but `herdr pane current --current` returns `pane_not_found`.

The caller pane cannot be resolved. No reviewer starts, and no review pane is created.

### Local Evidence

These paths contain temporary local artifacts. They are not release artifacts.

- Full suite: `/tmp/opaya-test-final.log`.
- Unchanged-baseline comparison: `/tmp/opaya-baseline.log`.
- Native feature log: `/tmp/opaya-features-final.log`.
- Native feature report and screenshots: `/tmp/opaya-features-final.4NJAfo/`.
- Restart verification: `/tmp/opaya-restart-final.log`.
- Review record: `/var/folders/z4/0nw8j5mx5qs2hwwt2yvg2f_00000gn/T/opaya-build-review-oxb4tk7u/record.json`.


## Desktop Packaging

Build version: `0.27.0`.

The integration preserves the upstream Search, Back, Library, and Machines changes.

An added native check opens Manage through Search and returns to Chat through Back.

### Local Artifacts

- `release/Opaya-0.27.0-mac-arm64.dmg`
- `release/Opaya-0.27.0-mac-arm64.zip`
- `release/Opaya-0.27.0-mac-x64.dmg`
- `release/Opaya-0.27.0-mac-x64.zip`
- `release/darwin-arm64-SHA256SUMS.txt`

The repository ignores generated artifacts. The source commit does not include these binaries.

Both applications have ad-hoc signatures. They do not have Apple notarization.

The package checks compare 108 application source files and package metadata against the workspace.

Both comparisons pass. Both DMG checksums pass `hdiutil verify`.

Both packaged applications pass all 23 native feature checks.

The Apple Silicon application passes the packaged restart checks.

The Intel application runs under Rosetta on this Apple Silicon computer.

Its packaged restart checks pass on retry. The first run fails during screenshot capture with `UnknownVizError`.

The full suite after upstream integration retains 307 passes, two existing environment-dependent failures, and one skip.

### Packaging Evidence

- Apple Silicon build: `/tmp/opaya-build-mac-arm64-final.log`.
- Intel build: `/tmp/opaya-build-mac-x64.log`.
- Apple Silicon feature checks: `/tmp/opaya-packaged-arm64-features.log`.
- Intel feature checks: `/tmp/opaya-packaged-x64-features.log`.
- Apple Silicon restart checks: `/tmp/opaya-packaged-arm64-restart.log`.
- Intel restart checks: `/tmp/opaya-packaged-x64-restart-retry.log`.
- Initial Intel screenshot failure: `/tmp/opaya-packaged-x64-restart.log`.
- Integrated source tests: `/tmp/opaya-test-merged.log`.
