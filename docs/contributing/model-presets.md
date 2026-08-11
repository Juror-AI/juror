# Adding a model or preset

Use this path when a shipped harness already provides the required authentication, isolation,
tool, output, usage, and cost behavior. If any of those contracts change, use the
[harness/provider path](harness-providers.md) instead.

## Evidence required in the issue

- Exact provider model id and, when available, immutable revision/version.
- Serving provider and endpoint/route used by the harness.
- Juror-facing secret name and vendor-facing authentication shape. Name variables only; never
  include a credential.
- Official pricing URL, rates, context tiers, cache read/write behavior, currency/unit, and the
  date checked. Use `null`/unknown for unpublished rates.
- Harness and version used to reproduce a successful run, plus redacted success, malformed,
  authentication-failure, and unavailable-model fixtures where applicable.
- Proposed preset membership and why it improves family/provider diversity, quality, latency,
  or cost rather than merely increasing model count.

## Minimal reference change

A model must be both in `BUILTIN_MODELS` and reachable from a preset. This illustrative Claude
entry uses an existing harness and canonical secret; the real contribution must also update
the matching membership assertions and regenerate the compatibility matrix:

```ts
'claude-sonnet-5': {
  id: 'claude-sonnet-5',
  harness: 'claude-code',
  enabled: true,
  secret: 'JUROR_ANTHROPIC_API_KEY',
  label: 'Sonnet 5',
},
```

Then add the id to one or more `PRESET_DEFINITIONS[*].modelIds`. A built-in entry in no preset
is dead configuration and fails the compatibility check. When introducing a new preset, also
update `ReviewPreset`, `REVIEW_PRESETS`, CLI/Action help, README membership, initialization,
and tests for its consensus/referee model and degradation behavior.

Add or verify the `src/cost/pricing.json` row keyed by `pricing_key ?? id`. Every entry needs a
dated source. Long-context thresholds apply to an entire provider request unless evidence says
otherwise; do not infer per-request tiers from aggregate multi-turn usage.

## Security, failure, and test checklist

- Reuse the harness's canonical Juror secret. A model-specific secret is justified only when
  the provider's authentication boundary truly differs.
- Do not add credentials to config examples, fixtures, prompts, command arguments, reports, or
  logs. Tests assert variable names and synthetic values only.
- Confirm the harness passes the provider model string exactly and that aliases cannot silently
  route to a different family. Aggregators should expose the provider-returned model id in the
  receipt when available.
- Make an unavailable model a visible skipped/failed row. Presets with fewer than two completed
  families must emit the no-consensus warning.
- Add preset membership, config parsing, auth readiness, pricing/cost, and receipt tests. Add a
  redacted parser fixture if the model produces a distinct output shape.
- Run `npm run docs:compatibility` and inspect the generated route, secret, presets, cost mode,
  and pricing link.

Validate with the commands in [`CONTRIBUTING.md`](../../CONTRIBUTING.md). A paid smoke test is
useful but cannot replace deterministic fixtures and must never be required for contributors to
run the test suite.
