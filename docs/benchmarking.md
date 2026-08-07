# Shadow-review benchmark

Use an adjudicated corpus before replacing an existing reviewer. One strong PR is useful
evidence, not a replacement decision; target 20–30 representative PRs covering frontend,
backend, migrations, concurrency, security-sensitive code, and both small and large diffs.

Run the bundled seed case:

```bash
npm run build
node dist/cli.js benchmark --file benchmarks/platform-10359.json
```

The corpus deliberately does not match findings automatically. A human reviewer defines
the expected defects, rejects false positives with `expected_id: null`, and maps every
valid report to an expected id. Repeated reports mapped to the same id count toward the
duplicate rate but only once toward recall.

For every PR:

1. Run Juror and the comparison reviewer on the same head SHA.
2. Combine their findings without reviewer labels and adjudicate each against the code.
3. Add every confirmed unique defect to `expected`.
4. Map each observed report to that id, or to `null` when it is incorrect.
5. Record measured cost and wall-clock duration; use `null` when a tool does not expose it.

Every case must list the same reviewers. A failed or skipped review is still a run: record
an empty `findings` array and unknown cost/time as needed, so missing executions cannot
silently disappear from a reviewer's denominator.

The command reports overall and P0–P2 recall, precision, duplicate rate, cost, latency,
and every miss. A replacement gate should be chosen before evaluating the final corpus;
at minimum, Juror should meet or exceed the incumbent's adjudicated P0–P2 recall without
an unacceptable precision regression. Keep the reviewers in shadow until the gate holds
across the full corpus, not just in aggregate on one favorable PR.

`benchmarks/platform-10359.json` is a seed based on the reviewed PR and the two supplied
Greptile comments. It is intentionally one case and must not be presented as statistically
sufficient evidence that either reviewer can replace the other.
