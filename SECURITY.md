# Security policy

## Supported versions

Security fixes are released on the latest `1.x` version of Juror. Older releases and
unreleased forks are not supported. Because the GitHub Action executes the source at the
revision selected by each consumer, users should update their immutable pin after a security
release rather than follow a moving tag.

## Report a vulnerability privately

Do not open a public issue for a suspected vulnerability or include live credentials in a
report. Use GitHub's
[private vulnerability reporting form](https://github.com/Juror-AI/juror/security/advisories/new).
If the form is unavailable, contact a repository owner through GitHub without disclosing the
technical details publicly and ask for a private reporting channel.

Include the affected version or commit, impact, reproduction steps, and any suggested
mitigation. Use synthetic credentials and a private test repository whenever possible.

## Response expectations

- We aim to acknowledge a report within three business days.
- We aim to provide an initial severity assessment within seven business days.
- For an accepted report, we will share status at least every seven business days until a fix
  or documented mitigation is available.
- We will coordinate disclosure and credit with the reporter. Fix timing depends on severity
  and release risk; these targets are communication commitments, not a guaranteed resolution
  deadline.

## Scope

Reports are in scope when they affect Juror's CLI, GitHub Action, release artifacts, credential
isolation, sandbox boundaries, review publishing permissions, or supply chain. Vulnerabilities
in an upstream model provider or CLI should also be reported upstream; please report them here
when Juror's integration materially increases the impact.

Prompt injection that can only influence review prose is an expected residual risk. Injection
that exposes credentials, escapes a filesystem boundary, changes repository state, or obtains
additional GitHub permissions is in scope.

See the [threat model](docs/threat-model.md) for trust boundaries, controls, and residual risks.
