# Juror Cloud

Juror Cloud is the hosted companion to the open-source Juror Action. It connects through a GitHub App, runs PR reviews and post-merge staging QA in isolated Cloudflare Sandbox containers, and exposes a lean operational inbox for findings, live runs, repository policy, and usage.

The open-source Action remains fully independent. Repositories connected to Juror Cloud use hosted execution exclusively and stay review-disabled until an administrator explicitly selects them.

## Architecture

- Vite, React Router, Tailwind, and shadcn-style primitives provide the dashboard. Eldora-inspired components are limited to inline GitHub diffs, browser evidence, terminal events, and live status.
- Hono serves the static application and typed internal JSON routes from one Cloudflare Worker.
- Better Auth stores GitHub and Google identities in D1. Google users link GitHub before claiming an App installation.
- D1 stores workspaces, RBAC, repositories, runs, bounded run events, a minimal finding index, triage, the idempotent usage ledger, and only the small control-plane policy for training data. Finding explanations, claims, expected/actual text, attempts, and review/comment bodies are loaded from private R2 reports rather than duplicated into D1.
- Cloudflare Workflows orchestrate retries and progress. Every review uses a `standard-3` Sandbox; QA uses `standard-2` and is serialized per repository.
- Private R2 retains sanitized reports for one year and sanitized QA evidence for 90 days. Evidence is served through authenticated five-minute URLs.
- A second private R2 bucket stores explicitly consented PR review/comment events as encrypted, compressed JSONL batches. Comment bodies never enter D1. Cloudflare Queues provide durable webhook processing, batching, retry, and dead-letter handling.
- Stripe receives one idempotent meter event per billable run after the D1 ledger is final.

Source checkouts, full patches, raw model output, agent scratch files, and chain-of-thought are never persisted. Review diffs are fetched from GitHub only when a user opens them.

The untrusted Sandbox can use only Git's read-only upload-pack protocol and fixed PR, commit, and comparison reads. It never receives or exercises GitHub write routes. The trusted Worker publishes sanitized summary comments, inline findings, and checks after independently confirming that the reviewed base and head are still current. For authenticated QA, the Worker exact-redacts the raw, URL-encoded, and base64 forms of every injected credential and revalidates the versioned report before any report or evidence metadata is retained.

## GitHub App

Create a GitHub App with the setup URL set to `https://YOUR_HOST/onboarding` and the webhook URL set to `https://YOUR_HOST/api/github/webhooks`.

Repository permissions:

- Metadata: read
- Contents: read
- Pull requests: read and write
- Checks: write
- Deployments: read
- Issues: read (only to receive pull-request conversation comments for an explicitly consented training corpus)

Subscribe to `installation`, `installation_repositories`, `pull_request`, `pull_request_review`, `pull_request_review_comment`, `pull_request_review_thread`, `issue_comment`, and `deployment_status` events. Set the same webhook secret as `GITHUB_WEBHOOK_SECRET`.

Use the GitHub App client ID and client secret for Better Auth. Its callback is `https://YOUR_HOST/api/auth/callback/github`; this produces the GitHub App user token needed to verify installations. Google OAuth uses `https://YOUR_HOST/api/auth/callback/google`. Repository execution always uses installation tokens.

## Cloudflare setup

Requirements are Node 20+, Docker, a Cloudflare account with Workers, Workflows, R2, D1, Containers, and Sandbox access, plus a Stripe account.

```bash
cd cloud
npm ci
npx wrangler d1 create juror-cloud
npx wrangler r2 bucket create juror-cloud-private-reports
npx wrangler r2 bucket create juror-cloud-training-corpus
npx wrangler queues create juror-cloud-webhooks
npx wrangler queues create juror-cloud-webhooks-dlq
npx wrangler queues create juror-cloud-corpus
npx wrangler queues create juror-cloud-corpus-dlq
```

Replace the placeholder D1 `database_id`, `APP_URL`, and `STRIPE_PRICE_ID` in `wrangler.jsonc`. Container CPU, provisioned memory/disk, and R2 rates are deployment inputs because Cloudflare prices can change. The runner records GNU `time` user and system CPU for the complete Juror process tree; duration prices the provisioned memory and disk. Production should verify the committed rates before each release.

Configure secrets with `wrangler secret put`:

```text
BETTER_AUTH_SECRET
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GITHUB_OAUTH_CLIENT_ID
GITHUB_OAUTH_CLIENT_SECRET
GITHUB_APP_ID
GITHUB_APP_PRIVATE_KEY
GITHUB_WEBHOOK_SECRET
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
QA_MASTER_KEY_B64
EVIDENCE_SIGNING_SECRET
CORPUS_MASTER_KEY_B64
OPENAI_API_KEY
FIREWORKS_API_KEY
ANTHROPIC_API_KEY, XAI_API_KEY, or OPENROUTER_API_KEY (for presets that use them)
```

`QA_MASTER_KEY_B64` and `CORPUS_MASTER_KEY_B64` must each decode to exactly 32 independent random bytes. QA workspace secrets and training shards use separate per-workspace data keys. Removing a corpus data key makes retained corpus objects cryptographically unreadable.

## Training corpus

Training collection is disabled by default. An admin must choose workspace-private improvement or shared Juror training, acknowledge the current consent version, and select repositories. The ingestion worker records review bodies, inline comments, PR conversation comments, review-thread state, edits, and deletions; it excludes diffs, source files, identities, email addresses, credentials, and model scratch text. Raw paths and PR descriptions are separate opt-ins.

Events are normalized and secret-scanned before entering the corpus queue, then written in encrypted compressed batches under opaque workspace prefixes. Settings provide a short-lived authenticated JSONL export and an asynchronous delete job that removes the objects and workspace data key. Collection begins at opt-in; historical backfill is intentionally absent.

Apply the schema and deploy:

```bash
npx wrangler d1 migrations apply juror-cloud --remote
npm run build
npm run deploy
```

For local UI work, copy `.dev.vars.example` to `.dev.vars`, run `npm run dev:worker`, then run `npm run dev` in a second terminal. `DEV_BYPASS_AUTH=true` is only for a local seeded D1 database and must remain `false` in deployed environments.

## Stripe configuration

Create a metered recurring Price and a meter whose event name matches `STRIPE_METER_EVENT_NAME`. The meter value is integer micro-USD; configure the Stripe price transformation so `1,000,000` reported units equal `$1.00`. Subscribe the webhook endpoint at `/api/stripe/webhooks` to checkout session, customer subscription, and invoice events.

Every GitHub installation receives one $10 credit. A run starts only if its preset-specific maximum customer charge fits within remaining trial credit or the workspace has active billing, and the monthly committed amount remains below the hard cap. The default cap is $100 and warns at 80%. Direct provider, Sandbox, and retained-storage cost receive a 25% service fee. Cancellation, Juror infrastructure failures, reviews with no usable model result, and operator-cost overflow beyond the admitted maximum are not billed.

## Verification

```bash
npm test
npm run typecheck
npm run typecheck:worker
npm run build
npx wrangler d1 migrations apply juror-cloud --local
```

The container image is built from [`Dockerfile.cloud`](../Dockerfile.cloud). It installs the existing Juror CLI and browser runtime; the Worker supplies a versioned, secret-free manifest and destroys the Sandbox in `finally`.

## V1 boundaries

Cloud mode uses Juror-managed provider credentials. BYOK, Action-result ingestion, PR-preview QA, autofix, chat, Slack, custom roles, SSO/SCIM, historical backfill, and reusable username/password form filling are intentionally outside V1.
