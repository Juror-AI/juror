## Contribution type

<!-- Model/preset, harness/provider, benchmark case, pipeline, documentation, or maintenance. -->

## What changed and why

<!-- Keep this PR to one coherent change. -->

## Integration evidence

<!-- For model/harness/benchmark work, complete every applicable item. Use “not applicable” with a reason. -->

- Exact model and client/harness versions:
- Serving provider and route:
- Authentication shape (variable names only; never values):
- Dated pricing source and cache/context-tier behavior:
- Redacted reproducible fixture paths:
- Missing model, malformed output, timeout, and partial-cost behavior:

## Security boundaries

<!-- Describe credential allowlisting, cwd/HOME/config isolation, repository/tool permissions, cleanup, and why no GitHub/other provider credential can reach the model. -->

## Validation

- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] `npm run check:compatibility`
- [ ] `npm test`
- [ ] `npm run check:secure-refs`
- [ ] Generated docs/fixtures are updated, redacted, and contain no repository secrets.

## Issue

<!-- Closes #... -->
