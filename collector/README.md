# Opaya collector

Receives feedback and error reports from Opaya (`desktop/feedback.cjs`) and files them as issues in a private GitHub
repository, so every report is in one list you can label, assign, fix and close.

- **Feedback** (the chat icon in Opaya's top bar): one issue each, labelled `feedback` plus its kind (`bug`, `idea`,
  `praise`, `other`) and `app:<version>`. Includes the recent errors when the user ticked that box.
- **Errors** (only from users who turned on *Share errors*): grouped by fingerprint. The first one opens
  `[err:<fingerprint>] <source>: <title>` labelled `error`; later ones add a comment with the count, version and system.
  An error that comes back after its issue was closed reopens it with the label `regression`.

Opaya cleans everything before it leaves the computer: keys, passwords, tokens, the home folder, user and machine
names, IP and e-mail addresses. Chat text is never sent. Reports wait in Opaya's outbox until the collector accepts them.

## Set it up (once)

1. Create a **private** GitHub repository for the reports, for example `trbojevicstefan/opaya-feedback`.
2. Create a fine-grained GitHub token with access to only that repository and **Issues: Read and write**.
3. Deploy the Worker (free Cloudflare account):

   ```sh
   cd collector
   npx wrangler login
   npx wrangler secret put GITHUB_TOKEN     # paste the token
   npx wrangler deploy                       # prints https://opaya-collector.<you>.workers.dev
   ```

   Change `GITHUB_REPO` in `wrangler.toml` first if the repository has another name. Or let GitHub Actions deploy it:
   add the repository secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `COLLECTOR_GITHUB_TOKEN`, then run
   the **Feedback collector** workflow.
4. Put the address in `package.json` as `"opayaFeedbackUrl": "https://opaya-collector.<you>.workers.dev/v1/report"`
   and release. Until then Opaya keeps reports in its outbox and sends them once a version with the address is installed.

Check it: `curl https://opaya-collector.<you>.workers.dev/` answers `{"ok":true,...}`.

Optional: a KV namespace `FINGERPRINTS` (see `wrangler.toml`) remembers the issue of each error and saves a search.
