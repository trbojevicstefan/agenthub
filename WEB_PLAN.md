# Opaya Web App, Accounts and Plans

Status: built on 17 October 2026, except the steps that need the VPS, Google Cloud and Stripe accounts (Phase 1 steps 7 and 8, and the Phase 2 deploy): follow `deploy/README.md`. See [Phase 1 Result](#phase-1-result) and [Phase 2 Result](#phase-2-result).

Source baseline: version `0.35.0`, commit `d5c4547`, 17 October 2026.

Scope: accounts and login, Stripe plans and subscriptions, desktop sign-in, plan limits, server secrets, and a web version of the app.

## Objective

Add a web app at `app.opaya.dev` that has the functions of the desktop app, where a browser and a server allow them.

Only the web app creates accounts and sells plans. The desktop app signs in through the web app. It cannot create accounts or buy plans.

The desktop app stays local-first. It works without an account, as it does today.

## Decisions

| Topic | Decision |
| --- | --- |
| Where web agents run | Only on the user's own machines (SSH, and Docker on those machines) and as HTTP API agents. The server runs no agents for users. |
| Desktop login | Optional. Without an account, the desktop app has the Free limits. |
| Desktop sign-in | The better-auth `deviceAuthorization` plugin (RFC 8628). The desktop app opens the web page in the system browser. |
| Account creation and checkout | Web app only. The server also refuses these requests from desktop sessions. |
| Plans | Free, Pro, Fleet. Team comes later. See [Plans](#3-plans-and-subscriptions). |
| Web app access | Pro and higher. |
| Trial | 14 days of Pro, with no card. |
| Over the host limit | Current hosts keep working. The app blocks only new hosts. |
| Billing owner | An organization. Each user gets one personal organization now, so Team needs no data migration later. |
| Payments | Stripe, through the US company, with `@better-auth/stripe`. |
| Login methods | Email and password, GitHub, Google, and two-factor (TOTP). |
| Email sender | Resend. |
| Hosting | One Hostinger VPS for the web server and Postgres (Docker). |
| App secrets | Google Secret Manager. |
| User secrets | Google Cloud KMS envelope encryption. Postgres keeps the ciphertext. |
| Vault sync | Each key syncs only when the user marks it "Sync to web". |
| SSH from the web | A new web SSH key for each user. The desktop SSH key never leaves the desktop. |
| Isolation | One container for each active user. |
| Web stack | TypeScript and Hono in `web/`, an npm workspace. The Electron app stays at the repository root. |
| Web UI | The same `ui/` files, with a WebSocket version of `window.agenthub`. |
| Opaya browser | Not in the web app at first. |
| Order | Phase 1: accounts, billing and desktop sign-in, for the commercial launch. Phase 2: the web app. |

## Architecture

```
                         app.opaya.dev (Hostinger VPS)
 Browser ──HTTPS/WSS──▶ Caddy ──▶ web (Hono, TypeScript)
                                   ├─ better-auth  /api/auth/*  ──▶ Postgres (Docker)
                                   ├─ Stripe webhook /api/auth/stripe/webhook
                                   ├─ /api/entitlements (signed token)
                                   ├─ account pages: /signup /login /pricing /account /billing
                                   ├─ /app: the ui/ files + WebSocket transport        (Phase 2)
                                   └─ launcher ──▶ runtime container per active user   (Phase 2)
                                                    └─ session service ──SSH──▶ user's machines
 Desktop app ──HTTPS──▶ /api/auth/device/*, /api/entitlements
 web ──▶ Google Cloud: Secret Manager (app secrets), KMS (user secrets), Cloud Storage (backups)
 web ──▶ Stripe, Resend
```

## Repository Layout

Make the root `package.json` an npm workspaces root. It stays the Electron app, so `electron-builder`, the CI workflows, `scripts/` and `tests/` keep their paths.

```
agenthub/
  package.json        Electron app and workspaces root ("workspaces": ["web"])
  desktop/            Electron main process and session service
  ui/                 UI, shared by the desktop app and the web app
  web/                new: TypeScript, Hono, better-auth, Stripe
    src/server.ts       Hono app, routes
    src/auth.ts         better-auth configuration
    src/plans.ts        plan names, Stripe price IDs, limits
    src/entitlements.ts signed entitlement tokens
    src/secrets.ts      Secret Manager loader (Phase 1), KMS secret store (Phase 2)
    src/pages/          account pages (Hono JSX)
    test/
  deploy/             new: docker-compose.yml, Caddyfile, backup script
```

`electron-builder` packs only the dependencies of the Electron app. A test checks that no `web/` dependency reaches the desktop package.

At first, `web/` imports modules from `desktop/` directly. A module moves to a shared package only when it needs two implementations.

## 1. Web Server and Database

- The server is one long-running Node process with Hono. It keeps WebSockets, so a serverless platform is not used.
- Postgres runs in Docker on the same VPS. better-auth connects through a `pg` pool. No ORM.
- The better-auth CLI creates and migrates the better-auth tables.
- Caddy terminates TLS for `app.opaya.dev`.
- At start, the server reads its secrets from Google Secret Manager: `BETTER_AUTH_SECRET`, `DATABASE_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, the GitHub and Google OAuth secrets, and the entitlement signing key.
- The VPS uses one Google Cloud service account key file to reach Google Cloud. Only root can read the file. The service account has only these roles:
  - `roles/secretmanager.secretAccessor` on the listed secrets;
  - `roles/storage.objectCreator` on the backup bucket;
  - in Phase 2, `roles/cloudkms.cryptoKeyEncrypterDecrypter` on one KMS key.
- A nightly job sends `pg_dump` output to a Google Cloud Storage bucket. A monthly check restores the latest backup into a test database.

### Acceptance Criteria

- `docker compose up` on a clean VPS starts Caddy, `web` and Postgres, and `https://app.opaya.dev/api/auth/ok` answers.
- No secret is in the repository, in `docker-compose.yml`, or in an image layer.
- A restore of last night's backup gives a working database.

## 2. Accounts and Login

better-auth plugins and options:

- `emailAndPassword` with `requireEmailVerification`. Resend sends the verification and password-reset emails.
- `socialProviders`: GitHub and Google.
- `twoFactor` (TOTP), with backup codes.
- `organization`. When a user is created, a database hook creates the user's personal organization and makes the user its owner. Each new session gets this organization as `activeOrganizationId`.
- `deviceAuthorization` with `verificationUri: "/device"`. The server accepts only the client ID `opaya-desktop`. Later it can also accept `opaya-cord` for the `cord` CLI.
- `bearer`, so the desktop app can send `Authorization: Bearer <token>`.
- Rate limits on sign-in, sign-up, password reset and device codes.

The `/device` page shows the code, the device name and the account. The user clicks **Approve** or **Deny**.

### Desktop Sessions

A desktop session can call only an allowlist: `/api/auth/get-session`, `/api/auth/sign-out`, `/api/auth/device/*` and `/api/entitlements`.

- When `/device/token` creates a session, a hook marks the session `client = "desktop"` (a session field).
- A `hooks.before` handler refuses any other path for a desktop session. This includes `/sign-up/*` and `/subscription/*`.
- So a desktop app cannot start a checkout, even with a changed build.

### Acceptance Criteria

- A user can sign up with email, verify the email, sign in, turn on two-factor and reset the password.
- A user can sign in with GitHub and with Google.
- Each new user has exactly one personal organization and is its owner.
- A request to `/api/auth/subscription/upgrade` with a desktop token gets `403`.

## 3. Plans and Subscriptions

| Plan | Price | Remote hosts | Web app | Sync | Stripe |
| --- | --- | --- | --- | --- | --- |
| Free | $0 | 1 | No | No | No subscription |
| Pro | $19/month or $180/year | 5 | Yes | Yes | `pro`: `priceId`, `annualDiscountPriceId` |
| Fleet | $49/month or $468/year | 20 | Yes | Yes | `fleet`: `priceId`, `annualDiscountPriceId` |
| Team (later) | $149/month for 5 seats, +$25/month per seat | 30 | Yes | Yes | `team`: `priceId`, `seatPriceId` |

`web/src/plans.ts` is the one source of the plan names, limits and features. The Stripe plugin, the entitlements and the pricing page all read it.

The Stripe plugin:

- `subscription.enabled: true`, and the plans with `limits` (`hosts`, `web`, `sync`).
- `organization: { enabled: true }`. Subscriptions use the active organization as `referenceId`. `authorizeReference` allows only the organization's owner to change its subscription.
- Pro has `freeTrial: { days: 14 }`. The trial needs no card:
  - `getCheckoutSessionParams` sets `payment_method_collection: "if_required"`;
  - it also sets `subscription_data.trial_settings.end_behavior.missing_payment_method: "cancel"`.
  - Test this in Stripe test mode. The plugin can override some `subscription_data` fields.
- `getCheckoutSessionParams` also sets `allow_promotion_codes: true`.
- The founding-member offer is a Stripe coupon: 30% off, for 12 months, with 100 redemptions at most. A promotion code gives the coupon.
- The webhook is `/api/auth/stripe/webhook`.
- Plan changes, the card and cancellation are in the Stripe Billing Portal.

The pages:

- `/pricing` shows the plans from `plans.ts`. The marketing site `opaya.dev/pricing` links here.
- `/billing` shows the plan, the trial end, the next invoice, and **Manage billing** (the Billing Portal).
- `/account` shows the profile, the login methods, two-factor, the signed-in devices (with **Sign out** for each one), and **Delete account**.

### Acceptance Criteria

- In Stripe test mode, a user can start the Pro trial without a card. At day 14 without a card, the subscription ends and the entitlements go back to Free.
- A user can buy Pro and Fleet, monthly and yearly. They can upgrade, downgrade and cancel in the Billing Portal.
- A second trial for the same organization is refused.
- The founding promotion code gives 30% off for 12 months, and the 101st use is refused.
- `stripe listen --forward-to localhost:3000/api/auth/stripe/webhook` updates the subscription row for every test above.

## 4. Entitlements

`GET /api/entitlements` returns a signed token for the active organization. The web pages and the desktop app both use it.

- The server signs with Ed25519 (`EdDSA`). The private key is in Secret Manager.
- The server publishes the public keys at `/.well-known/jwks.json`. The desktop build also contains the current public key, so it can check a token offline on first start.
- The token payload: `sub` (user ID), `org` (organization ID), `plan`, `status` (`free`, `trialing`, `active`, `past_due`), `trialEnd`, `limits.hosts`, `features.web`, `features.sync`, `iat`, `exp` and `aud: "opaya-desktop"`.
- The token is valid for 14 days. The desktop app gets a new token at start and every 24 hours.
- An expired token gives the Free limits. Current hosts keep working, so an expired token blocks only new hosts and sync.

### Acceptance Criteria

- A token that has a changed field fails the check.
- A token for a cancelled subscription shows `plan: "free"` within one webhook delivery.
- Offline for 13 days, the desktop app keeps the paid limits. On day 15, it has the Free limits, and current hosts still work.

## 5. Desktop App

The desktop app gets **Settings > Account**, and a status-bar item when the user is signed in.

- **Sign in** starts the device flow in the session service:
  1. The service calls `POST /api/auth/device/code` with `client_id: "opaya-desktop"`.
  2. The service opens `verification_uri_complete` in the system browser. The dialog shows the code.
  3. The service polls `/api/auth/device/token` at the given interval. It stops on `access_denied` or `expired_token`.
  4. The service keeps the token in the Vault as `opaya_account_token`. The token never reaches the UI.
- **Manage plan** and **Upgrade** open `app.opaya.dev/billing` or `/pricing` in the system browser.
- **Sign out** calls `/api/auth/sign-out` and removes the token and the cached entitlements.
- The desktop app has no sign-up form, no pricing form and no Stripe code.

### Host Limit

- A remote host is a saved machine in `workspace.json` `hosts`. This computer does not count.
- When a user adds a host (Add existing, the `~/.ssh/config` import, or New VPS) and the count is at the limit, the app refuses. It shows the limit and **Upgrade**.
- Hosts that are already saved keep working, also above the limit.
- The desktop check is a soft limit. The source is public, so a user can remove the check. The server enforces the limits for sync and the web app.

### Acceptance Criteria

- Sign-in works on Windows, on macOS (arm64 and x64) and on Linux AppImage, with no registered URL protocol.
- A signed-out desktop app works as in `0.35.0`, with a limit of 1 new remote host.
- A user with 3 saved hosts on Free keeps all 3 and cannot add a 4th.
- No API key, token or entitlement is in the UI state or in a log.

## 6. Secrets on the Server (Phase 2)

Make one async secret-store interface: `get`, `set`, `remove`, `has` and `list`.

- The current `Vault` in `desktop/store.cjs` becomes the `safeStorage` implementation.
- `Vault.get()` is synchronous today. Change its 8 call sites in `broker.cjs`, `opaya-agent.cjs` and `service.cjs` to `await`.
- The server implementation uses KMS envelope encryption:
  - Each secret gets a new random data key. AES-256-GCM encrypts the value with that key.
  - Cloud KMS encrypts the data key. The encryption context (additional authenticated data) contains the organization ID and the secret name.
  - Postgres keeps the ciphertext, the encrypted data key and the KMS key version.
  - A ciphertext that is copied to another organization does not decrypt.
- The runtime containers have no Google Cloud credentials. A container asks the web server for its own user's secrets with a token for that container only.
- Synced desktop keys use the same store. The desktop app sends a key only when the user marks it **Sync to web**.

## 7. The Web App (Phase 2)

### Runtime Container per Active User

- A small `launcher` service is the only process with access to the Docker socket. It accepts only "start runtime for user X" and "stop runtime for user X", with fixed options.
- Each runtime container runs the session service under plain Node, with no Electron. Shims replace `app`, `safeStorage` and `shell`.
- Container options: no `--privileged`, `--cap-drop ALL`, a read-only root file system, memory and CPU limits, and one volume for that user only.
- The runtime network has internet access (SSH and model APIs), but no route to Postgres or to the launcher.
- With `OPAYA_RUNTIME=web`, the service turns off:
  - the `local` transport, local terminals and local shells;
  - `run_command` and every other Opaya Agent tool that runs on "this computer";
  - installs, updates and discovery on "this computer";
  - cookie import from browsers, Vault import from local tools, the app updater and start at login.
- A container stops after 30 minutes with no attached client and no running job.

### Transport

- `ui/web-transport.js` defines `window.agenthub` with the same methods and events as `desktop/preload.cjs`. It sends calls and receives events over one WebSocket.
- The web server checks the session, starts the user's container if needed, and relays each call to that container through `desktop/wire.cjs`.
- The method list moves to one shared file, if the preload sandbox allows it. If not, a test checks that the two lists are the same.
- The snapshot has `platform: "desktop"` or `platform: "web"`. The UI hides what the web cannot do.

### Feature Changes on the Web

| Desktop feature | Web behavior |
| --- | --- |
| Agents on this computer | Not available. Synced local agents show as "Desktop only". |
| SSH machines and Docker on them | Available, with the user's web SSH key. |
| Vault import from local tools | Not available. Paste text or upload a file. |
| Cookie import from Chrome or Edge | Not available. Upload `cookies.txt` or JSON. |
| `pick`, `pickFiles`, `pathForFile` | Browser file upload. |
| `terminalPopout` | Opens `terminal.html` in a new browser tab. |
| `clipboardRead`, `clipboardWrite` | `navigator.clipboard`. |
| `openLink`, `openInBrowser` | `window.open`. |
| Opaya browser | Not available at first. |
| Updates, tray, start at login, `openDataFolder` | Hidden. |
| Notifications | Web Push. |

### Web SSH Key

- The server makes one Ed25519 key pair for each user. The private key is in the KMS secret store.
- The web UI shows the public key and how to add it to a machine.
- In the desktop app, **Allow web access** on a machine adds the public key to `~/.ssh/authorized_keys` with the comment `opaya-web <organization ID>`. **Revoke web access** removes that line.
- A firewall on a user's machine must allow the VPS IP address. The web UI shows that address.

### Sync

- Syncs: SSH agents, HTTP API agents, hosts (with no desktop SSH key), chats, skills, MCP servers, settings, and the Vault keys marked **Sync to web**.
- Does not sync: the desktop SSH key, keys not marked for sync, and local agents (they sync only as "Desktop only" entries).
- Write a detailed sync plan (record versions, conflicts, deletes, size limits for chats) before Phase 2 starts.

## Implementation Order

Phase 1 (commercial launch, 29 November – 13 December 2026):

1. Add the workspaces root, `web/`, `deploy/`, Postgres and Caddy. Load secrets from Secret Manager.
2. Add better-auth: email and password, Resend, GitHub, Google, two-factor, the personal organization.
3. Add the Stripe plugin, the plans, the trial, the promotion code and the webhook.
4. Add the `/signup`, `/login`, `/device`, `/pricing`, `/billing` and `/account` pages.
5. Add the desktop-session allowlist and `/api/entitlements`.
6. Add desktop sign-in, **Settings > Account**, the entitlements cache and the host limit.
7. Deploy to the VPS, with backups, and run the acceptance tests in Stripe test mode.
8. Switch Stripe to live mode.

Phase 2:

1. Make the Vault interface async and add the KMS secret store.
2. Make the session service run under plain Node with `OPAYA_RUNTIME=web`.
3. Add the launcher and the runtime container image.
4. Add `ui/web-transport.js`, the WebSocket relay and the `platform` flag.
5. Turn on features in groups: HTTP agents, then SSH machines, then terminals, then Docker.
6. Add the web SSH key and **Allow web access** in the desktop app.
7. Add sync.

## Expected Files

Phase 1:

- `package.json`: the `workspaces` field.
- `web/package.json`, `web/tsconfig.json`, `web/src/*`, `web/test/*`.
- `deploy/docker-compose.yml`, `deploy/Caddyfile`, `deploy/backup.sh`.
- `desktop/account.cjs` (new): the device flow, the token, the entitlements cache and the token check.
- `desktop/service.cjs`: `accountSignIn`, `accountSignOut` and `accountState`, and the host-limit check when a host is added.
- `desktop/preload.cjs` and `desktop/main.cjs`: the new methods.
- `ui/app.js`: **Settings > Account**, the sign-in dialog, the status-bar item and the limit message.
- `tests/account.test.cjs` (new).

Phase 2:

- `desktop/store.cjs`, `desktop/broker.cjs`, `desktop/opaya-agent.cjs`, `desktop/service.cjs`: the async Vault.
- `web/src/runtime/*`, `web/launcher/*`, `deploy/runtime.Dockerfile`.
- `ui/web-transport.js`, `ui/index.html`.

## Verification Plan

- `npm test` and `npm run check` pass for the desktop app.
- `web/` tests run with `node --test` through `tsx`. They cover the plans, the entitlement signing, the desktop-session allowlist and the webhook handling.
- The Stripe tests run in test mode with `stripe listen`.
- Desktop sign-in is tested by hand on Windows, macOS arm64, macOS x64 and Linux AppImage.
- A packaging test checks that no `web/` dependency is in the Electron build.

## Phase 1 Result

Built and tested:

- `web/`: the server (Hono, better-auth, Stripe), the pages, the entitlements and 26 tests. The tests run better-auth against PGlite (Postgres in WebAssembly) and Stripe through a fake client with real webhook signatures.
- `deploy/`: the Compose file, the image, the backups and the runbook (`deploy/README.md`).
- `desktop/account.cjs`, Settings > Account, the status-bar item, the host limit and `tests/account.test.cjs`. `web/test/desktop-account.test.ts` runs the desktop code against the web server.

Changes from the design:

| Design | Built | Reason |
| --- | --- | --- |
| A better-auth `hooks.before` refuses desktop sessions. | A Hono middleware refuses them, for every route. | The user hook runs before the bearer plugin reads the token. The middleware also covers routes outside `/api/auth`. |
| Desktop sessions can call `/api/auth/device/*`. | Only `/device/code` and `/device/token`. | A desktop token must not approve another device code. |
| Stripe `priceId` and `annualDiscountPriceId`. | Stripe lookup keys (`opaya_pro_month` and others). | Test mode and live mode use the same code. `npm run stripe:setup` makes the prices. |
| The better-auth CLI migrates the tables. | The server runs the better-auth migration planner at start, and `npm run migrate` runs it by hand. | No CLI dependency in the image. |
| The desktop build always has accounts. | `package.json` `opayaAccountUrl` turns accounts on. It is empty now. | Every push to `main` publishes a desktop build. The limit must not reach users before `app.opaya.dev` is live. |
| Pages call better-auth directly. | Page forms go through `auth.handler`. | The better-auth rate limits apply only there. |

Open items that are now closed:

- **Trial with no card:** the Stripe plugin passes `payment_method_collection` and `subscription_data.trial_settings` from `getCheckoutSessionParams` to Checkout (checked in the plugin source and in `web/test/billing.test.ts`). Check it one time in Stripe test mode.
- **Desktop session mark:** the session-create hook sees the `/device/token` path (`web/test/device.test.ts`).

## Phase 2 Result

Built and tested:

- Step 1: `web/src/secret-store.ts` (Cloud KMS envelope encryption) and `desktop/remote-vault.cjs`, served by `web/src/runtime/vault-socket.ts`.
- Step 2: `desktop/runtime.cjs` runs the session service under plain Node; `desktop/runtime-guard.cjs` lets only `ssh` start.
- Step 3: `web/src/launcher.ts`, `web/src/runtime/manager.ts`, `deploy/runtime.Dockerfile` and the Compose services.
- Step 4: `ui/web-transport.js`, `web/src/runtime/relay.ts` and `/app` (`web/src/runtime/app.ts`).
- Steps 5 and 6: the web SSH key (`web/src/ssh-key.ts`), **Allow web access** in the desktop app, and the web interface changes.
- Step 7: sync (`desktop/sync.cjs`, `web/src/sync.ts`, [SYNC_PLAN.md](SYNC_PLAN.md)).
- The feature table: Web Push notifications (`web/src/push.ts`, `ui/web-sw.js`) and Vault import from an uploaded file.

The tests start real runtimes as local processes (`web/src/runtime/process-launcher.ts`), so the relay, the manager, the Vault socket, the web SSH key and sync are tested end to end without Docker. The CI job builds both images.

Changes from the design:

| Design | Built | Reason |
| --- | --- | --- |
| `Vault.get()` becomes async at its 8 call sites. | The server store is async; `Vault.get()` stays synchronous. A runtime loads its user's secrets at start and writes each change to the server first. | About 15 code paths read secrets synchronously (redaction of output, MCP configs, model headers). An async change there has a high risk for the desktop app. |
| The snapshot has `platform: "web"`. | The snapshot has `runtime: "web"` or `"desktop"`. | The interface already uses `platform` for the operating system. |
| The launcher accepts start and stop. | It also answers status and list. | The web server stops runtimes with old Vault tokens after a restart. |
| Desktop sessions reach four paths. | Also `/api/web-ssh-key`, `/api/sync` and `/api/sync/secrets`. | **Allow web access** and sync run in the desktop app. |
| Local agents sync as "Desktop only" entries. | Local agents do not sync. | v1 scope. |
| MCP servers sync. | They do not sync. | Each computer must trust a server's program; a background sync cannot ask. |
| — | A synced agent with a new or changed executable asks "Trust this agent executable?" before it first runs, on each side. iTrust does not sync. | A changed record on the server must not start a new program on the user's machines without the user. |
| An approval with no window is denied. | With browser notifications on, it waits for a tab (up to 10 minutes). | A web user can answer from the notification. |

Security and sync review (17 October 2026). Two reviews (the web server, and the desktop changes) found these defects. All are fixed and have tests (`web/test/security.test.ts`, `tests/sync.test.cjs`):

| Defect | Fix |
| --- | --- |
| An open web app tab kept working after sign-out, a revoked session, a deleted account or a plan change. | The relay checks each socket's session and plan every 30 seconds. A deleted account closes its tabs at once. |
| The web server read and wrote files in the user's folder, which the runtime can change (links to other users' files). | "Always allow" rules are in Postgres (`opaya_approval_rule`). The server reads the runtime's session file without following links, checks the socket, and writes uploads only into real folders. |
| The server's own JSON routes had no CSRF check. | Non-better-auth `/api/*` posts need JSON, and a cookie session needs Opaya's own origin. |
| No body size limits. | 16 MB for sync, 1 MB for `/api/auth`, 128 KB for the rest; 20 MB in Caddy; `mem_limit: 2g` for the web service. The desktop app pushes at most 8 MB at a time. |
| Account deletion left secrets, sync records, push subscriptions, the runtime and its folder. | `beforeDelete` removes them. |
| The runtime could replace the web SSH public key. | The server derives the public key from the private key and makes the key with one atomic insert. The Vault socket refuses changes to it. |
| Push endpoints could be any HTTPS host. | Only the browsers' push services. |
| The firewall rules did not cover traffic to the VPS itself. | `deploy/README.md` adds an `INPUT` rule. |
| Sync deleted an item that stopped syncing (for example a machine with only an alias now). | Such an item stays local and is not deleted on the server. |
| One record that could not be applied stopped all incoming sync. | Records wait only for their parent in the same round; failures show in the sync status. |
| A synced change switched the open chat and disconnected agents. | Sync saves keep the selection and disconnect only when the connection changed. A new machine name never disconnects. |
| **Allow web access** reported success after a failed write. | `OPAYA_DONE` comes only when the file has (or no longer has) the key. |


## Open Items

- **Test mode checks:** run the acceptance tests of sections 3 and 4 in Stripe test mode, and build and start both images on the VPS.
- **Trial with no card:** check in Stripe test mode that the plugin keeps `payment_method_collection` and `trial_settings` from `getCheckoutSessionParams`. If it does not, add a small custom checkout endpoint for the trial.
- **Google Cloud key file:** the organization policy `iam.disableServiceAccountKeyCreation` can block the service account key. An admin must then allow an exception for this project.
- **Tax:** the US company is the seller, so it must handle US sales tax and EU VAT. Stripe Tax (`automatic_tax`) calculates the tax, but the company must register where it has to.
- **Desktop session mark:** check that the session-create hook can see that `/device/token` created the session.
- **Runtime user:** the web server and the runtime containers both run as uid 10001. The server does not follow links in user folders, but a separate uid for runtimes (with a shared group for the session socket and the uploads) is a stronger boundary. Do this before the web app has many users.
- **Schedules on the web (decided):** a runtime with an enabled schedule does not stop when idle (`web/src/runtime/manager.ts`). A scheduler in the web server can replace this later, if many idle runtimes stay on only for schedules.

## Defaults to Confirm

These values are defaults in this plan. Nobody chose them yet.

- The entitlement token is valid for 14 days and refreshes every 24 hours.
- A runtime container stops after 30 minutes with no use.
- The founding offer uses a promotion code, not an automatic discount.
- Caddy is the TLS proxy, and Postgres runs from the official Docker image.

## Out of Scope

- Hosted agents or a hosted "this computer" for web users.
- The Team plan features: seats, shared agents, roles and approvals. Only the organization schema is ready.
- The Opaya browser in the web app.
- A relay from the web app to the desktop app.
