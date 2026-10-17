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

## Rules

- Do not put a secret in this repository, in `docker-compose.yml`, in `.env` or in an image. Only the two files in `/etc/opaya` are on the VPS.
- To change a secret, add a new version in Secret Manager, then restart the web service: `docker compose restart web`.
