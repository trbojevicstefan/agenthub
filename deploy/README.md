# Deploy the Opaya Web Server

This runbook installs `app.opaya.dev` on one VPS. The VPS runs Caddy, the web server and Postgres in Docker. Google Cloud keeps the app secrets and the backups.

## 1. Google Cloud

Do these steps one time, as a Google Cloud administrator.

1. Create the project, for example `opaya-prod`. Turn on the Secret Manager API and the Cloud Storage API.
2. Create the service account `opaya-web@opaya-prod.iam.gserviceaccount.com`. Give it no project roles.
3. Create the secrets. Use the names below exactly. Give the service account `roles/secretmanager.secretAccessor` on each secret, not on the project.

   | Secret | Value |
   | --- | --- |
   | `BETTER_AUTH_SECRET` | 48 or more random characters: `openssl rand -base64 48` |
   | `DATABASE_URL` | `postgres://opaya:<postgres password>@postgres:5432/opaya` |
   | `ENTITLEMENTS_PRIVATE_KEY` | The private JWK from `npm run entitlements:key --workspace web` |
   | `STRIPE_SECRET_KEY` | The Stripe secret key (`sk_test_...` first, `sk_live_...` at launch) |
   | `STRIPE_WEBHOOK_SECRET` | The signing secret of the webhook endpoint `https://app.opaya.dev/api/auth/stripe/webhook` |
   | `RESEND_API_KEY` | The Resend API key for the domain `opaya.dev` |
   | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | The GitHub OAuth app. Callback: `https://app.opaya.dev/api/auth/callback/github` |
   | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | The Google OAuth client. Redirect URI: `https://app.opaya.dev/api/auth/callback/google` |

   The GitHub and Google secrets are optional. Without them, the login page does not show that login method.

   For `ENTITLEMENTS_PRIVATE_KEY`, run `npm run entitlements:key --workspace web -- --desktop` one time. It prints the private key for Secret Manager and adds the public key to `desktop/account-keys.json`. Commit that file, so the desktop app can check entitlement tokens offline from its first start.
4. Create the backup bucket, for example `opaya-prod-backups`, in the same region as the VPS. Set these on the bucket:
   - uniform bucket-level access;
   - a lifecycle rule that deletes objects older than 35 days;
   - `roles/storage.objectCreator` for the service account. The VPS can add backups, but it cannot read, change or delete them.
5. Create one key file for the service account. If the organization policy `iam.disableServiceAccountKeyCreation` blocks this, an organization administrator must allow an exception for this project.

## 2. The VPS

1. Install Docker Engine and the Compose plugin. Open only the ports 22, 80 and 443.
2. Copy the repository to `/opt/opaya`.
3. Put the two secret files on the VPS:

   ```sh
   install -d -m 0700 /etc/opaya
   install -m 0400 -o 10001 -g 10001 gcp-key.json /etc/opaya/gcp-key.json
   openssl rand -hex 32 > /etc/opaya/postgres-password
   chown 70:70 /etc/opaya/postgres-password && chmod 0400 /etc/opaya/postgres-password
   ```

   The web container runs as the user `10001`, and the Postgres image runs as the user `70`. Each file belongs only to the container that reads it. Put the same Postgres password in the `DATABASE_URL` secret.
4. Write `/opt/opaya/deploy/.env`:

   ```sh
   GCP_PROJECT=opaya-prod
   OPAYA_DOMAIN=app.opaya.dev
   OPAYA_BACKUP_BUCKET=opaya-prod-backups
   ```

5. Point the DNS record `app.opaya.dev` to the VPS IP address.
6. Start the services:

   ```sh
   cd /opt/opaya/deploy && docker compose up -d --build
   curl https://app.opaya.dev/api/auth/ok
   ```

   The web server creates and updates its database tables when it starts.

## 3. Stripe

Do these steps first with the test-mode key, and again with the live key at launch.

1. Create the products, prices, founding coupon and Billing Portal settings, and the webhook endpoint:

   ```sh
   STRIPE_SECRET_KEY=sk_test_... npm run stripe:setup --workspace web -- --webhook https://app.opaya.dev
   ```

   The script prints the webhook signing secret one time. Put it in Secret Manager as `STRIPE_WEBHOOK_SECRET`. Put the key in Secret Manager as `STRIPE_SECRET_KEY`. Then restart the web service.
2. If the script says that the Billing Portal settings were created, open **Settings > Billing > Customer portal** in the Stripe Dashboard and save the settings one time.
3. The prices are found by lookup key (`opaya_pro_month`, `opaya_pro_year`, `opaya_fleet_month`, `opaya_fleet_year`). The code has no price IDs. A new amount gets a new price, and the lookup key moves to it. Current subscribers keep their old price.
4. The founding offer is the promotion code `FOUNDING`: 30% off for 12 months, for 100 customers at most. Customers type the code on the Stripe Checkout page.
5. Tax: Stripe Tax is off. Set `STRIPE_AUTOMATIC_TAX=true` in `deploy/.env` only after Stripe Tax is set up and the company is registered where it must collect tax.
6. To test webhooks on a development computer: `stripe listen --forward-to localhost:3000/api/auth/stripe/webhook`. Use the `whsec_...` secret that it prints as `STRIPE_WEBHOOK_SECRET`.

## 4. Backups

1. Add the nightly backup to the root crontab:

   ```
   15 3 * * * /opt/opaya/deploy/backup.sh >> /var/log/opaya-backup.log 2>&1
   ```

2. Run `/opt/opaya/deploy/backup.sh` one time and check that the object is in the bucket.
3. Each month, download the latest backup on a computer with read access to the bucket. Then run `deploy/restore-check.sh latest.dump`. The check restores the backup into a temporary Postgres container and counts the users.

## 5. Updates

```sh
cd /opt/opaya && git pull
cd deploy && docker compose up -d --build web
```

## 6. Turn on accounts in the desktop app

Desktop builds have accounts off until the web server is live: `package.json` has `"opayaAccountUrl": ""`. With it empty, the desktop app shows no Account page and limits nothing, as in 0.35.0.

1. Make the entitlement key with `--desktop` (step 1), so `desktop/account-keys.json` has the public key.
2. Set `"opayaAccountUrl": "https://app.opaya.dev"` in `package.json`, and raise the version.
3. Push to `main`. The desktop workflows build and publish the release.

From that version, a signed-out desktop app has the Free limit of 1 new remote machine. Machines that are saved keep working.

To test a development server first, start the desktop app with `OPAYA_ACCOUNT_URL=http://localhost:3000` (http is allowed only for `localhost`).

## 7. The web app (Phase 2)

The web app runs one runtime container for each active user. The launcher starts and stops them; it is the only process with the Docker socket.

1. Create a Cloud KMS key ring and key, for example `projects/opaya-prod/locations/europe-west3/keyRings/opaya/cryptoKeys/user-secrets`. Give the service account `roles/cloudkms.cryptoKeyEncrypterDecrypter` on this key only. Add `OPAYA_KMS_KEY=<the key name>` to `deploy/.env`.
2. Create the users' folder. It belongs to the user `10001`, like the web and runtime containers:

   ```sh
   install -d -m 0700 -o 10001 -g 10001 /var/lib/opaya/users
   ```

3. Build the runtime image: `docker compose --profile build build runtime-image`.
4. The launcher creates the network `opaya-runtime` (subnet `172.31.250.0/24`, no traffic between containers) when it starts the first runtime. Block private addresses from it, so a runtime reaches only the internet:

   ```sh
   iptables -I DOCKER-USER -s 172.31.250.0/24 -d 10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,100.64.0.0/10 -j DROP
   iptables -I DOCKER-USER -s 172.31.250.0/24 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
   ```

   Make the rules permanent (for example with `iptables-persistent`). A runtime has no route to Postgres, the web server or the launcher: those are on other networks.
5. For browser notifications, make VAPID keys with `npx web-push generate-vapid-keys` and put them in Secret Manager as `WEB_PUSH_PUBLIC_KEY` and `WEB_PUSH_PRIVATE_KEY`. Without them, the web app has no notifications.
6. Add `OPAYA_EGRESS_IP=<the VPS IP address>` to `deploy/.env` and to the web service's environment. The web app shows it next to the web SSH key, so users can allow it in their firewalls.
7. Restart: `docker compose up -d --build`. When the web server starts, it stops runtimes that an older web server started.

Users' machines must allow SSH from the VPS IP address. The web app shows that address.

## Rules

- Do not put a secret in this repository, in `docker-compose.yml`, in `.env` or in an image. Only the two files in `/etc/opaya` are on the VPS.
- To change a secret, add a new version in Secret Manager, then restart the web service: `docker compose restart web`.
