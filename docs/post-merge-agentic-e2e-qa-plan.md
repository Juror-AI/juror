---
date: 2026-08-18
author: Jay Derinbogaz
title: Post-Merge Agentic E2E QA Implementation Plan
tags: [qa, e2e, playwright, github-actions, codex]
---

# Post-Merge Agentic E2E QA

## Overview

Juror will gain an opt-in, GitHub-native QA mode that reacts to merged pull requests, identifies the user-facing behavior most likely to be affected, and tests that behavior against a live staging or branch deployment. A supervised Codex harness will plan and operate Playwright like a human tester, while a trusted controller enforces security, test limits, evidence collection, cleanup, and result publication.

The first version remains consistent with Juror's current stateless distribution model:

- It runs in GitHub Actions rather than a Juror-hosted service.
- It requires no database or long-running control plane.
- It resolves a signed QA container to an immutable digest, verifies its provenance, and executes
  only that digest.
- It uses one autonomous Codex session running GPT-5.6 Luna with medium reasoning effort.
- It records video for unauthenticated scenarios and richer diagnostics for failures; visual and
  trace evidence is suppressed whenever the browser uses login steps, a support-session bootstrap,
  secret browser headers, or supplied state.
- It posts a separate QA report on the merged pull request and fails the job for verified product issues or an inability to complete the promised validation.

This document is the implementation contract for the feature. It describes the product behavior, trust boundaries, public interfaces, delivery phases, and acceptance tests.

## Goals

1. Observe same-repository pull requests merged into the default branch.
2. Resolve a live deployment that can be tied to the merged code whenever possible.
3. Analyze the pull request diff and plan a small set of affected user journeys.
4. Exercise those journeys through a real browser in an isolated container.
5. Adapt to normal UI variation without allowing unbounded or unsafe agent behavior.
6. Distinguish reproducible product problems from flaky tests, target drift, authentication failures, and infrastructure failures.
7. Produce useful evidence: a structured result, human-readable summary, eligible videos, and failure diagnostics.
8. Clean up all synthetic data created during a run.
9. Keep the feature explicitly opt-in and preserve the security posture of Juror's existing review harnesses.

## Non-goals for v1

- A hosted Juror monitoring service, scheduler, database, or web dashboard.
- Testing pull requests from forks or exposing secrets to fork-controlled workflows.
- Running against production or mutating real customer data.
- Exhaustive regression testing unrelated to the merged change.
- A required baseline smoke suite when no user-facing behavior is affected.
- Multi-browser compatibility testing; v1 uses Chromium only.
- Generating and executing arbitrary Playwright JavaScript from model output.
- Proving that a problem was caused by the pull request when staging also contains later commits.
- GitHub Enterprise Server or non-GitHub CI support.

## Product decisions

| Area | v1 decision |
| --- | --- |
| Runtime | GitHub Actions |
| Enablement | Explicit opt-in through `juror init --qa` and `qa.enabled` |
| Trigger | Same-repository PR closed and merged into the default branch; each PR keeps an independent, lossless workflow run |
| Primary target | Staging deployment |
| Fallback target | Exact-head branch/preview deployment when configured, except for origin-bound staging support sessions |
| Static staging fallback | Allowed, but unverified findings are advisory only |
| Automated staging authentication | Fresh fixed-identity support session per attempt, bound to one canonical staging origin; no preview or production use in v1 |
| Execution model | One autonomous Codex session with a supervised browser broker |
| Model | GPT-5.6 Luna, medium reasoning effort |
| Scope | Affected user journeys only |
| Limits | Six scenarios, 40 browser operations total, 20 minutes execution time |
| Browser | Desktop Chromium by default; mobile viewport only when relevant |
| Mutation policy | Broad UI autonomy inside a dedicated, resettable QA tenant |
| Reproduction | Two-attempt capacity is reserved for every plan; authenticated or supplied-state scenarios always run a sealed second attempt, while an unauthenticated failure may use one adaptive retry |
| Evidence | Video for unauthenticated attempts; failure traces/screenshots only without authenticated browser state; structured evidence for every run |
| Retention | 14 days |
| Verified issue behavior | Fail the GitHub job |
| Blocked/infrastructure behavior | Fail the GitHub job, but report a non-product outcome |
| Fork PRs | Deferred |

## System architecture

```text
pull_request.closed
        |
        v
managed juror-qa.yml workflow
        |
        +--> trusted host controller
        |      - validates event and trusted policy
        |      - resolves and verifies deployment
        |      - verifies QA image identity
        |      - starts isolated runtime
        |
        v
signed QA container pinned by digest
        |
        +--> trusted browser broker
        |      - performs secret-backed login or mints a one-time staging support session
        |      - injects optional browser headers only on exact configured origins
        |      - enforces action, origin, and time budgets
        |      - owns Playwright contexts and private outcome ledgers
        |
        +--> one Codex session
        |      - analyzes the merged diff
        |      - emits a schema-valid test plan
        |      - operates only through broker tools
        |      - uses adaptive unauthenticated retries or a fixed sealed retry protocol
        |
        +--> trusted teardown
               - resets or deletes synthetic data
               - exact-redacts and selects artifacts
               - writes and scans the structured result and summary
        |
        v
GitHub job summary + PR QA comment + Actions artifact
```

The existing code-review harness must not be expanded to provide browser, shell, or network access. QA is a separate runtime and trust domain with separate prompts, schemas, process supervision, and release artifacts.

## End-to-end lifecycle

### 1. Trigger and eligibility

`juror init --qa` creates a separate managed workflow, `.github/workflows/juror-qa.yml`. The workflow listens for `pull_request` events of type `closed` and proceeds only when all of the following are true:

- `github.event.pull_request.merged` is `true`.
- The pull request targets the repository's default branch.
- The head repository is the same as the base repository.
- QA is enabled in trusted configuration.
- The event contains a merge commit SHA and sufficient repository metadata.

Unmerged, forked, malformed, or disabled events exit successfully before retrieving secrets or starting the QA image. Fork support is deferred until Juror has an explicit untrusted-contribution security design.

Each merged PR gets an independent concurrency group. GitHub retains at most one pending run in a shared group, so using a repository-wide group would silently replace older merges during a burst. Per-PR groups preserve every event; reset hooks and fixtures receive the stable run ID derived from the repository, pull request number, and workflow run ID so mutable QA state can be isolated. Teams whose staging tenant cannot isolate concurrent runs should use a single-capacity runner group until Juror adds a durable hosted queue.

The generated job timeout is 95 minutes. This covers the maximum trusted deployment wait of
60 minutes plus the maximum 20-minute browser run and leaves 15 minutes for checkout, image
startup, the final reset and target recheck, evidence finalization, and publication. The workflow
timeout must not be lower than the sum of valid controller budgets plus finalization headroom.

### 2. Establish trusted policy and change scope

The merged change is not allowed to redefine the policy that governs its own QA run. Before
processing model-visible input, the controller derives every plausible pre-merge base from commit
topology and evaluates the following repository-owned policy at those revisions:

- Juror configuration.
- Browser origin allowlist.
- Authentication policy, including support-session origin binding, exact-origin browser headers,
  and declarative setup steps.
- Reset and cleanup definitions.
- Application-specific QA hints.
- Repository `AGENTS.md` instructions for exact-base runs.
- Workflow-controlled limits.

The merged source and its patch are untrusted test context; neither can alter controller policy.
Branch protection should require review for the managed QA workflow and trusted configuration
paths.

An ordinary two-parent merge has one exact topology-derived base only when its second parent equals
the captured PR head; unknown or indirect merges fail closed. A one-parent result must additionally
have a `diverged` GitHub commit-graph relationship from the captured PR head to the reported merge
commit. `identical`, `ahead`, or `behind` relationships are indirect or otherwise unrecognized and
fail closed. A one-commit squash or rebase then uses the merge SHA's first parent. A multi-commit PR
whose reported merge SHA has one parent is ambiguous because that SHA can be either a squash commit
or the final commit of a rebase. Juror therefore enumerates the plausible first-parent bases M¹
through Mᴺ, where N is GitHub's retained PR commit count. The walk is capped at 100 candidates and
stops after a candidate whose own parent count is not one. Invalid, unbounded, or unsupported
histories fail closed. API-rendered PR diff equality is never treated as commit-identity or
policy-trust proof.

Every plausible base must be available and must yield safe, parseable QA policy. All candidates
must agree on `qa.enabled`; when QA is enabled or `--force` will consume dormant fields, their
normalized parsed `qa` configurations must be identical. A missing, malformed, unsafe, or
conflicting candidate blocks the run instead of choosing whichever revision is convenient.
Repository-owned configuration above 262,144 bytes is rejected from Git tree metadata before its
contents are read or parsed. When all candidates disable QA and the run is not forced, differences
in unused fields are harmless.

When the candidate set has one member, the change range is exact and trusted `AGENTS.md`
instructions can be loaded from that base. When several candidates remain plausible, Juror uses
the oldest candidate as a conservative source base. This guarantees that the tested range contains
the merged PR, but a squash can make the range include earlier base-branch changes. Juror records
the resolution, source base, and full candidate list as structured report fields, makes every
conservative finding advisory regardless of deployment proof, and omits all repository `AGENTS.md`
instructions rather than risk treating a rebased PR commit as trusted policy.

After the merge and selected source-base trees are fully materialized, the isolated controller
generates the `source-base..merge` textual patch and an independent NUL-delimited name/status
manifest with local Git. It uses empty controller-owned Git configuration and disables external
diff drivers and text converters. Binary paths and full object hashes are retained without base85
payload bodies. If the patch exceeds 10,000,000 bytes or the complete path manifest exceeds 200,000
bytes, Juror blocks before planning instead of silently truncating affected files. PR metadata and
paths are JSON-escaped inside explicit untrusted prompt boundaries.

### 3. Resolve a deployment target

The resolver polls for up to 15 minutes, then selects the first usable target in this order:

1. A successful GitHub deployment for the configured deployment environment (or the `staging` security tier when no separate selector is set) whose deployed SHA equals the merge SHA or is a descendant of it.
2. The configured static staging URL when its commit probe proves that the live application SHA equals or descends from the merge SHA.
3. A successful branch/preview deployment tied to the pull request's exact head SHA, when preview fallback is enabled.
4. A healthy static staging URL whose revision cannot be verified.

For GitHub deployments, Juror reads deployment records and their latest successful statuses, using `environment_url` as the browser target. Descendant checks use the GitHub commit comparison API. For a static target, the configured commit probe returns a JSON value such as a build SHA from `/version`.

The resolved target record includes:

- Target kind: `staging-deployment`, `staging-static`, or `preview-deployment`.
- Base URL and allowed origin.
- Deployment and deployment-status IDs, when present.
- Observed deployed SHA and verification method.
- Whether the merge SHA is present in the deployment ancestry.
- Additional commits present beyond the merge.
- Resolution and readiness timestamps.
- Whether findings are allowed to affect the product verdict.

If a static target is healthy but its revision cannot be proved, Juror may still test it, but all findings are advisory and cannot produce `product_issue`. If no healthy target can be resolved within the wait window, the outcome is `blocked`.

Immediately after browser execution, Juror resolves the target revision again. A changed deployment ID or SHA makes the run `blocked` because the evidence no longer refers to a stable application version. When a verified descendant contains later commits, reporting says the issue was "found while validating PR #N" rather than claiming the PR caused it.

### 4. Analyze impact and create the test plan

The single Codex session receives a bounded context bundle containing:

- Pull request title, description, labels, and author-provided test notes.
- Merge SHA, source-base SHA, exact/conservative attribution, every policy candidate, and the
  independently generated affected-file list.
- A model-budget excerpt of the locally generated patch plus the independently generated complete
  path inventory after enforcing both scope limits.
- Repository `AGENTS.md` instructions from the exact base, or an explicit omission notice when the
  topology remains ambiguous.
- Target metadata without credentials.
- The plan schema and browser tool contract.

Before target resolution or that Codex session starts, the controller evaluates the complete
changed-path manifest against trusted `qa.testability.early_exit_paths` rules loaded from the
pre-merge policy consensus. The default list is empty. A run exits as
`no_testable_surface` only when every path matches; missing manifests, mixed changes, invalid paths,
and unmatched rename sides fail open to the semantic planner. This controller-authored result is
reported as neutral and not scored, persists its fixed plan, costs zero model tokens, and does not
load QA secrets or launch Playwright.

The first required model output is a schema-valid `QaPlan`. Browser operations remain mechanically disabled until this plan passes validation. The plan contains:

- A concise impact assessment.
- The user-facing surfaces inferred from the change.
- A `no_testable_surface` explanation when applicable.
- Up to six prioritized scenarios.
- Preconditions and required seeded state for each scenario.
- Desktop or mobile viewport choice with justification.
- Ordered checkpoints expressed as observable user outcomes.
- Immutable checkpoint IDs, expectations, and executable assertion semantics. Each checkpoint
  predeclares one assertion kind (`visible`, `hidden`, `text`, `value`, `url`, or `status`) plus its
  canonical locator or URL matcher as applicable. Execution must copy every accepted field exactly,
  so the agent cannot swap the tested element, path predicate, or comparator after the browser opens.
- Allowed mutation categories and expected cleanup.
- Risk notes and any expected blind spots.

The planner must choose affected-only testing. Documentation-only, test-only, tooling-only, or backend-internal changes with no reachable user surface may produce `no_testable_surface`; Juror does not add a generic smoke test in that case. A user-observable surface that the current target, configuration, or action policy cannot exercise is blocked, not `no_testable_surface`.

### 5. Prepare authentication and isolation

The trusted broker prepares browser state inside each isolated scenario context:

1. Create or reset a dedicated synthetic QA tenant.
2. Prefix run-created objects with `juror-<pr>-<run-id>`.
3. Start a fresh Playwright context for each scenario or retry.
4. When configured for canonical staging, ask the trusted support-session endpoint for a fresh
   single-use redirect URL, validate its origin against the configured target origin, and consume
   it inside that attempt's context. The endpoint chooses the fixed synthetic identity; the request
   accepts no user-controlled email, tenant, user, or data-config selector.
5. Inject each optional secret browser header only into requests whose exact origin is listed for
   that header. Do not match host suffixes, redirects, branch previews, or arbitrary subdomains.
6. Load a bounded operator-supplied storage-state file, when configured, then execute the login
   recipe using logical secret references inside that same context.
7. Keep cookies, local/session storage, and IndexedDB in the scenario context without serializing
   deployment-controlled browser state through the controller.
8. Suppress video, screenshots, and traces for the entire run when login steps, a session bootstrap,
   secret browser headers, or a storage-state file is present; reset-only secrets never enter
   Playwright and do not suppress visual evidence.
9. Consume a scenario/attempt setup admission before reset, browser launch, context creation, or
   login. The entire sensitive setup has a fixed 10-second response window and a hard 9.75-second
   execution cutoff. Individual reset and auth-wait timeouts are only upper bounds inside that
   envelope. At cutoff the reset signal is aborted and any pending browser context is closed.
   A failed admission becomes an absorbing private blocked attempt: the agent still receives the
   same sealed start and browser acknowledgements, but the admission cannot be replayed against the
   reset or identity service and is never classified as a product issue.

The support-session path is a staging-only v1 capability. Trusted configuration must require
`qa.target.environment: staging`, an exact canonical `target_origin`, and
`qa.target.preview_fallback: false`; runtime target binding rejects production and preview
deployments even if configuration is inconsistent. An optional exact
`qa.target.deployment_environment` selects an isolated GitHub deployment stream without changing
that staging security tier, and runtime binding requires the resolved record to match it. This uses
a fixed synthetic-monitor endpoint, not the retired arbitrary-user testing-login bypass. Target readiness is resolved before secret
handoff, so readiness probes never receive the browser Access service-token pair or WAF header; a
configured intentional Cloudflare `403` can establish endpoint presence, but only sealed browser
setup establishes that authentication actually works.

Authenticated or supplied-state browser tools use a sealed observation mode. After protocol
validation, navigation, interaction, waiting, snapshots, assertions, and scenario finalization all
return the same fixed acknowledgement regardless of page outcome. `qa_status` exposes only budgets,
active protocol state, and sealed completed-attempt markers; it does not reveal attempt status,
failed checkpoints, assertion pass/fail, or mismatch-versus-tool-error details. Arbitrary DOM text,
page-controlled URLs, option values, browser errors, console/network text, and raw assertion actuals
are omitted rather than persisted. The controller keeps raw operation outcomes only in its private
in-memory ledger until classification; sensitive-state reports use a zero-duration projection with
empty operation, observation, and artifact lists, and no per-attempt file is uploadable. Only the
aggregate attempt status and fixed checkpoint results remain. This boundary covers credentials or private data that
are transient, HTTP-only, IndexedDB-encoded, or never storage-backed; exact-value polling cannot
provide that guarantee.

Codex never receives the GitHub token, application credentials, cookies, authorization headers,
authentication storage state, decoded secret bundle, or authenticated checkpoint outcome. The model
sees only logical identities such as `qa_admin`; trusted setup errors use fixed controller messages.

Before planning, Codex may search for literal text and read bounded line ranges through a dedicated
source inspector. It is confined to an explicit allowlist of source and documentation extensions
in the sealed checkout, excludes sensitive filenames and secret-shaped values, does not expose
version-control metadata, never follows symbolic links, and enforces per-file, aggregate-byte,
result, and call limits. This lets the planner derive affected routes and stable locators without
receiving a general shell or filesystem tool.

### 6. Execute scenarios

After the plan gate opens, Codex operates Chromium through a narrow Playwright broker. The broker exposes semantic browser tools such as navigation, role- or label-based element lookup, click, fill, select, key press, wait, text inspection, URL inspection, and checkpoint assertion.

The broker binds every runtime assertion to its accepted checkpoint ID, expectation, kind, canonical
locator, and URL matcher. Any semantic difference is rejected before evaluation. Explicit non-success
navigation statuses are limited to 4xx responses and must already appear as an exact numeric
checkpoint expectation; unexpected 5xx responses always fail closed.

The broker does not expose:

- Arbitrary JavaScript evaluation.
- Direct Chromium launch arguments.
- Shell access.
- General filesystem access.
- Cookie or storage export.
- Raw request headers.
- Unrestricted HTTP clients.
- Direct Playwright or Chrome DevTools protocol handles.

Every accepted broker operation is written to a scenario ledger. The controller enforces the shared run limits regardless of model instructions:

- Maximum six planned scenarios.
- Maximum 40 browser operations across initial attempts and retries.
- Maximum 20 minutes of browser execution.
- Before the browser unlocks, the controller reserves the minimum operations needed for two runs of
  every checkpoint: `2 × (one navigation + checkpoint count)` summed across scenarios. Plans above
  the configured operation budget are rejected; the minimum does not include optional interactions,
  so planners should leave additional margin.
- Desktop Chromium by default.
- A mobile Chromium viewport only for a scenario whose affected surface is responsive or mobile-specific.
- Navigation and subresource access only through the configured network allowlist.

The browser may mutate data broadly only inside the dedicated QA tenant. The agent contract forbids
account destruction, billing, permission escalation, external messages, and cross-tenant actions;
the mechanical containment is the resettable synthetic tenant plus exact-origin egress, so trusted
policy must never connect this mode to production data, payment credentials, or real messaging.

When trusted policy has no reset hook and `interaction_policy` is `disabled`, the broker disables
click, fill, press, select, and check before they touch the page. That mode still supports direct
navigation, snapshots, waits, and assertions, including passive same-origin GraphQL POST reads and
WebSocket-backed rendering. If reviewed policy selects `interaction_policy: read_only`, semantic
actions declared with `mutation: none` are enabled. The first action arms a controller-owned write
barrier for the remainder of the attempt: HTTP methods other than GET, HEAD, and OPTIONS are denied,
outbound WebSocket messages are not forwarded, and any such denial makes the attempt blocked. This
supports local UI state such as dialogs, tabs, filters, and client-side search without trusting the
model's mutation label as the safety boundary. A trusted reset hook remains the explicit switch for
persistent create, update, delete, and upload journeys in the disposable tenant.

When an affected journey requires an action disabled by either policy, the planner retains the exact
affected scenario and checkpoints, executes only its allowed prefix, and closes the attempt as
blocked. It must not turn a policy or configuration limitation into a neutral
`no_testable_surface` result.

### 7. Retry and classify observations

For an unauthenticated scenario, the same Codex session may inspect a disclosed failure, reset
scenario state, adapt its navigation strategy without changing the accepted checkpoint semantics,
and retry once. Authenticated and supplied-state scenarios follow a different deterministic
protocol: every scenario must complete attempts 1 and 2 whether the first internally passed,
mismatched, or hit a browser/tool error. The model receives identical acknowledgements and cannot
branch the second attempt on page-dependent feedback. The controller derives both attempt statuses
from its private operation and assertion ledgers; model-authored status or issue prose cannot
override that evidence.

Sealed mode reduces the model-visible surface but does not make arbitrary application data safe.
After model execution, the final report reveals a bounded pass/fail result for each checkpoint whose
exact predicate was accepted before the browser opened. This is a non-adaptive Boolean channel, not
a general confidentiality guarantee. Authenticated QA therefore requires a synthetic account and
tenant containing no production data, customer content, real communications, payment material, or
other sensitive records. Plans must not use checkpoints to test for credentials or private values.

A failure becomes a verified product issue only when:

- The target revision is verified and stable.
- Trusted authentication and test-state setup succeeded.
- Both attempts fail the same user-visible checkpoint.
- Both attempts show materially equivalent observable behavior.
- The failure is not better explained by a missing locator, timeout, denied policy action, navigation outside the allowlist, target drift, or runner/browser infrastructure.

Classification rules:

| Observation | Classification |
| --- | --- |
| Unauthenticated initial attempt passes | Passed scenario without a retry |
| Both sealed attempts pass | Passed scenario |
| Initial attempt fails and retry passes | Flaky scenario |
| Both attempts fail the same checkpoint consistently | Product issue candidate |
| Only the second attempt fails, or attempts fail for different/ambiguous reasons | Inconclusive; contributes to `blocked` or `infrastructure_error` |
| Unverified target shows a consistent issue | Advisory finding |
| No affected browser surface is found | `no_testable_surface` |

### 8. Clean up and collect evidence

Teardown runs in an `always()` path and is controlled outside the model session. It invokes the configured reset endpoint or deletes resources carrying the run prefix, then verifies cleanup where possible. Cleanup failure is recorded and prevents a clean pass.

Evidence policy:

- Record video for every scenario attempt only when there are no login steps, support-session
  bootstrap, secret browser headers, or supplied storage state. Authenticated runs retain only
  sealed structured evidence because pixels cannot be reliably redacted without an OCR/masking
  pipeline.
- Retain all videos for 14 days.
- On failed unauthenticated attempts, also retain the Playwright trace and final
  screenshots. Every attempt retains sanitized console messages, sanitized failed-request metadata,
  and the broker operation ledger.
- Include the final plan and machine-readable result for every run.
- Do not collect authentication video, passwords, cookies, storage state, request/response bodies by default, authorization headers, private agent homes, or unrestricted scratch directories.
- Upload only files matching fixed controller-owned artifact manifests. Before upload, require a
  strict completed report and payload sentinel, rebuild a fresh staging directory from the report
  ledger, and require every entry to be an allowlisted regular file with the reported SHA-256 and
  no configured secret bytes. If the ledger is empty, add only a static controller-owned upload
  sentinel so pre-browser results remain deliverable. Any missing, unlisted, symlinked, mismatched,
  or canary-bearing entry stages nothing and fails closed. Upload browser evidence as
  an immutable payload without `report.json`, `summary.md`, or the completion sentinel; finalize and publish against the
  payload's exact URL, publish a visibly non-final sticky, then upload the finalized report and
  summary as a separate immutable result. Transition the sticky to its final verdict only after the
  result artifact succeeds, so a publication failure can leave at worst a pending—not false-pass—comment.
  Any payload or result upload failure becomes `infrastructure_error`; never mutate semantic files
  after the result artifact succeeds.
- Apply key-pattern and configured exact-value redaction to evidence, the final structured report,
  and the rendered Markdown summary. Build public issue fields only from accepted plan/controller
  evidence, never unredacted model prose.
- Run the configured-secret canary scan after the exact emitted `report.json` and `summary.md`
  bytes—including any destination-specific trailing newline—are created, and scan
  both semantic files plus the immutable staged payload before upload. Pass the secret bundle by
  name only to the trusted finalizer and publisher containers that perform those scans. Any surviving exact
  value fails closed as `infrastructure_error` instead of publishing a successful result.

### 9. Publish the result

Juror writes a versioned JSON report, a GitHub job summary, and a separate sticky pull request comment marked with:

```html
<!-- juror:qa:v1 -->
```

The report includes:

- Overall semantic outcome and GitHub job conclusion.
- Structured `base_resolution`, `source_base_sha`, and ordered `policy_base_shas` attribution.
- Tested URL, target kind, deployment identity, and observed SHA.
- Verification status and any additional commits in the tested deployment.
- Planned scenarios and why they were selected.
- Attempt-by-attempt checkpoints, expected behavior, and observed behavior.
- Verified issues, flaky scenarios, and advisory findings.
- Cleanup status.
- Model and browser versions.
- Runtime and estimated model cost.
- A link to the GitHub Actions artifact containing permitted videos and diagnostics.

Juror does not post inline diff comments for QA results. Code-review and QA comments use different markers and update independently.

## Outcome model

`QaRunResult.outcome` is one of:

```text
passed
no_testable_surface
flaky
advisory
product_issue
blocked
infrastructure_error
cancelled
```

The semantic result and GitHub job status are intentionally separate:

| Semantic outcome | GitHub job | Meaning |
| --- | --- | --- |
| `passed` | Success | All planned scenarios passed |
| `no_testable_surface` | Success | The merged change had no affected browser surface |
| `flaky` | Success | A retry passed; evidence is retained |
| `advisory` | Success | Findings came from an unverified target and are non-blocking |
| `product_issue` | Failure | A stable verified target reproduced a user-visible issue twice |
| `blocked` | Failure | Juror could not complete trustworthy validation |
| `infrastructure_error` | Failure | The QA runtime, browser, artifact upload, or trusted setup failed |
| `cancelled` | Cancelled | GitHub cancelled the workflow |

GitHub Actions has no native neutral process exit that matches the desired visibility. Therefore `blocked` and `infrastructure_error` fail the job, while the report clearly states that they are not product regressions.

## Public interfaces

### CLI

Add these commands and options:

```text
juror qa --pr <number> [--target-url <url>] [--post] [--json <path>] [--evidence-dir <path>]
juror init --qa [--target-url <url>] [--allow-origin <origin>] [--set-secrets]
```

`juror qa` is primarily the container entry point but remains locally invocable for maintainers. `--target-url` is an explicit override and must still pass origin and readiness policy. `--post` enables GitHub publication; without it, the command only writes local output.

`juror init --qa`:

- Adds or updates the separate managed QA workflow.
- Adds an explicit `qa` configuration block. A target URL automatically adds its exact origin;
  repeatable allowed origins support deployment discovery and required APIs.
- Enables a new block only when a target URL or allowed origin is supplied. Otherwise it writes a
  safely disabled block and prints concrete enablement guidance.
- Optionally guides the user through setting the fixed GitHub secret used by the broker.
- Pins the Juror action by full commit SHA. The action resolves the matching released image to an
  immutable digest, verifies its provenance against that source revision, and executes by digest.
- Preserves unrelated user-authored workflow and configuration content.

### QA action

Add a subdirectory action at `qa/action.yml` with these outputs:

```text
outcome
issues
scenarios
target-kind
target-sha
cost-usd
artifact-url
report-path
image-digest
```

The action is orchestration glue. The security-sensitive implementation lives in the signed image and trusted controller, not in mutable shell assembled by the consuming repository.

### Configuration

Extend configuration version 1 with an optional top-level `qa` object. The runtime default is
`qa.enabled: false`; `juror init --qa --target-url https://staging.example.com` writes an enabled
block such as:

```yaml
qa:
  enabled: true
  model:
    id: gpt-5.6-luna
    reasoning_effort: medium
  target:
    strategy: staging-first
    environment: staging
    deployment_environment: null
    static_url: https://staging.example.com
    readiness_path: /health
    readiness_statuses: null # set exact values such as [410] only for intentional tombstones
    commit_probe:
      path: /version
      json_pointer: /gitSha
    preview_fallback: true
    wait_seconds: 900
  auth:
    session_bootstrap: null
    browser_secret_headers: []
    steps: []
  sandbox:
    allowed_origins:
      - https://staging.example.com
    interaction_policy: disabled
    reset: null
  limits:
    max_scenarios: 6
    max_browser_operations: 40
    timeout_seconds: 1200
    mobile_when_relevant: true
  evidence:
    video: all
    trace: failure
    screenshot: failure
    retention_days: 14
```

An origin-bound support session intentionally changes the target policy. A generic canonical
staging configuration is shaped as follows:

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
    interaction_policy: read_only
  evidence:
    video: off
    trace: off
    screenshot: off
```

The readiness exception accepts the Cloudflare gate's unauthenticated `403` only because target
resolution happens before secret handoff; the resolver does not inject browser headers. The sealed
browser bootstrap remains authoritative. It waits for `qaSessionReady` to become non-empty in
local or session storage without returning the token value. Failure to reach that state within the
fixed sealed setup window blocks the attempt before agent access, so an unauthenticated login shell
cannot become a product finding. This example is operational only after the staging backend
identity/token settings, the dedicated runtime-only Cloudflare Access
service token and Service Auth policy, and the separate `X-Staging-Gateway-Token` WAF rule are verified.
The `CF-Access-*` values must never be embedded in frontend assets. This is configuration guidance,
not evidence of a passing live staging smoke.

Evidence modes are upper bounds: the trusted controller forces video, trace, and screenshot modes
to `off` whenever login steps, a session bootstrap, secret browser headers, or a storage-state file
is present. A secret used only by the reset hook remains controller-owned and does not affect
browser evidence.

All fields are strictly validated. User configuration may lower limits but cannot raise controller
hard caps. A plan is rejected unless its browser-operation budget covers the two-attempt minimum
for every scenario, and setup admissions plus the per-admission authentication deadline are enforced
outside model control. The generated 95-minute job budget covers the maximum 60-minute deployment
wait and 20-minute run with 15 minutes of finalization headroom. `allowed_origins` is enforced by the
container-level egress proxy, not treated as a browser-only security boundary.

Authentication steps form a constrained declarative recipe. Session-bootstrap credentials and
browser headers use the same logical-reference contract. The fixed GitHub Actions secret
`JUROR_QA_SECRETS_B64` contains a base64-encoded JSON map of those logical keys. Base64 is transport
encoding, not encryption; the controller decodes the map only in trusted memory, passes values
directly to the broker, registers them with the redactor, and never places them in model context or
command output. A session endpoint returns a fresh one-time URL for each attempt; that URL and the
underlying bearer/header values are never exposed to the model, persisted as storage state, or
reused for the deterministic second attempt.

Every trusted browser-auth mode also requires a canonical `qa.target.static_url`. At runtime the
resolved target origin must match it exactly (and must match `session_bootstrap.target_origin` when
session bootstrap is enabled). This applies to explicit target overrides as well as discovered
deployments. Browser secret-header origins must also equal that canonical target origin, preventing
a branch, preview, or allowlisted subresource origin from receiving canonical-staging credentials.

### Domain types

Add QA-specific types rather than overloading the existing code-review result model:

- `QaTarget`: URL, target kind, deployment identity, revision proof, stability, and verdict eligibility.
- `QaPlan`: impact assessment, testability decision, scenarios, and safety metadata.
- `QaScenario`: viewport, preconditions, checkpoints with immutable assertion semantics, and cleanup expectations.
- `QaAttempt`: broker ledger, observations, checkpoint status, timing, and evidence references.
- `QaIssue`: reproducibility, severity, expected and actual behavior, and affected scenario.
- `QaArtifact`: kind, path, sanitization status, checksum, retention, and upload identity.
- `QaRunResult`: schema version, semantic outcome, target, plan, attempts, issues, cleanup, cost, and artifact metadata.

All persisted JSON includes a schema version. Parsing must reject unknown required enum values and malformed model output rather than repairing it into executable behavior.

## Security and containment

### Trust zones

The implementation has four explicit zones:

1. **Host controller:** Holds the GitHub token, reads trusted configuration, resolves deployments, verifies the image, starts the runtime, uploads evidence, and publishes results.
2. **Trusted bootstrap and broker:** Receives only the application secrets it needs, logs in, owns authenticated browser state and outcome ledgers, enforces tools and limits, and sanitizes or seals browser observations.
3. **Codex agent:** Receives untrusted source/diff context, sanitized unauthenticated observations,
   bounded read/search results from the sealed source checkout, and fixed acknowledgements for
   sensitive-state browser calls. It has no raw secrets, GitHub token, general shell, direct
   filesystem, unrestricted network access, or authenticated outcome feedback.
4. **Trusted teardown and publisher:** Resets test state, exact-redacts and selects artifacts, writes
   and scans the final result and summary, and performs GitHub mutations.

### Container controls

The QA runtime must run:

- As a non-root user.
- With a read-only root filesystem and explicit writable temporary mounts.
- With Linux capabilities dropped.
- With Chromium's sandbox enabled.
- Without a Docker socket or host process namespace.
- Without repository `.git` metadata in the model-visible source mount.
- With CPU, memory, process, and wall-clock limits.
- Behind a deny-by-default egress proxy that allows only the resolved target and configured application origins.
- With distinct writable locations for broker-owned evidence and model-owned scratch data.
- With a rebuilt Chromium child environment that contains only required path, home/temp, locale,
  display, certificate, sandbox, and Playwright variables. GitHub, provider, and application
  credential variables are never inherited by the browser process.

Playwright origin filtering remains defense in depth; the network proxy is the authoritative egress boundary. Redirects, WebSockets, workers, downloads, and subresources must all pass the same allowlist.

### Image supply chain

Juror publishes a public multi-architecture image containing pinned versions of Node.js, Codex,
Playwright, Chromium, the broker, and the QA prompt. The release workflow:

1. Builds the image from a locked dependency graph.
2. Runs unit, integration, browser, and containment tests.
3. Generates an SBOM.
4. Pushes the image to GHCR.
5. Creates OIDC-backed build provenance and an artifact attestation.
6. Records the immutable image digest in the corresponding Juror release manifest.

The managed workflow pins the Juror action to a source commit. That action resolves its matching
release tag (or an explicitly supplied image reference) to
`ghcr.io/juror-ai/juror-qa@sha256:<digest>`, verifies the digest and attestation's expected source
repository/workflow/revision identity before injecting credentials, and then executes with
`--pull=never` by digest. Tag-only execution is forbidden.

## Proposed source layout

```text
src/
  qa/
    agent.ts               # supervised Codex process and usage parsing
    browser.ts             # trusted Playwright broker and evidence capture
    config.ts              # strict QA config parsing and hard caps
    mcp.ts                 # broker MCP tool surface
    rpc.ts                 # local controller/broker transport
    run.ts                 # orchestration, classification, cleanup, and artifacts
    schema.ts              # versioned plan/result schemas and validation
    source.ts              # bounded read-only inspection of the sealed checkout
    types.ts               # QA domain contracts
  github/
    deployments.ts         # deployments, statuses, and commit comparison
    merged-pull.ts         # topology-derived policy candidates and conservative source base
    publish-qa.ts           # independent QA sticky-comment publication
  render/
    qa-summary.ts           # job summary and sticky PR comment
  prompts/
    qa.md                  # agent role and workflow
qa/
  action.yml               # reusable GitHub Action entry point
  Dockerfile               # pinned multi-architecture runtime image
  egress-proxy.mjs         # exact-origin outbound proxy
  tls-client-hello.mjs     # CONNECT authority/SNI validation
  seccomp_profile.json     # Chromium-compatible syscall boundary
  run-local.sh             # fast production-shaped local loop
.github/workflows/
  release-qa-image.yml
```

The exact module split may change during implementation, but the controller, broker, agent, and publisher boundaries must remain explicit and independently testable.

## Implementation phases

### Phase 1: Contracts and opt-in configuration — Critical Priority

1. Add `Qa*` domain types and versioned JSON schemas, including immutable checkpoint assertion
   kinds and canonical locators/URL matchers.
2. Extend strict configuration parsing with the optional `qa` block and safe defaults.
3. Add CLI parsing for `juror qa` and `juror init --qa` without executing a browser yet.
4. Define semantic outcomes, exit-code mapping, and machine-readable report format.
5. Add the distinct QA sticky-comment marker and renderer skeleton.
6. Add fixtures for enabled, disabled, malformed, and limit-exceeding configurations.

This phase establishes stable interfaces for the remaining work. Type/config tests and renderer work can proceed in parallel after the schemas settle.

### Phase 2: GitHub trigger and target verification — Critical Priority

1. Add merged-event eligibility checks and fork/default-branch guards.
2. Extend pull request metadata with merge state, merge SHA, repository identity, and timestamps.
3. Add GitHub deployment, deployment-status, and commit-comparison clients.
4. Implement staging-first polling, readiness checks, commit probes, and exact-head preview fallback.
5. Record descendant deployments and additional commits without making unsupported causality claims.
6. Add post-run drift detection.
7. Generate the managed QA workflow with scoped permissions, lossless per-PR concurrency, a
   95-minute timeout covering the valid 60+20-minute controller budgets plus finalization, and `always()`
   teardown/upload steps.

The event filter and deployment client can be built in parallel, then integrated into the resolver.

### Phase 3: Signed runtime and trusted browser broker — Critical Priority

1. Build the separate QA image and lock Codex, Playwright, and Chromium versions.
2. Implement the controller/broker protocol using schema-validated messages over a local transport.
3. Implement the declarative login recipe inside each attempt context, without serializing
   deployment-controlled browser state; consume setup admissions before side effects and bound the
   full recipe below the MCP deadline.
4. Implement the staging-only support-session bootstrap: fetch a fresh URL per attempt with a
   logical bearer secret, validate the response and exact redirect origin, and reject previews,
   production, missing credentials, or target-origin drift before browser execution.
5. Implement exact-origin secret browser headers without suffix or redirect inheritance, and keep
   both their names and values out of model-visible and uploaded data.
6. Implement semantic Playwright tools, immutable plan-bound assertion semantics, and the pre-plan
   execution gate.
7. Enforce scenario, two-attempt operation minimums, viewport, time, download, and navigation
   limits in broker code.
8. Add fixed sensitive-state acknowledgements, sealed `qa_status`, and controller-derived attempt
   status.
9. Add the deny-by-default egress proxy, credential-scrubbed Chromium child environment, and
   container hardening.
10. Implement run-scoped tenant setup, prefixing, reset, and cleanup verification.

Authentication, browser tools, and container policy can be developed in parallel against the shared protocol. No credentials should be wired into release workflows until containment tests pass.

### Phase 4: Agent planning, adaptive public execution, and sealed private execution — High Priority

1. Add the Juror QA prompt and explicit harness instructions.
2. Build the bounded impact-analysis context from pull request metadata and diff content.
3. Require and validate `QaPlan`, including exact checkpoint kind and locator/URL matcher, before
   enabling browser tools.
4. Execute scenarios within a single GPT-5.6 Luna medium-reasoning session.
5. Implement scenario checkpoints, sanitized observations, sealed sensitive-state acknowledgements,
   and the private broker ledger.
6. Implement one reset-and-adapt retry per failed unauthenticated scenario and a mandatory,
   outcome-independent second attempt for every authenticated or supplied-state scenario.
7. Add deterministic controller-side classification for passed, flaky, advisory, product, blocked, and infrastructure outcomes.

Prompt evaluation and classification fixtures can proceed in parallel once the broker protocol is stable.

### Phase 5: Evidence and GitHub reporting — High Priority

1. Capture per-attempt video only for runs without authentication or supplied browser state.
2. Capture traces and screenshots on unauthenticated failures, plus sanitized console messages and
   failed-request metadata for all attempts.
3. Implement the controller-owned artifact allowlist, configured exact-value redaction, post-render
   secret-canary scans over exact destination bytes, checksum-verified payload
   staging from the strict report ledger, and 14-day retention.
4. Render the job summary and update the QA sticky PR comment.
5. Upload an immutable evidence payload, then the finalized versioned JSON result and summary as a
   separate immutable artifact through `actions/upload-artifact`.
6. Expose action outputs, including the artifact URL and semantic outcome.
7. Ensure teardown and evidence preservation run on failure and best-effort on cancellation.

Artifact capture and report rendering are parallelizable; final publication depends on both.

### Phase 6: Distribution and initialization — High Priority

1. Add `qa/action.yml` and its documented inputs/outputs.
2. Add the public multi-architecture GHCR release workflow.
3. Generate and attest an SBOM and build provenance.
4. Verify the image digest and attestation before any credential handoff.
5. Add the released digest to Juror's versioned manifest.
6. Teach `juror init --qa` to generate the workflow with a full action SHA; the action then resolves,
   verifies, and executes the matching image by immutable digest.
7. Document repository secrets, target setup, commit probes, dedicated tenant requirements, the
   staging-only support-session/origin restrictions, and common failure modes.

### Phase 7: Hardening and controlled rollout — Medium Priority

1. Run the QA workflow in report-only mode against seeded demo applications and Juror-owned fixtures.
2. Exercise intentionally broken UI changes and compare planned coverage with expected user journeys.
3. Tune false-positive classification without relaxing the two-attempt product-issue rule.
4. Audit artifacts and logs with planted secret canaries.
5. Validate cleanup after success, failure, timeout, and cancellation.
6. Enable job-failing behavior for a small set of opt-in repositories.
7. Publish operational guidance and collect outcome, cost, runtime, flake, and blocked-run metrics.

## Test plan

### Unit tests

- Accept only merged, same-repository PRs targeting the default branch.
- Skip unmerged and fork PRs before secret or image access.
- Derive exact or conservative base candidates from bounded commit topology without using rendered
  diff equality as a trust proof.
- Require a two-parent merge's second parent to equal the captured PR head and a one-parent merge's
  captured-head comparison to be `diverged`; reject indirect or unknown merge topology.
- Abort GitHub retries, trusted policy hydration, instruction loading, checkout/diff processes, and
  browser work on `SIGINT` or `SIGTERM`, then reap the exact controller-owned checkout.
- Load every candidate QA policy and reject unavailable, malformed, unsafe, or conflicting policy.
- Omit repository `AGENTS.md` instructions when more than one pre-merge base remains plausible.
- Generate the textual patch and independent complete path manifest through isolated local Git;
  reject patches above 10,000,000 bytes and manifests above 200,000 bytes.
- Strictly parse every QA config field and apply hard caps.
- Resolve successful deployments and their latest statuses.
- Prove equal and descendant SHAs and report additional commits.
- Validate static commit probes and exact-head preview deployments.
- Reject target origins outside the configured allowlist.
- Reject support-session and secret-browser-header configuration outside staging; reject preview
  deployment resolution, an origin other than `session_bootstrap.target_origin`, missing logical
  secrets, short session bearer values, malformed bootstrap responses, and redirect-origin drift.
- Fetch one fresh support session for each attempt, never reuse its one-time redirect URL, and send
  each secret browser header only to its explicitly listed exact origins.
- Detect target drift after execution.
- Gate browser operations on a valid plan and require every runtime assertion to match the accepted
  checkpoint kind, expectation, canonical locator, and URL matcher exactly.
- Reject plans whose operation budget cannot cover two navigations plus two executions of every
  planned checkpoint.
- Enforce scenario, operation, viewport, authentication-setup, and run time limits; consume each
  setup admission before reset, browser launch, or login.
- Map retry observations to the correct semantic outcome and exit code.
- Keep QA and code-review sticky comments independent.
- Exact-redact configured secret values and credential-shaped fields in the final report and summary,
  then scan the completed semantic files and payload.
- Generate a 95-minute managed workflow for the valid 60-minute deployment plus 20-minute run
  maxima and the final reset, target recheck, evidence, and publication phases.

### Runtime and containment tests

- The model process cannot read the GitHub token or application secret bundle.
- The model cannot access cookies, storage state, broker-owned evidence, or private homes.
- Direct Chromium launch, arbitrary JavaScript, shell, general filesystem, and raw network tools are
  unavailable; source inspection is read-only, bounded, and confined to regular text files in the
  sealed checkout.
- Chromium inherits no GitHub, provider, application, or QA secret environment variables.
- Requests to an origin not on the proxy allowlist fail, including redirects, WebSockets, and worker requests.
- A browser secret header is absent from same-suffix, redirect, preview, and all other unlisted
  origins; the session bearer is used only for the trusted bootstrap POST.
- Container execution is non-root, capability-restricted, resource-limited, and has no Docker socket.
- Authenticated runs emit no video, trace, or screenshot evidence. Every page-dependent call returns
  an identical sealed acknowledgement, `qa_status` hides completed outcomes, and page-controlled
  strings, authentication actions, and secret values do not appear in model-visible output or artifacts.
- Authenticated and supplied-state scenarios require two attempts; only the controller derives
  status and mismatch-versus-tool-error classification from its private ledger.
- Controller termination still triggers best-effort cleanup and evidence finalization.

### End-to-end fixtures

1. An unauthenticated seeded regression is detected twice, produces `product_issue`, fails the job,
   and uploads both videos plus failure diagnostics.
2. A clean unauthenticated affected flow passes and produces one video per scenario.
3. A docs-only change produces `no_testable_surface` without opening a browser.
4. A transient locator or timing problem passes on the adaptive retry and produces `flaky`.
5. An unverified static staging target produces only `advisory`, even when behavior looks broken.
6. A verified staging target that changes during execution produces `blocked` rather than a product issue.
7. Missing authentication, unhealthy deployment, browser crash, and artifact failure are distinguished from product issues.
8. Staging unavailability falls back to a healthy exact-head preview deployment when configured.
9. All run-prefixed resources are removed after pass, failure, timeout, and cancellation paths.
10. A sensitive-state fixture receives byte-identical acknowledgements for passing, mismatching,
    and browser-error checkpoints; its second attempt is mandatory and its final status is
    controller-derived.
11. A planted secret in plan/report prose is exact-redacted, a canary spanning a destination's trailing
    newline is detected, and a surviving semantic-file or hash-verified payload canary fails closed
    before upload.
12. A canonical staging fixture mints two different one-time support-session URLs for the two sealed
    attempts, injects its Cloudflare header only on the configured web origin, and passes without a
    sign-in or sign-up UI.
13. The same support-session policy is blocked for a preview URL, production environment, redirect
    to another origin, missing/stale identity configuration, and an unrecognized Cloudflare header.

### Release checks

- Every third-party GitHub Action is pinned to a full commit SHA with a readable version comment.
- The QA image is resolved, verified, and executed by digest rather than executed by tag.
- The public image is pullable on GitHub-hosted Ubuntu runners.
- SBOM, provenance, and attestation identities match the release source.
- Playwright and Chromium versions are compatible.
- Artifact retention is exactly 14 days in the generated workflow.
- The generated job timeout is 95 minutes, exceeding the maximum 60-minute target wait plus
  20-minute browser execution budget with 15 minutes reserved for finalization.
- Secret canaries are absent from logs and uploaded artifact contents.

## Acceptance criteria

The feature is ready for opt-in release when:

- `juror init --qa` produces a valid, idempotent managed workflow and safely disabled
  configuration; supplying a target URL or allowed origin produces an enabled policy.
- A merged same-repository PR automatically starts one QA run; bursts of merges do not replace an older pending PR run.
- Exact and conservative topology ranges are recorded; ambiguous candidates must reach fail-closed
  QA-policy consensus before credentials are handed off.
- The planner receives no repository `AGENTS.md` instructions for a conservative range and never
  receives a partial patch caused by the 10 MB safety limit.
- Juror can prove and record the deployed revision or explicitly downgrade the run to advisory.
- Codex produces a valid affected-only plan with immutable executable assertion semantics before
  any browser interaction.
- The broker enforces all limits even when prompted to exceed them.
- The accepted plan fits the two-attempt minimum operation budget; sensitive-state scenarios always
  complete both attempts without intermediate outcome feedback.
- Canonical staging can authenticate through one fresh, fixed-identity support-session URL per
  attempt without exercising sign-in/sign-up UI; configuration and runtime checks reject that mode
  for preview and production targets and bind browser headers to exact origins.
- A known user-visible regression is reproduced twice and reported with useful structured evidence
  plus video when the run is unauthenticated.
- A flaky attempt does not fail the product verdict.
- Secrets and authentication state are absent from all model-visible data and uploaded evidence;
  the finalized report, summary, and payload pass exact-value scanning.
- Synthetic state is cleaned after every terminal path.
- Product issues, blocked runs, and infrastructure failures fail the GitHub job with distinct explanations.
- Existing `juror review`, `juror benchmark`, and default `juror init` behavior remain backward compatible.

## Operational metrics

The JSON result should make the following measurable without a hosted service:

- Eligible, skipped, passed, no-surface, flaky, advisory, product-issue, blocked, and infrastructure run counts.
- Deployment resolution time and target type.
- Plan size, scenarios attempted, and browser operation count.
- Initial failure and retry recovery rates.
- Median and percentile runtime.
- Model token usage and estimated cost.
- Cleanup failures.
- Evidence upload size.

Repositories can aggregate these results from GitHub Actions later. A hosted analytics plane is not required for v1.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| The model mistakes a testing problem for a regression | Require a stable verified target, trusted setup, and two equivalent failed attempts; classify mechanically |
| The merged PR changes its own QA policy | Enumerate every topology-plausible base; require fail-closed parsed QA-policy consensus; omit `AGENTS.md` when the base is ambiguous |
| Squash/rebase topology cannot identify one exact source range | Diff from the oldest plausible base, label the range conservative, and keep all findings advisory because it can contain earlier changes |
| An oversized or repository-shaped patch hides affected files | Generate the textual patch plus an independent name/status manifest through isolated local Git with external drivers disabled; block above 10,000,000 patch bytes or 200,000 manifest bytes |
| PR metadata or a filename tries to redirect the planner | Label all metadata and paths untrusted, JSON-escape markup/newlines, and place them in explicit data boundaries |
| Secrets leak through browser evidence | Use identical sealed acknowledgements and hidden `qa_status` outcomes for authenticated runs, suppress their visual/trace evidence, keep auth in the per-attempt broker context, scrub the Chromium child environment, exact-redact final semantic files, allowlist artifacts, and scan after report/summary creation |
| A staging auth credential reaches production or a branch host | Require the `environment: staging` security tier, require any separate `deployment_environment` selector to match the resolved record exactly, bind the bootstrap redirect to one exact canonical target origin, reject preview deployments, require `preview_fallback: false`, and inject each browser header only on its reviewed exact origins |
| A one-time support session is replayed | Fetch after attempt admission, consume it only in that attempt's fresh context, never serialize or reuse the URL, and mint a distinct session for attempt 2 |
| Concurrent jobs invalidate one fixed user's unconsumed session | Give the staging synthetic identity a single-capacity runner or durable queue until the product supplies an identity pool; keep lossless per-PR workflow groups and mint immediately before redemption |
| The readiness probe cannot cross the staging Cloudflare gate | Keep target resolution pre-secret; allow a reviewed expected `403` only as endpoint-presence readiness, then make sealed browser bootstrap the authoritative auth check |
| A malicious page uses checkpoint results as an oracle over private data | Seal all intermediate outcomes, predeclare the exact checkpoint predicate before browser access, require an outcome-independent second attempt, and expose only the bounded final per-checkpoint Boolean; connect only a synthetic non-sensitive account/tenant and forbid private-data predicates |
| Browser navigation exfiltrates data | Container-level deny-by-default egress proxy plus browser origin checks |
| Staging contains later commits | Record ancestry and additional commits; avoid causal language |
| Staging changes while the test runs | Re-resolve deployment identity after execution and mark the run blocked on drift |
| Broad mutation damages shared data | Require a dedicated synthetic tenant, run prefixes, reset hooks, and verified cleanup |
| A read-only UI action is mislabeled but emits a write | Arm a controller-owned barrier before the first action, deny non-safe HTTP methods and outbound WebSocket messages, and block the attempt on any required denial |
| Agent loops or spends excessively | Hard limits of six scenarios, 40 operations, one setup admission per scenario/attempt, a fixed 10-second sensitive-setup window, and 20 minutes enforced outside the model; reject plans that cannot fund navigation, a snapshot, and every checkpoint in two attempts |
| Supply-chain substitution compromises secrets | Signed public image, immutable digest pin, SBOM/provenance, and pre-secret attestation verification |
| QA becomes noisy for non-UI changes | Affected-only planning and explicit `no_testable_surface` success |

## Assumptions

- v1 targets GitHub.com repositories running Docker-capable GitHub-hosted Ubuntu runners.
- The controller honors `GITHUB_API_URL` for API calls, but end-to-end GitHub Enterprise Server
  distribution and provenance verification are not qualified in v1.
- Consumers can provide either a GitHub staging deployment, a static staging URL, or an exact-head
  preview deployment. Origin-bound support-session authentication is the exception: v1 requires the
  canonical staging target and disables preview fallback.
- The application exposes a readiness endpoint and preferably a revision probe.
- Consumers provide a dedicated synthetic, non-sensitive account and tenant with a reset endpoint
  or deterministic cleanup behavior; it contains no production/customer data or secrets whose
  presence may be tested through a checkpoint.
- A consumer that enables support-session authentication provides a fixed-identity staging endpoint
  returning a short-lived single-use redirect on the canonical web origin. It does not enable the
  retired arbitrary-user testing-login endpoint on shared staging.
- Repository administrators protect the QA workflow and configuration paths through normal branch protection and review.
- Testing finds issues present in the deployed product; it does not assert sole causality when later commits are included.
- Fork testing, production testing, additional browser engines, scheduled full regression suites, and hosted orchestration are future extensions.

## References

- [GitHub Actions pull request event behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
- [GitHub Deployments REST API](https://docs.github.com/en/rest/deployments/deployments)
- [GitHub Actions artifacts](https://docs.github.com/en/actions/tutorials/store-and-share-data)
- [GitHub Actions concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
- [GitHub artifact attestations for containers](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)
- [Playwright configuration, video, and traces](https://playwright.dev/docs/test-use-options)
- [Playwright Docker guidance](https://playwright.dev/docs/docker)
- [Playwright authentication guidance](https://playwright.dev/docs/auth)
- [Playwright test agents](https://playwright.dev/docs/test-agents)
