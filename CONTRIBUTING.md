# Contributing to Juror

Juror accepts model, harness/provider, benchmark, documentation, and core-pipeline
contributions. Because a review runs attacker-controlled repository text beside paid provider
credentials, compatibility is not enough: every integration must preserve the security and
cost-accounting contract.

## Choose a contribution path

- [Add a model or preset](docs/contributing/model-presets.md) when an existing harness can
  already authenticate and run the model.
- [Add a harness or provider](docs/contributing/harness-providers.md) when a new CLI/API,
  credential shape, parser, or tool boundary is required.
- [Add an adjudicated benchmark case](docs/contributing/benchmark-cases.md) to improve the
  evidence base without changing runtime code.

The generated [compatibility matrix](docs/compatibility.md) shows what the tested built-in
configuration actually exposes. The issue templates request the evidence maintainers need
before implementation; the pull-request template carries that evidence through review.

## Local workflow

Use Node 20 or newer and work from a branch based on `main`:

```bash
npm ci --no-audit --no-fund
npm run typecheck
npm run build
npm run check:compatibility
npm test
npm run check:secure-refs
```

After changing a built-in model, preset, harness registration, or pricing row, regenerate the
matrix and commit it:

```bash
npm run docs:compatibility
```

Use synthetic credentials and checked-in, redacted fixtures. Never paste live provider output
without removing prompts, source text, repository identifiers, session identifiers, and keys.

## Invariants every runtime contribution preserves

1. Execution config and repository instructions come from the trusted base revision, not the
   pull request under review.
2. A model invocation receives exactly one provider credential and never receives
   `GITHUB_TOKEN`, other provider keys, or the caller's ambient environment.
3. The reviewed checkout is sealed and read-only. Startup config, homes, caches, sessions,
   skills, hooks, MCP servers, and scratch directories are private per invocation.
4. Model-controlled tools cannot write the repository or use shell, network, browser, MCP, or
   subagents unless a narrower, reviewed design proves why one is required.
5. Output and usage are untrusted input: parse defensively, bound diagnostics, redact secrets,
   and clean adapter-owned state on success, failure, timeout, and spawn error.
6. Cost is labeled `reported`, `estimated`, partial/lower-bound, or `unknown`. Missing usage is
   never zero; cached tokens, cache writes, per-request tiers, and provider side-calls are
   accounted for according to measured behavior.
7. Missing credentials, unavailable models, malformed output, and timeouts degrade explicitly.
   One successful reviewer is never described as cross-model consensus.

Read the [threat model](docs/threat-model.md), [harness ground truth](docs/harness-notes.md),
and [benchmark methodology](docs/benchmarking.md) before changing these boundaries.

## Review and ownership

Keep a pull request to one coherent model, harness/provider, benchmark set, or pipeline change.
Include the model/CLI version, provider route, authentication variable names (never values),
dated pricing evidence, redacted fixture paths, failure behavior, and exact validation commands.

An external integration can be co-maintained under the Juror organization when:

- at least one named contributor commits to triage and compatibility updates;
- its client and fixture licenses permit redistribution;
- the provider/model has a stable documented identifier and authentication contract;
- security isolation, secret handling, cost provenance, and failure tests meet the same gates as
  built-in integrations;
- releases can be pinned or otherwise reproduced, with an owner for upstream breaking changes;
  and
- maintainers agree on escalation, deprecation, and transfer of ownership in a public issue.

Organization hosting is stewardship, not endorsement or permanent support. An unmaintained or
unsafe integration may be deprecated while stored configurations continue to degrade clearly.

Security reports do not belong in public issues. Follow [`SECURITY.md`](SECURITY.md).
