# Draft: We benchmarked a jury of code-review agents—and published the misses and bill

Status: blocked; replace every bracketed field from the frozen launch evidence before publishing.

## The claim

Juror runs independent model families against one pull request, conservatively collapses reports
about the same defect, and shows what the review cost. On a preregistered [N]-PR adjudicated
corpus at [commit], Juror [preset/version] measured:

- P0–P2 recall: [value and denominator]
- precision: [value and denominator]
- duplicate rate: [value and denominator]
- cost per review: [reported/estimated/lower-bound value and coverage]
- median/p90 time to first successful two-family review: [values]
- week-4 lighthouse retention: [value and cohort denominator]

Those numbers are not claims about every repository. The corpus composition, every expected
defect, observed report mapping, skipped reviewer, unknown cost, and reproduction command are
[link]. The recruited lighthouse cohort and missing-data coverage are [link].

## What changed after the first launch

The first announcement led with a generic open-source-alternative framing before representative
evidence and activation were ready. Since then we added [one-command onboarding evidence],
[representative corpus], [public examples], [security/provenance work], and [retention evidence].
The substantive milestone is the public proof bundle, not a new version number.

## How the review works

Explain the sealed checkout, independent scratch/runtime boundaries, provider-key allowlists,
lossless clustering/coverage audit, no-consensus degradation, and reported-vs-estimated receipt.
Link exact implementation files and one public review rather than relying on an architecture
graphic alone.

## Reproduce it

```bash
git checkout [evidence commit]
npm ci --no-audit --no-fund
npm run build
node dist/cli.js benchmark --file [frozen corpus]
```

Then include the one-secret opt-in and direct-provider setup commands for the released version,
with immutable Action pins and no live credentials.

## What failed and what remains limited

Name at least:

1. corpus/sample limits and stack gaps;
2. provider/model drift and partial/unknown cost coverage;
3. fork PRs and single-model runs that cannot produce cross-model consensus;
4. prompt injection/model fallibility despite credential/filesystem boundaries; and
5. the fact that acted-on/confirmed outcomes require explicit humans.

List misses and lighthouse churn reasons that materially changed the roadmap.

## What we want feedback on

Ask narrow questions about the benchmark, isolation boundary, receipt semantics, contributor
paths, and which representative repositories/cases are missing. Do not ask for stars, votes,
reposts, or unstructured “support.”
