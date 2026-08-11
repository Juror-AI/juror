# Adding an adjudicated benchmark case

Benchmark cases measure reviewers; they are not marketing examples. The code owner must permit
use of the diff/finding descriptions, and private source must not be committed. Prefer public
pull requests with stable links or synthetic reproductions that preserve the defect mechanism.

## Minimal case

Add a case to an existing version-1 corpus or introduce a focused corpus under `benchmarks/`:

```json
{
  "id": "owner/repository#123",
  "url": "https://github.com/owner/repository/pull/123",
  "expected": [
    { "id": "lost-update", "severity": "P1", "title": "Concurrent write is discarded" }
  ],
  "runs": [
    {
      "reviewer": "Juror Fast",
      "cost_usd": 0.42,
      "duration_ms": 91000,
      "findings": [
        { "title": "Write races overwrite state", "severity": "P1", "expected_id": "lost-update" }
      ]
    },
    {
      "reviewer": "Comparison reviewer",
      "cost_usd": null,
      "duration_ms": null,
      "findings": []
    }
  ]
}
```

Every case in one corpus contains the same reviewer names. Failed/skipped runs remain present
with empty findings and unknown cost/time; otherwise the failure vanishes from the denominator.

## Adjudication and fixtures

1. Run reviewers on the same commit and preserve raw outputs privately.
2. Remove reviewer labels, combine claims, and have a human inspect the code.
3. Add every confirmed unique defect to `expected`.
4. Map a valid observed report to `expected_id`; use `null` for a false positive. Use a shared
   `duplicate_key` only for repeated rejected claims about the same alleged defect.
5. Record actual cost and wall time when exposed. `null` means unknown; never enter zero for a
   missing receipt.
6. Commit the minimized corpus fixture, methodology/source attribution, consent or public-source
   basis, reviewer/model versions, provider route, and run date. Do not commit prompts, source
   snapshots, credentials, provider session ids, or private repository identifiers.

The adjudicator must explain ambiguous mappings in the pull request. Automated semantic
matching may suggest candidates but cannot define ground truth.

## Validation

```bash
npm run build
node dist/cli.js benchmark --file benchmarks/<corpus>.json
npm test -- test/benchmark.test.ts
```

Add parser tests for invalid ids, mismatched reviewers, missing runs, duplicate accounting, and
partial cost when the corpus exercises a new shape. Follow the full method and replacement gate
in [`docs/benchmarking.md`](../benchmarking.md).
