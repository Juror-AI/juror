# Juror threat model

## Overview

Juror sends attacker-influenced repository content to third-party coding-agent harnesses and
then publishes the resulting review to GitHub. This document describes the assets, trust
boundaries, controls, and residual risks for the CLI and GitHub Action. It complements the
implementation summary in the README and the private reporting process in `SECURITY.md`.

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
| Untrusted pull request text and repository files | Prompt injection, malicious hooks, oversized input, misleading policy | Review from a detached checkout; load policy and execution config from the base revision; do not use `pull_request_target`; treat PR metadata as untrusted | A model can still produce a wrong or attacker-influenced review |
| Provider keys | Exfiltration through tools, logs, child processes, or committed configuration | One provider credential per harness; rebuilt child environments; secret redaction; `juror init` sends secrets to GitHub over stdin; untracked `.env` files stay outside reviewer roots | A compromised provider CLI can use its own credential while it is running |
| GitHub token | Repository mutation or disclosure to a model | Never pass it to model subprocesses; publish only after jurors exit; request `contents: read` and `pull-requests: write`; fork reviews receive no secrets | The trusted publishing process can create or edit review comments by design |
| Model subprocesses | Shell execution, filesystem escape, persistence, cross-juror leakage | Private temporary homes, read-only/search-only tools where supported, kernel filesystem restrictions for Codex, path confinement for the generic harness, separate scratch directories | Sandboxing differs by harness and operating system; a harness vulnerability may weaken it |
| Harness packages and installer scripts | Compromised npm package, mutable installer response, postinstall code, or binary substitution | Exact package versions in Action inputs; credential-stripped installation environment; isolated runner; immutable Action revision; cache keys include harness specs | The Grok installer script is fetched from the vendor at runtime and is not content-addressed; disable xAI or preinstall an audited binary when this is unacceptable |
| Action dependencies | A moving tag or compromised upstream Action changes trusted code | Every external `uses:` reference is a full commit SHA with a readable version comment; CI rejects mutable references; Dependabot proposes reviewed pin updates | A pinned upstream commit can itself contain a vulnerability |
| Release pipeline | Tag/package mismatch, rebuilt bytes, stolen long-lived npm token | Exact tag/version/commit checks; clean tagged checkout; OIDC trusted publishing; npm provenance; GitHub build and SBOM attestations; checksummed release assets | Attestations establish origin and integrity, not that the code is safe |

## Execution flow

1. GitHub checks out the consumer repository with full history. The Juror Action itself is
   selected by an immutable commit, independently of the pull request branch.
2. Juror loads repository policy and execution configuration from the trusted base revision.
   Pull-request changes to those files apply only after they merge.
3. Each selected harness receives a sealed checkout, a private runtime directory, and only its
   own provider credential. Harnesses do not receive the GitHub token.
4. Model subprocesses exit before Juror's GitHub client receives the token and publishes a
   redacted result.
5. Release publication checks that the release tag, `package.json` version, checked-out commit,
   and event commit agree. The workflow builds once, publishes that tarball, and attaches its
   checksum, source archive, SBOM, and attestations.

## External executables

Juror orchestrates Claude Code, Codex, opencode, Grok Build, and Kimi Code. These programs are
outside Juror's trust boundary: they parse untrusted model and repository data and may make
network requests. The hosted Action installs exact npm package versions, but npm installation
still trusts the registry, the package publisher, and any lifecycle behavior allowed by that
package. Installs run on disposable hosted runners with Juror and GitHub credentials removed.

Grok Build currently uses the vendor's HTTPS installer script because no content-addressed
artifact is exposed by the integration. Piping a network response to a shell trusts the vendor,
TLS path, and current response. Security-sensitive operators should omit the xAI key/model or
use a controlled runner with a preinstalled, audited CLI. Installer failure degrades that juror
explicitly; it must never be represented as model agreement.

## GitHub workflow trust

Consumers should generate their workflow with `juror init`. It resolves a release tag to a full
commit and writes the readable release beside the pin. A managed-content hash allows Juror to
update only untouched generated workflows. Dependabot understands same-line version comments
and can propose updates without changing the pin to a mutable tag.

The workflow deliberately uses `pull_request`, skips forks, and grants only `contents: read` and
`pull-requests: write`. Do not change it to `pull_request_target` or execute pull-request code in
a job that holds provider credentials.

## Validation and reporting

CI runs the full test suite, a provider-key shape scan, and `npm run check:secure-refs`. Release
artifacts can be checked with the commands in [the release guide](releasing.md). Report boundary
escapes, credential exposure, or release-integrity failures through the private process in
[`SECURITY.md`](../SECURITY.md).
