# Juror threat model

## Overview

Juror sends attacker-influenced repository content to third-party coding-agent harnesses and, in
post-merge QA mode, lets a supervised agent inspect a live deployment through a browser broker.
It then publishes the resulting review or QA outcome to GitHub. This document describes the
assets, trust boundaries, controls, and residual risks for the CLI and GitHub Actions. It
complements the implementation summary in the README and the private reporting process in
`SECURITY.md`.

## Security objectives

Juror is designed to:

- keep provider keys and the GitHub token out of untrusted repositories and model-controlled
  tools;
- prevent a pull request from changing the policy, model configuration, or executable Action
  revision used to review itself;
- give jurors read-only access to a sealed checkout and narrowly scoped scratch storage;
- publish only through a separate, post-model GitHub client; and
- make release inputs and artifacts traceable to one immutable commit.

Juror does not claim that model output is correct or free from prompt injection. Review text is
advisory and must not be treated as authorization to merge, deploy, or execute code.

## Assets and boundaries

| Boundary | Threat | Primary controls | Residual risk |
|---|---|---|---|
| Untrusted pull request text and repository files | Prompt injection, malicious hooks, oversized input, misleading policy | Review from a detached checkout; load review policy from the captured base; require post-merge QA-policy consensus across every topology-plausible base; do not use `pull_request_target`; treat PR metadata as untrusted | A model can still produce a wrong or attacker-influenced review |
| Ambiguous or indirect post-merge topology | A reachable indirect head or rebased PR commit is mistaken for trusted policy, or an incomplete patch hides an affected file | Require the captured PR head as a two-parent merge's second parent; require a one-parent result's captured-head comparison to be `diverged`; enumerate at most 100 one-parent base candidates; reject repository policy blobs above 262,144 bytes before reading or parsing; fail closed on unavailable, malformed, unsafe, or conflicting QA policy; omit `AGENTS.md` when several candidates remain; never follow a head-only instruction symlink; generate a local textual patch and independent path manifest with external diff execution disabled; reject oversized scope | A conservative squash range can include older base-branch changes, so its findings are always advisory |
| Authenticated browser state and private application data | A malicious deployment encodes a credential or private value into page output, timing, or pass/fail responses and induces the agent to probe it adaptively | Predeclare each checkpoint's exact assertion kind and locator/URL matcher before browser access; return identical sealed acknowledgements for page-dependent calls; hide completed outcomes in `qa_status`; require an outcome-independent second attempt; keep outcome ledgers controller-owned and omit raw page values; suppress sensitive-state pixels/traces; exact-redact and post-render scan public files | The final report exposes one bounded Boolean per predeclared checkpoint. This remains a channel, so authenticated QA may use only a synthetic account/tenant with no production/customer data, and checkpoint predicates must not test credentials or private values |
| Authenticated deployment selection | A deployment record from a preview, production, or unrelated shared environment receives staging browser credentials | Keep `environment: staging` as the trusted security tier; treat `deployment_environment` only as an exact GitHub deployment selector agreed by base-policy consensus; require the resolved record to match that selector; reject previews; independently bind the static URL, bootstrap redirect, browser headers, and resolved target to one exact canonical origin | A trusted maintainer can mislabel a GitHub environment, so the exact canonical origin remains the destination security boundary |
| Chromium child process | Controller or CI credentials leak through inherited environment variables | Rebuild a minimal browser environment containing only required path, temp/home, locale, display, certificate, sandbox, and Playwright variables; pass proxy policy through trusted launch options | A Chromium or Playwright vulnerability can still compromise data intentionally entered into that browser context |
| Provider keys | Exfiltration through tools, logs, child processes, or committed configuration | One provider credential per harness invocation; rebuilt child environments; secret redaction; `juror init` sends secrets to GitHub over stdin; untracked `.env` files stay outside reviewer roots | A compromised provider CLI can use its own credential while it is running; an aggregator key authorizes every selected model routed through that aggregator |
| GitHub token | Repository mutation or disclosure to a model | Never pass it to model subprocesses; publish only after jurors exit; request `contents: read` and `pull-requests: write`; fork reviews receive no secrets | The trusted publishing process can create or edit review comments by design |
| Model subprocesses | Shell execution, filesystem escape, persistence, cross-juror leakage | Private temporary homes, kernel filesystem restrictions for Codex, path confinement for the generic harness, separate scratch directories; QA exposes only bounded literal search and line reads of allowlisted source/documentation files in its sealed checkout, excluding sensitive filenames and known credential-shaped values and rejecting traversal, VCS metadata, and symbolic links | Sandboxing differs by harness and operating system; a harness vulnerability may weaken it, and a novel or deliberately obfuscated credential committed inside an otherwise inspectable source file may evade shape-based redaction |
| Harness packages and installer scripts | Compromised npm package, mutable installer response, postinstall code, or binary substitution | Exact package versions in Action inputs; credential-stripped installation environment; isolated runner; immutable Action revision; cache keys include harness specs | The Grok installer script is fetched from the vendor at runtime and is not content-addressed; disable xAI or preinstall an audited binary when this is unacceptable |
| Action dependencies | A moving tag or compromised upstream Action changes trusted code | Every external `uses:` reference is a full commit SHA with a readable version comment; CI rejects mutable references; Dependabot proposes reviewed pin updates | A pinned upstream commit can itself contain a vulnerability |
| Release pipeline | Tag/package mismatch, rebuilt bytes, stolen long-lived npm token | Exact tag/version/commit checks; clean tagged checkout; OIDC trusted publishing; npm provenance; GitHub build and SBOM attestations; checksummed release assets | Attestations establish origin and integrity, not that the code is safe |

## Execution flow

1. GitHub checks out the consumer repository with full history. The Juror Action itself is
   selected by an immutable commit, independently of the pull request branch.
2. Review mode loads repository policy and execution configuration from the captured base
   revision. Post-merge QA derives exact or conservative base candidates from immutable commit
   topology and accepts repository QA policy only when every plausible candidate reaches the
   fail-closed consensus required for that run.
3. Post-merge QA generates its affected-source patch and independent path manifest with isolated
   local Git after materializing the oldest candidate and merge trees. It does not use rendered
   PR-diff equality as identity proof, omits repository `AGENTS.md` instructions for an ambiguous
   range, and stops before model execution when the textual patch exceeds 10,000,000 bytes or the
   path manifest exceeds 200,000 bytes. Binary hashes and paths remain without binary payloads;
   PR metadata and paths are escaped inside explicitly untrusted prompt data blocks.
4. Post-merge QA accepts a browser plan only after every checkpoint fixes its expectation,
   assertion kind, and canonical locator or URL matcher. The operation budget reserves two
   executions of every checkpoint before Playwright is enabled.
5. For authenticated or supplied-state scenarios, each page-dependent browser call returns the
   same acknowledgement, `qa_status` hides completed outcomes, and the controller requires two
   attempts and derives status from its private ledger. Setup admission is consumed before reset,
   browser launch, or login, and the complete login recipe has a controller deadline.
6. Each selected review harness receives a sealed checkout, a private runtime directory, and only
   its own provider credential. Harnesses do not receive the GitHub token.
7. Model subprocesses exit before Juror's GitHub client receives the token and publishes an
   exact-redacted, post-render-scanned result.
8. Release publication checks that the release tag, `package.json` version, checked-out commit,
   and event commit agree. The workflow builds once, publishes that tarball, and attaches its
   checksum, source archive, SBOM, and attestations.

## External executables

Juror orchestrates Claude Code, Codex, CodeWhale for DeepSeek, opencode, Grok Build, and Kimi Code. These programs are
outside Juror's trust boundary: they parse untrusted model and repository data and may make
network requests. The hosted Action installs exact npm package versions, but npm installation
still trusts the registry, the package publisher, and any lifecycle behavior allowed by that
package. Installs run on disposable hosted runners with Juror and GitHub credentials removed.

Grok Build currently uses the vendor's HTTPS installer script because no content-addressed
artifact is exposed by the integration. Piping a network response to a shell trusts the vendor,
TLS path, and current response. Security-sensitive operators should omit the xAI key/model or
use a controlled runner with a preinstalled, audited CLI. Installer failure degrades that juror
explicitly; it must never be represented as model agreement.

The `starter` preset uses one OpenRouter key for two isolated `generic-openai` runs. That key is
used only as an HTTP authorization header inside Juror; it is never inserted into the prompt,
tool messages, report, or scratch files. Each model still receives a separate scratch directory
and the same path-confined read/write tools. This removes extra CLI installers but adds
OpenRouter as a routing, billing, and data-processing trust boundary. Use direct first-party
presets when provider selection, retention terms, or independent credentials matter more than
one-secret onboarding.

## GitHub workflow trust

Consumers should generate their workflow with `juror init`. It resolves a release tag to a full
commit and writes the readable release beside the pin. A managed-content hash allows Juror to
update only untouched generated workflows. Dependabot understands same-line version comments
and can propose updates without changing the pin to a mutable tag.

The workflow deliberately uses `pull_request`, skips forks, and grants only `contents: read` and
`pull-requests: write`. Do not change it to `pull_request_target` or execute pull-request code in
a job that holds provider credentials.

The separate post-merge QA workflow reacts only to closed, merged, same-repository pull requests.
Its policy-only container resolves the topology candidate set and reaches QA-policy consensus
before browser or provider credentials are handed to the runtime. An exact range has one candidate.
A conservative range uses the oldest candidate for source coverage, records all candidate SHAs,
keeps every finding advisory because the range can include earlier changes, and never promotes a
nearer candidate's `AGENTS.md` into trusted instructions.

The generated QA job has a 95-minute timeout. Trusted configuration permits at most 60 minutes for
deployment resolution and 20 minutes for browser execution; the remaining 15 minutes covers
checkout, runtime startup, the final reset and target recheck, evidence finalization, and
publication. Per-attempt setup
admissions and the per-admission authentication deadline independently bound reset/login retries inside
that job.

## Authenticated QA disclosure boundary

Sealed browser feedback prevents the model from using intermediate page state as an adaptive
oracle. Browser calls do not report pass, mismatch, tool error, page text, page URL, or completed
attempt status; the mandatory second attempt is independent of the first outcome. The controller
retains those distinctions only in memory long enough to classify the final run. Sensitive-state
reports use zero-duration attempts with empty operation, observation, and artifact lists; no raw
per-attempt ledger, timing, or conditional console/network/policy-event presence is uploaded.

This control deliberately leaves one small channel: after the agent session, the report tells the
operator whether each exact checkpoint predicate passed. Because predicates are accepted before
the browser opens and cannot be changed at runtime, the channel is bounded and non-adaptive. It is
not safe for a personal account, production tenant, customer corpus, mailbox, billing profile, or
any other context where even a Boolean about a private value is sensitive. Operators must provision
a resettable synthetic account and tenant containing only non-sensitive fixtures.

## Validation and reporting

CI runs the full test suite, a provider-key shape scan, and `npm run check:secure-refs`. QA
containment tests verify exact plan/runtime assertion binding, identical sealed acknowledgements,
hidden `qa_status` outcomes, mandatory sensitive-state retries, the credential-scrubbed Chromium
environment, and configured-secret scans after the final report and summary exist. Release artifacts
are rebuilt in an empty staging directory from strict report-ledger entries; an empty ledger produces
only a static controller-owned upload sentinel. Each ledger file must match its reported SHA-256 and
pass an exact-byte secret scan. Semantic scans cover the actual
destination bytes, including any emitted trailing newline, and the secret bundle is forwarded by
name only to the trusted finalizer and publisher containers that need it. Release artifacts can be checked
with the commands in [the release guide](releasing.md). Report boundary escapes,
credential exposure, or release-integrity failures through the private process in
[`SECURITY.md`](../SECURITY.md).
