---
date: 2026-08-18
author: Jay Derinbogaz
title: Run Post-Merge Browser QA
tags: [qa, e2e, playwright, staging]
---

# Run Post-Merge Browser QA

## Overview

Juror QA plans affected browser scenarios from a merged pull request and runs them against a
staging or branch deployment with Playwright. Every run retains a report; unauthenticated runs also
retain a sanitized operation ledger. It retains trace, screenshots, and video according to
`.juror.yml` only when the browser has no auth steps, support-session bootstrap, secret browser
headers, or supplied storage state. Reset-only secrets never enter Playwright and do not disable
visual evidence. It is separate from code review and remains disabled unless a maintainer configures
an allowed target with `juror init --qa` or uses `juror qa --force` locally.

This guide covers the shortest local feedback loop, a production-shaped container run, and the
GitHub Actions setup. Use a dedicated synthetic QA account and a resettable tenant containing no
production data, private customer content, or other sensitive records. Do not use a personal or
production account.

## One-time repository setup

From the repository that should be monitored:

```bash
export JUROR_OPENAI_API_KEY='<dedicated-provider-key>'
npx juror-ai init --qa --set-secrets --target-url https://staging.example.com
```

After confirmation, init creates or refreshes:

- `.github/workflows/juror.yml` for pull-request code review;
- `.github/workflows/juror-qa.yml` for merged-PR browser QA; and
- the opt-in `qa` block in `.juror.yml`.

Review and commit all three files. The QA workflow runs only for a merged, same-repository pull
request whose base is the repository default branch. An unmerged or forked pull request does not
receive QA credentials. The generated job has a 95-minute timeout: trusted policy can spend at
most 60 minutes resolving a deployment and 20 minutes in browser execution, leaving 15 minutes
for checkout, startup, the final reset and target recheck, evidence finalization, and publication.

Run `npx juror-ai init --qa --dry-run` first when you only want to inspect the proposed setup.
Without `--qa`, init neither creates the QA workflow/config nor considers the browser-auth
bundle. `--target-url` accepts an HTTPS staging or preview URL (or localhost HTTP) and adds its
exact origin to the browser allowlist. Add repeatable `--allow-origin https://api.example.com`
flags for other origins the tested page must reach. If neither option is supplied for a new QA
block, init leaves `qa.enabled: false` and prints the command needed to finish setup.
The post-merge Action never accepts an origin expansion from workflow inputs: automation uses only
the allowlist agreed by every trusted pre-merge policy candidate. Add a new origin through a
reviewed `.juror.yml` change (or `init --qa`) before relying on it in later merged-PR runs.

The generated policy has `sandbox.reset: null`, which deliberately enables only direct navigation,
snapshots, waits, and assertions. Configure a trusted reset hook against a dedicated synthetic
tenant before interactive click, fill, press, select, and check tools are enabled. This makes the
safe first run useful for route, visibility, access-control, and removal checks without pretending
that arbitrary UI interactions are reversible.

### Neutral early exit for non-browser changes

Use reviewed repository policy to avoid spending deployment, model, and browser time on path trees
that your team knows cannot affect a browser surface:

```yaml
qa:
  testability:
    early_exit_paths:
      - .github/**
      - docs/**
      - infrastructure/**
      - backend/terraform/**
      - '**/*.tf'
```

The default list is empty. Juror is repository-agnostic, and infrastructure, Helm, documentation
sites, or deployment configuration can be user-visible in some products. Add only rules that are
safe for this repository.

This preflight consumes the controller-generated complete changed-path manifest. It returns
`no_testable_surface` only when the manifest is non-empty and every path—including both sides of a
rename—matches at least one trusted rule. An empty, malformed, partially matched, or mixed manifest
falls through to normal semantic planning. Negated, absolute, traversal, control-character, and
oversized rules are rejected by trusted-policy validation. A matched run resolves no deployment,
loads no QA secrets, starts no model or browser, records zero cost, and renders the QA verdict as
**Neutral (not scored)** while retaining a successful workflow conclusion.

For authenticated or supplied-storage runs, scenario setup has one fixed 10-second response window
covering reset, Chromium launch, context creation, and the full auth recipe. Its hard execution
cutoff is 9.75 seconds. Per-reset and per-wait `timeout_seconds` values are upper bounds further
capped by this envelope; at cutoff Juror aborts reset work and closes the pending browser context.
The agent receives the same sealed acknowledgement for successful and failed setup and continues
the predetermined attempt, while the controller privately records failed setup as blocked.

## Browser login secrets

The optional `JUROR_QA_SECRETS_B64` GitHub secret is a base64-encoded JSON map. Map keys are
logical names referenced by `qa.auth.session_bootstrap.secret_ref`,
`qa.auth.browser_secret_headers[].secret_ref`, `qa.auth.steps[].secret_ref`, and
`qa.sandbox.reset.secret_headers[].secret_ref`; the model never receives the values.
Each value must contain at least eight characters so exact-value artifact redaction remains
safe and unambiguous. A session-bootstrap bearer token must contain at least 32 characters.

For example, this unencoded map supplies a synthetic account and a reset token:

```json
{
  "QA_EMAIL": "synthetic-qa@example.invalid",
  "QA_PASSWORD": "<password>",
  "QA_RESET_TOKEN": "<reset-token>"
}
```

Encode the compact JSON with a trusted local tool or password manager, then expose only the
encoded value to init:

```bash
export JUROR_QA_SECRETS_B64='<base64-json-map>'
npx juror-ai init --qa --set-secrets
```

Init treats this value as opaque: it does not decode, validate, or print it, and sends it to
`gh secret set` over stdin only after confirmation. The trusted QA controller validates and
decodes it in memory when a run starts. Base64 is transport encoding, not encryption. Do not
commit the encoded value, a Playwright storage-state file, or decoded credentials.

### Staging support-session bootstrap

For automated staging tests, prefer a fixed-identity synthetic support-session endpoint over
repeating the sign-in or sign-up UI. Before each scenario attempt, the trusted controller calls the
configured endpoint with its bearer secret, accepts one `redirect_url`, verifies that URL against
`target_origin`, and navigates the fresh browser context to it. The URL is short-lived and
single-use; Juror never caches or reuses it for attempt 2.

This mode is deliberately narrower than general browser login:

- It is accepted only when both the trusted policy and resolved deployment are `staging`.
- `target_origin` must equal the resolved canonical staging origin exactly.
- Preview deployments are blocked because their origins cannot consume a login URL bound to the
  canonical staging origin. Set `qa.target.preview_fallback: false` whenever this mode is enabled.
- The endpoint selects the dedicated synthetic identity server-side. Do not use or re-enable an
  arbitrary-user testing-login bypass on shared staging.
- Browser headers are sent only to the exact origins listed under each header. There are no suffix,
  wildcard, redirect, or preview-host matches.
- A session bootstrap or secret browser header makes the browser sensitive: video, trace, and
  screenshots are forced off, all page-dependent acknowledgements are sealed, and only the trusted
  controller derives checkpoint outcomes.

The following generic example uses a canonical staging web application and its API endpoint. The
logical secret names are examples; their values remain only in
`JUROR_QA_SECRETS_B64`:

```yaml
qa:
  enabled: true
  target:
    strategy: staging-first
    environment: staging
    deployment_environment: web-staging
    static_url: https://staging.example.com
    readiness_statuses: [403]
    preview_fallback: false
  auth:
    session_bootstrap:
      url: https://api.staging.example.com/qa/session
      secret_ref: STAGING_SYNTHETIC_E2E_SESSION_TOKEN
      target_origin: https://staging.example.com
      ready_storage_key: qaSessionReady
    browser_secret_headers:
      - name: CF-Access-Client-Id
        secret_ref: STAGING_CF_ACCESS_CLIENT_ID
        origins:
          - https://staging.example.com
      - name: CF-Access-Client-Secret
        secret_ref: STAGING_CF_ACCESS_CLIENT_SECRET
        origins:
          - https://staging.example.com
      - name: X-Staging-Gateway-Token
        secret_ref: STAGING_GATEWAY_TOKEN
        origins:
          - https://staging.example.com
    steps: []
  sandbox:
    allowed_origins:
      - https://staging.example.com
      - https://api.staging.example.com
  evidence:
    video: off
    trace: off
    screenshot: off
```

`environment: staging` remains the authenticated QA security tier. When the web application uses
a dedicated GitHub deployment environment, set `deployment_environment` to that exact name. Juror
queries only that deployment stream and requires the resolved record to match it; `null` preserves
the default behavior of querying `staging`. This selector does not enable preview authentication or
relax the canonical-origin checks.

`ready_storage_key` is checked in both `localStorage` and `sessionStorage` after the one-time URL
loads. Juror does not read or expose the value. If the key does not become non-empty within the
fixed sealed setup window, the attempt is classified as blocked before the testing agent can touch
the page. This intentionally favors a safe infrastructure/setup result over testing a login shell
as though it were the product.

Trusted browser authentication is bound to the exact origin of `qa.target.static_url`. An explicit
`--target-url` is accepted only when it has that same canonical staging origin; branch and preview
origins cannot receive the staging session, Access service token, or WAF header. The two
`CF-Access-*` values are runtime-only credentials for the dedicated staging Service Auth policy;
they must not be embedded in a frontend build. The `X-Staging-Gateway-Token` value remains a separate
staging WAF credential and should be omitted if that WAF rule is retired.

For example, the unencoded secret map would contain values provisioned specifically for this
staging monitor:

```json
{
  "STAGING_SYNTHETIC_E2E_SESSION_TOKEN": "<dedicated-staging-token-at-least-32-characters>",
  "STAGING_CF_ACCESS_CLIENT_ID": "<dedicated-staging-service-token-client-id>",
  "STAGING_CF_ACCESS_CLIENT_SECRET": "<dedicated-staging-service-token-client-secret>",
  "STAGING_GATEWAY_TOKEN": "<dedicated-staging-gateway-token>"
}
```

Target resolution occurs before Juror hands browser secrets to the broker, so its HTTP readiness
probe sends neither the `CF-Access-*` service-token pair nor `X-Staging-Gateway-Token`. The
example gateway's intentional unauthenticated `403` is therefore listed as a ready status above; that only
proves the canonical endpoint is present. The subsequent sealed browser setup remains the
authoritative authentication check.

Configuration alone does not prove that the route is usable. Before relying on this flow, verify
that the staging backend has its fixed synthetic tenant/user settings, that the raw token
matches the configured hash, that the staging Access application has a Service Auth policy for the
dedicated service token, and that the current WAF rule recognizes `X-Staging-Gateway-Token` on
`https://staging.example.com`. A missing or stale route, identity, token, policy, rule, or header
produces a blocked authentication run; it is not a product finding. If Cloudflare later protects
another origin, provision a separate canonical target policy rather than extending these staging
credentials to that origin.

The example service mints sessions for one fixed synthetic user, and a new mint can invalidate an
older unconsumed URL for that user. Run this staging identity through a single-capacity runner or a
durable queue so two merged-PR jobs cannot race between mint and redemption. Do not replace Juror's
per-PR workflow group with one shared GitHub concurrency group: GitHub can discard older pending
runs in that shape. Juror still mints immediately before each admitted attempt and never caches a
URL.

For applications without a support-session service, a declarative login recipe can instead
reference the logical keys:

```yaml
qa:
  auth:
    steps:
      - type: goto
        path: /login
      - type: fill
        locator: { by: label, value: Email }
        secret_ref: QA_EMAIL
      - type: fill
        locator: { by: label, value: Password }
        secret_ref: QA_PASSWORD
      - type: click
        locator: { by: role, role: button, name: Sign in }
      - type: wait
        locator: { by: text, value: Dashboard }
        state: visible
```

The controller consumes each scenario/attempt setup admission before reset, browser launch, or
authentication begins, so a failed login cannot be replayed indefinitely under the same attempt.
The complete sensitive setup uses the fixed 10-second response window and 9.75-second hard cutoff
described above, safely below the MCP request deadline. A timeout or setup error becomes a private
absorbing blocked attempt while the execution agent continues to receive sealed acknowledgements;
it never becomes a product finding.

## Fastest local staging loop

For Juror development, install once and rebuild only after source changes:

```bash
npm ci
npm run build
npx playwright install chromium
codex --version
```

An authenticated `gh` CLI can supply GitHub access. Juror can use either
`JUROR_OPENAI_API_KEY` or an existing `codex login` session. Then run a previously merged PR
against a revision-pinned deployment:

```bash
node dist/cli.js qa \
  --pr <merged-pr-number> \
  --repo example/product \
  --repo-dir /path/to/product \
  --target-url 'https://<immutable-staging-or-branch-deployment>' \
  --allow-origin 'https://<deployment-host>' \
  --target-sha '<40-character-deployed-commit-sha>' \
  --evidence-dir .context/qa-evidence/pr-<merged-pr-number> \
  --json .context/qa-evidence/pr-<merged-pr-number>-result.json \
  --markdown .context/qa-evidence/pr-<merged-pr-number>-summary.md \
  --force \
  -v
```

QA never auto-loads `.env` from the tested repository because merged source is untrusted before
the detached worktree is created. Export credentials in the shell, use `codex login`, or pass an
explicit `--env-file` located outside the tested repository; that file accepts only the GitHub,
OpenAI, and `JUROR_QA_SECRETS_B64` credential names needed by the controller.

`--force` is for an intentional local smoke test when trusted candidate policy still has
`qa.enabled: false`; omit it once the repository has opted in. A forced run consumes the whole QA
configuration, so every plausible base must agree on the normalized parsed policy even when all of
them disable automation. `--target-url` avoids waiting for
deployment discovery, but its exact origin must still be present through `--allow-origin` or the
trusted config. `--target-sha` is a consistency check, not proof by itself: Juror accepts
a blocking product verdict only when a trusted commit probe or GitHub deployment record
independently binds that revision to the URL. Without that binding, the smoke still runs but
findings remain advisory. A staging revision may be newer than the merge when GitHub's compare
proof shows that it contains the merge.

The local agent also needs `codex` on `PATH`; install the version pinned in `qa/Dockerfile` when
it is absent. Juror reads in-repository QA policy from every topology-plausible pre-merge base and
fails closed if a candidate is unavailable, malformed, unsafe, disagrees on enablement, or has a
different active parsed QA configuration. Repository-owned config blobs above 262,144 bytes are
rejected from Git tree metadata before YAML parsing. To iterate on uncommitted smoke-only auth,
reset, or limit settings, put a config outside the target repository (for example, this Juror
checkout's gitignored `.context/staging-smoke.yml`) and pass its absolute path with `--config`.
This makes the operator-owned override explicit without allowing a merged change to rewrite the
policy used by automation.

For authenticated local iteration, prefer a disposable Playwright state file outside the
repository and add `--storage-state /absolute/path/to/qa-auth.json`. The file must be a regular
file no larger than 4 MiB. Never commit it.

Authenticated and supplied-state runs are outcome-oriented. Playwright still navigates, interacts,
and evaluates the exact checkpoints accepted in the plan, but each admitted page-dependent call
returns the same fixed sealed acknowledgement whether it succeeds, mismatches, or encounters a
browser error. `qa_status` exposes budgets and protocol progress while replacing completed-attempt
status and failed-checkpoint details with a sealed marker. The controller privately records the
ledger, derives each attempt's status, and requires attempt 2 for every sensitive-state scenario;
the model never receives checkpoint `passed` or `failureReason` fields. Arbitrary page text,
page-controlled URLs, option values, browser errors, console/network text, and assertion actuals
therefore do not cross the model boundary. Unauthenticated runs retain rich snapshots and eligible
visual evidence. Sensitive-state reports use zero-duration attempt projections with empty operation,
observation, and artifact lists, and no per-attempt ledger is uploaded; the raw timing, operation,
console, network, and policy-event ledger remains private only long enough to derive status.

The final report still contains the controller-derived status of each predeclared checkpoint. That
is a bounded, non-adaptive Boolean channel: the assertion kind, exact locator or URL matcher, and
expectation are fixed before Playwright starts, and the model cannot branch on an intermediate
result. It is not a confidentiality boundary for real application data. Use only a synthetic,
non-sensitive account and tenant, and never plan a checkpoint whose predicate reveals a credential
or private record.

After changing Juror, the tight loop is `npm run build` followed by the same `node dist/cli.js`
command. An empty evidence directory is used directly. If the requested directory is non-empty,
Juror preserves it, creates an isolated `run-<run-id>` child, and logs the exact path.

### Exact and conservative change ranges

An ordinary two-parent merge whose second parent is the captured PR head, and a one-commit squash
or rebase, resolve to one exact pre-merge base. Unknown or indirect merges fail closed. For every
one-parent result, Juror also asks GitHub for the immutable graph relationship from the captured PR
head to the reported merge commit and proceeds only when those commits are diverged, as expected
after GitHub rewrites a squash or rebase. An identical or reachable captured head is an indirect
merge, not a trustworthy source boundary. For a multi-commit PR whose merge SHA has one parent,
Juror cannot safely infer squash versus rebase from rendered diff equality. It walks the
first-parent topology for at most the retained PR commit count, capped at 100, and records every
plausible base.

If several candidates remain, they must all pass the policy checks above. Juror then uses the
oldest candidate as a conservative source base, so the tested range always contains the PR but can
also contain earlier base-branch changes after a squash. Conservative runs are always verdict-
ineligible: repeated failures remain advisory even when deployment revision proof is otherwise
strong. The report and summary record `base_resolution`, `source_base_sha`, and every
`policy_base_shas` candidate. Repository `AGENTS.md` files are omitted for that run because no one
candidate can safely supply free-form model instructions.

The affected-file patch and an independent NUL-delimited name/status manifest come from local Git
inside Juror's isolated checkout, not from GitHub's rendered PR-diff endpoint or the tested
repository's Git configuration. External diff drivers and text converters are disabled. Binary
paths and full object hashes remain visible without embedding base85 payloads the planner cannot
use. Juror stops before the model or browser if the textual patch exceeds 10,000,000 bytes or the
complete changed-path manifest exceeds 200,000 bytes, rather than testing an incomplete scope.
PR metadata and paths are escaped inside explicitly untrusted JSON prompt blocks.

`SIGINT` and `SIGTERM` cancel the GitHub request/retry loop, trusted policy hydration, instruction
tree reads, checkout materialization, local diff generation, and the browser run. Juror then
removes its exact temporary checkout; this keeps Ctrl-C useful even during the policy-only fast
path.

## Production-shaped local container run

Use the helper when validating the image, filesystem boundaries, and bundled Chromium:

```bash
export JUROR_QA_REPO_DIR=/path/to/product
export JUROR_QA_EVIDENCE_DIR="$PWD/.context/qa-evidence/container-smoke"
qa/run-local.sh \
  --pr <merged-pr-number> \
  --repo example/product \
  --target-url 'https://<immutable-staging-or-branch-deployment>' \
  --allow-origin 'https://<deployment-host>' \
  --target-sha '<40-character-deployed-commit-sha>' \
  --force \
  -v
```

The helper builds `juror-qa:dev` unless `JUROR_QA_IMAGE` names an existing image. Set that
variable after the first build to skip rebuilding while exercising the same image. A provider
key is optional for local use when `codex login` has already created an auth file: the helper
mounts only that file for the trusted controller to copy, never the rest of the Codex home. It
reads the trusted policy before handing over browser/provider credentials, then runs the QA
container on an internal Docker network whose only egress is an exact-origin forward proxy. The
released GitHub Action additionally verifies the public image digest and provenance attestation
first. Linked Git worktrees (including Conductor workspaces) are supported without mounting the
primary checkout: the helper re-homes only the selected worktree's Git metadata and common object
directory at fixed, read-only container paths. Sibling worktree contents remain outside the container.

Chromium receives a rebuilt, minimal runtime environment rather than inheriting the controller's
process environment. GitHub, provider, and application secret variables are omitted; only the
paths, locale, display, certificate, sandbox, and Playwright variables required to launch the
browser are forwarded.

For narrow, blobless, or private clones, the isolated controller checkout automatically fetches
a missing candidate-base or merge tree through an ephemeral, controller-derived GitHub promisor.
After the required objects are materialized, the controller generates the bounded textual patch
and complete path manifest locally with lazy fetching disabled. The tested checkout's remotes,
credential helpers, hooks, filters, and transport configuration are
never used for that fetch. Its token and canonical remote exist only in the trusted Git child
environment and are never written into the source or broker repository.

## Read the evidence

Start with the logged evidence path's `report.json` and the generated Markdown summary.

| Outcome | Interpretation |
| --- | --- |
| `passed` | Every planned checkpoint passed. |
| `no_testable_surface` | Neutral (not scored): trusted path policy or semantic planning found no justified browser scenario. |
| `flaky` | A failed first attempt passed on the required retry. |
| `advisory` | A finding exists, but deployment proof or origin-policy evidence was insufficient for a blocking verdict. |
| `product_issue` | The same credible checkpoint failure reproduced twice on a verified deployment. |
| `blocked` | Juror could not complete trustworthy validation, for example because staging was unreachable. |
| `infrastructure_error` | The agent, browser runtime, or controller failed. |

Useful evidence files include:

- `payload-status.json`: the non-semantic controller marker that keeps pre-browser blocked runs
  distinguishable from an artifact-service failure;
- `plan.json`: affected surfaces, scenarios, checkpoints, and declared mutations;
- each checkpoint's expectation, assertion kind, and canonical locator or URL matcher are sealed
  when the plan is accepted; runtime assertions must match all fields exactly, and an explicitly
  expected 4xx navigation must match a numeric checkpoint in that plan;
- `report.json`: target revision proof, attempts, issues, cleanup, artifact hashes, and warnings;
- per-attempt `operations.ndjson`: the sanitized browser-operation ledger;
- per-attempt `.webm`, `trace.zip`, and screenshots according to evidence policy (all visual and
  trace evidence is omitted when login steps, session bootstrap, secret browser headers, or
  supplied storage state is present
  because pixels and archives cannot be reliably redacted); and
- `agent-events.ndjson` and `agent-result.json`: redacted agent protocol diagnostics.

In GitHub Actions, Juror first validates the completed `payload-status.json` sentinel and strict
`report.json`, then reconstructs an immutable payload in a fresh staging directory from the report
artifact ledger. Every entry must be an allowlisted regular file whose SHA-256 matches the report
and whose exact bytes contain none of the configured secrets; an unlisted file, symlink, missing
entry, hash mismatch, or surviving canary stages nothing and fails closed. When the ledger is empty,
the stager adds a static Action-owned `payload-empty.json` sentinel so the immutable payload remains
uploadable without adding semantic evidence. The staged payload contains browser evidence or that
static sentinel, but no semantic report or completion sentinel. Juror uploads it,
then finalizes the result using that exact payload URL, publishes an
explicitly non-final sticky, and uploads `report.json` plus `summary.md` as a separate immutable
result artifact. Only after that succeeds does the sticky transition to the final verdict; if the
last comment update fails, it remains visibly pending rather than showing a false pass. A failed or
missing payload or result upload rewrites the semantic outcome to `infrastructure_error` before the
check conclusion is applied, even when the browser checkpoints themselves passed. This ordering
prevents an uploaded report from becoming stale when publication or a later artifact phase fails.
Before either semantic file is uploaded, Juror applies key-pattern and configured exact-value
redaction to the final `report.json` object and rendered `summary.md`, constructs the exact bytes
including any destination-specific trailing newline, and scans those bytes plus every staged payload file for each
configured secret value. Trusted finalizer containers receive the secret bundle only for this
scan; model and browser processes never receive it. A surviving canary changes
the run to `infrastructure_error`; it is never published as a successful QA result.

Open a trace with `npx playwright show-trace <path-to-trace.zip>`. Treat `blocked` differently
from `product_issue`: inspect the target proof, warnings, failed requests, and operation ledger
before attributing a failure to the merged code.

## Validation checklist

- The target URL is a staging or branch deployment for the intended repository.
- The target URL has no embedded credentials, query string, or fragment; pass authentication only
  through the dedicated browser-auth mechanisms.
- When independent deployment proof is available, the observed SHA is full length and either
  equals/descends from the PR merge SHA or matches the exact PR head for a preview deployment.
- Check the run's change attribution before assigning causality; conservative ranges add a report
  warning because affected surfaces can predate the merged PR.
- Treat a candidate-policy disagreement, omitted ambiguous-base `AGENTS.md`, a patch above
  10,000,000 bytes, or a path manifest above 200,000 bytes as a trust/scope safeguard, not a
  browser failure.
- Allowed origins are exact HTTP(S) origins; add required API origins with repeated
  `--allow-origin` flags or trusted `.juror.yml` configuration.
- Authentication uses a dedicated synthetic, non-sensitive account and resettable tenant.
- A support-session configuration is staging-only, has `preview_fallback: false`, binds its
  redirect to the resolved canonical staging origin, and mints a new one-time URL for each attempt.
- Every secret browser header is scoped to explicit exact origins. Verify that the live gateway
  recognizes the configured header; an allowed readiness `403` is not proof of
  successful browser authentication.
- Shared staging does not enable an arbitrary-user testing-login bypass.
- The accepted plan fixes each checkpoint's assertion kind and exact locator or URL matcher.
- The operation budget can cover two runs of every planned checkpoint; Juror rejects a plan when
  `2 × (one navigation + one snapshot + checkpoint count)` summed across scenarios exceeds the
  trusted limit.
- Authenticated browser calls expose one identical sealed acknowledgement, `qa_status` hides
  outcomes, and the controller requires the deterministic second-attempt protocol.
- Page-controlled text and URLs must not appear in model-visible output or the operation ledger.
- No credential appears in the plan, report, operation ledger, screenshots, or agent events.
- The completed report, summary, and payload pass configured-secret exact-value scans.
- Cleanup reports `passed` or `not_required` before treating a result as trustworthy.

## References

- [Post-merge agentic E2E QA implementation plan](post-merge-agentic-e2e-qa-plan.md)
- [Threat model](threat-model.md)
