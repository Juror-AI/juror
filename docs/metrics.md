# Privacy-preserving product metrics

Status: measurement contract; Juror does not emit product telemetry today.

This document defines the evidence required to make activation and growth decisions without
turning Juror into a repository-observation service. Any future collector must implement this
contract, its user controls, and its deletion path together. Until then, use the manual
lighthouse workflow below.

## Non-negotiable boundaries

- Product telemetry is **off by default** and requires an explicit opt-in per repository.
- Do not send source code, diffs, prompts, finding text, file paths, symbols, repository names,
  owner names, remote URLs, credentials, GitHub tokens, pull-request numbers, commit SHAs, or
  free-form text.
- Review payloads sent to model providers are not product telemetry and remain governed by
  the selected provider. Juror must not copy those payloads into an analytics system.
- Collect counts, coarse buckets, and explicit human outcome labels. Do not infer that a
  finding was correct merely because nearby code changed.
- Report opt-in metrics as an observed lower bound, with cohort size and coverage. Never
  present them as measurements of all Juror users.
- Do not use cookies, device fingerprints, IP addresses, or repository metadata to recover a
  disabled or missing identifier.

## Metric definitions

All weekly metrics use ISO weeks in UTC. A **model family** is the vendor/model family Juror
already uses for consensus accounting; retries and aliases of the same family count once.
An **anonymous installation** is one repository's random telemetry token. The token is never
derived from a repository name, URL, GitHub id, commit, provider key, or machine identifier.

| Metric | Definition |
|---|---|
| **North star: weekly active repositories with a multi-model success** | Count distinct anonymous installations that complete at least one successful review with reports from at least two model families during the week. Call this `WAR-2+`. |
| Time to first success | For installations that reach `WAR-2+`, elapsed time from an explicitly recorded setup start to their first qualifying review. Report median and p90 by bucket; also report installations that have not succeeded so the metric is not survivor-only. |
| Setup completion | Percentage of opted-in setup starts that install or validate a runnable configuration within seven days. Readiness is reported separately as zero, one, or at least two authenticated model families. |
| Successful review rate | Successful review attempts divided by all review attempts. A success finishes orchestration and produces the requested terminal/JSON/GitHub output with at least one parseable juror report. Also report the stricter multi-model success rate (`>=2` completed families). Cancelled, timed-out, skipped, and zero-report attempts remain in the denominator. |
| Four-week repository retention | Of anonymous installations with a `WAR-2+` event in cohort week 0, the percentage with another `WAR-2+` event in week 4. Report the cohort count beside the percentage. |
| Acted-on findings | Count and percentage of human-reviewed findings with an explicit action of `fixed`, `mitigated`, `test_added`, `documented`, or `risk_accepted`. A later code change alone is not evidence of action. |
| Dismissed findings | Count and percentage of human-reviewed findings explicitly labeled `not_a_defect` or `duplicate`. Unreviewed, expired, hidden, or merely unresolved findings are not dismissed. |
| Duplicate rate | Explicitly labeled duplicate findings divided by all human-reviewed findings. Juror's automatic clustering is operational behavior, not ground-truth duplicate attribution. Benchmark duplicate rate remains defined by the adjudicated corpus. |
| Cost per review | Known reported/estimated cost divided by completed reviews, marked as a lower bound when any review has unknown or partial cost. Also publish the known-cost-only average and reported, estimated, partial, and unknown coverage; unknown cost is never zero. |
| Cost per confirmed defect | Known cost of the reviewed cohort divided by findings explicitly confirmed as real defects by a human, marked as a lower bound when cost coverage is incomplete. Publish the confirmed count and cost-coverage percentage. Do not substitute findings posted, acted on, or automatically verified for confirmed defects. |

### Human outcome vocabulary

Outcome recording is an explicit adjudication step, not an automated classifier:

- `confirmed`: a human inspected the claim and agrees the defect exists. It can then have an
  action such as `fixed`, `mitigated`, `test_added`, `documented`, `risk_accepted`, or
  `no_action`.
- `not_a_defect`: a human inspected and rejected the claim.
- `duplicate`: a human mapped the claim to another finding about the same defect.
- `unreviewed`: no human decision; excluded from acted-on, dismissed, and confirmed-rate
  denominators but reported as coverage.

A merged pull request, changed line, resolved thread, reaction, absent follow-up, or model
agreement must not silently change one of these labels. An integration may offer those as
review cues, but a human must confirm the outcome.

## Proposed aggregate event schema

This is the maximum allowed product schema, not a currently implemented API. Fields marked
“bucket” use the fixed values below; additions require a privacy review and documentation
change before deployment.

Common fields:

| Field | Values and purpose |
|---|---|
| `schema_version` | Integer schema version. |
| `event` | `setup_started`, `setup_completed`, `review_completed`, or `outcomes_recorded`. |
| `period_start` | UTC calendar day, not an exact timestamp. |
| `anonymous_installation_id` | Locally generated 128-bit random value used only for weekly active and retention counts. |
| `juror_version` | Released Juror version; prerelease/build metadata is dropped. |
| `runtime` | `local`, `github_action`, or `self_hosted_action`. |
| `source_channel` | Closed attribution value defined below; never a URL or free-form referrer. |

Event fields:

| Event | Allowed fields |
|---|---|
| `setup_started` | No additional fields. This event can only occur after consent, so the setup funnel excludes pre-consent starts. |
| `setup_completed` | `preset`, `ready_family_bucket` (`0`, `1`, `2+`), `completed` (boolean). Do not send provider or model names. |
| `review_completed` | `success` (boolean), `completed_family_bucket` (`0`, `1`, `2+`), `duration_bucket`, `cost_usd_cents` (nearest cent, capped at 10,000, or `null`), `cost_status` (`reported`, `estimated`, `partial`, `unknown`), `finding_count_bucket`, and `first_success_elapsed_bucket` only on the first `WAR-2+` event. |
| `outcomes_recorded` | Aggregate counts only: `reviewed`, `confirmed`, `acted_on`, `not_a_defect`, and `duplicate`, each capped at `50+`. Never send a finding id, title, path, severity, comment id, or outcome note. |

Buckets are deliberately coarse:

- duration: `<=60s`, `61-180s`, `181-600s`, `>600s`
- time to first success: `<=10m`, `11-60m`, `1-24h`, `1-7d`, `>7d`
- finding count: `0`, `1`, `2-5`, `6-10`, `11-50`, `50+`

`anonymous_installation_id` must be generated with a cryptographically secure random source
and stored outside the repository checkout. GitHub Actions would use a dedicated repository
secret created only during telemetry opt-in; local installations would use a user-owned state
file with restrictive permissions. Copying a token to another repository corrupts repository
counts, so status tooling must detect and explain the scope.

### Source attribution

The operator chooses one value during opt-in. Juror does not inspect browser referrers, GitHub
metadata, or URLs to infer it:

- `documentation`
- `github_marketplace`
- `public_pr_comment`
- `research_post`
- `launch_hacker_news`
- `launch_product_hunt`
- `launch_reddit`
- `launch_other`
- `direct_or_unknown`

Attribution is first-touch for the anonymous installation. Reports must group small launch
cohorts into `launch_other`; do not publish a source slice with fewer than ten installations.

## Retention, access, and deletion contract

- Raw opt-in events are retained for **45 days**, long enough to compute week-4 retention,
  then deleted automatically.
- Weekly aggregates may be retained for **13 months** only after removing installation
  tokens. Aggregates must suppress cells with fewer than ten installations.
- The application must not persist request IPs or user-agent strings. Infrastructure access
  logs must exclude request bodies and query strings and expire within seven days.
- Access to raw events is limited to named maintainers responsible for product measurement;
  exports and ad-hoc copies inherit the same 45-day deletion deadline.
- Deletion by anonymous installation token removes its raw events and server-side token state.
  Already de-identified weekly aggregates cannot identify or reconstruct that installation.

No collector may ship until these controls exist in the same release:

```text
juror telemetry status              # show off/on, source, token location, endpoint, and retention
juror telemetry enable --source …   # explain the exact payload, then require confirmation
juror telemetry disable             # stop all future events without a network call
juror telemetry delete              # request raw-event deletion, then remove the local token
juror telemetry preview             # print the next payload without sending it
```

For automation, `JUROR_TELEMETRY=off` must always win and be the default. Enabling telemetry
must not be bundled with provider-secret setup, accepting terms, installing a workflow, or any
other required action. Failed analytics requests must never fail or delay a review.

## No-telemetry lighthouse measurement

Lighthouse repositories can measure the same funnel without sending Juror telemetry:

1. Copy [`lighthouse-metrics-template.csv`](lighthouse-metrics-template.csv) into a private
   research workspace, not the repository under review.
2. Give each repository a random local alias. Keep any alias-to-repository mapping with the
   participating team; Juror maintainers do not need it.
3. Record setup and review counts weekly from receipts/workflow history. Record finding
   outcomes only after a participating human labels them with the vocabulary above. Record
   `first_success_elapsed_minutes` once, on the first qualifying review; leave it blank until
   success rather than entering zero.
4. Share weekly aggregate rows. Remove timestamps, notes, URLs, pull-request numbers, finding
   text, and repository names before sharing.
5. Publish cohort size, missing-cost coverage, outcome-adjudication coverage, and the fact that
   the sample is a recruited lighthouse cohort.

This path is the reference measurement method even if opt-in telemetry is later built. It can
audit the event implementation and includes privacy-sensitive repositories that never enable
telemetry.

## Baseline before targets

As of 2026-08-11, Juror has no product telemetry and no completed four-week lighthouse cohort.
Every metric in this document is therefore **not measured**, not zero. The one-PR review
benchmark measures defect-detection quality; it is not an activation or retention baseline.

| Baseline register (2026-08-11) | Value |
|---|---|
| `WAR-2+` | Not measured — no collector or manual activity cohort |
| Time to first success and setup completion | Not measured — no setup cohort |
| Successful review rate | Not measured — no attempt census |
| Four-week repository retention | Not measured — no completed week-0/week-4 cohort |
| Acted-on, dismissed, confirmed, and duplicate findings | Not measured — no human outcome log |
| Cost per review and per confirmed defect | Not measured — no representative review cohort with cost coverage |

Do not set 30- or 90-day growth targets until a baseline report:

1. freezes this schema and the reporting period;
2. observes at least four consecutive activity weeks plus the week-4 return window;
3. reports `WAR-2+`, funnel/rate denominators, cohort sizes, telemetry/manual coverage, cost
   coverage, and human-outcome coverage;
4. separates opt-in telemetry from recruited lighthouse data; and
5. is reviewed for both statistical usefulness and privacy compliance.

Targets must name that baseline period and use the same definitions. A schema change starts a
new series or publishes an explicit backfill; it must not silently rewrite historical results.
