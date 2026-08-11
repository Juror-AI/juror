# Adding a harness or provider

A harness is a credential and execution boundary, not just a command wrapper. Use this path
when a model cannot safely run through a shipped adapter or needs a new provider authentication
shape. Record measured CLI/API behavior in `docs/harness-notes.md`; label source inspection and
unpaid inference as such.

## Minimum adapter shape

Implement the `Harness` contract, add its id to `HarnessId`, and register it exactly once in
`src/harness/registry.ts`:

```ts
export const exampleHarness: Harness = {
  id: 'example',
  label: 'Example',
  async locate(env) {
    // Resolve an absolute binary, probe a pinned/tested version, return warnings.
    return { binPath: '/absolute/example', version: '1.2.3', warnings: [] };
  },
  command(ctx) {
    return {
      argv: ['example', '--json', '--model', ctx.model],
      env: ctx.env,
      stdin: ctx.prompt,
      cwd: ctx.scratchDir,
    };
  },
  parse(io, ctx) {
    // Narrow unknown JSON, prefer the exact findings file, normalize usage, never throw on drift.
    return { report: null, usage: null, reportedCostUsd: null, turns: 0,
      truncated: io.timedOut, rawText: io.stdout, diagnostics: [] };
  },
  async cleanup(ctx) {
    // Remove adapter-owned sessions/config on every outcome.
  },
};
```

The snippet demonstrates the interface, not sufficient isolation. Copy the closest shipped
adapter and its tests rather than filling the skeleton with permissive defaults.

## Security and authentication requirements

- Add a canonical `JUROR_<PROVIDER>_API_KEY` and map it to the exact vendor variable only inside
  the adapter invocation. Update init readiness, generated workflows, Action pre-review secret
  blanking, child-environment clearing, log redaction, and the CI secret scanner.
- Never put keys in argv, prompts, tool results, findings files, diagnostics, caches, or fixtures.
  Never pass `GITHUB_TOKEN` or an ambient environment to the harness.
- Start from a private cwd, HOME, config, cache, data, and session tree. Disable project/user
  hooks, instructions, plugins, skills, MCP, auto-update, telemetry, sharing, and shell snapshots.
- Give the model only the sealed checkout and per-run scratch. Prefer kernel enforcement; when
  unavailable, remove mutating/shell/network tools and enforce canonical path/symlink checks.
- Prevent cross-juror state by giving concurrent invocations independent directories. Bound
  stdout/stderr parsing and delete private state on every lifecycle outcome.
- Pin the installed client version or immutable artifact in `action.yml`; install it with all
  provider and GitHub credentials removed. Document any unavoidable mutable installer risk.

## Usage, cost, and failure requirements

Capture provider-reported USD when the output contract documents it. Otherwise normalize
uncached input, cache reads, cache writes, output, request count, and context thresholds so the
versioned pricing table can estimate cost. A missing field is unknown, not zero. Fixtures must
cover cached-token semantics and malformed/missing usage.

Authentication failure, missing executable, unsupported model, timeout, turn cap, malformed
output, and partial report must remain visible in the run/receipt. Parsers should recover a
valid exact findings file when safe, but never turn a nonzero/partial execution into consensus
without diagnostics.

## Required tests and evidence

- `locate()` version/path behavior and unsupported-version warning.
- Exact argv, stdin, cwd, private paths, tool restrictions, and allowlisted environment.
- Proof that other provider keys and GitHub tokens are absent.
- Success, nonzero exit, timeout, malformed output, missing usage, cache usage, and cleanup.
- Parallel invocations use distinct runtime state.
- Action install pin/cache behavior, init readiness, secret upload over stdin, and secret scan.
- Redacted fixtures for each output shape and the exact version/command that produced them.
- Compatibility matrix regeneration and all repository validation commands.

Read [`docs/threat-model.md`](../threat-model.md) and the existing
[`generic-openai`](../../src/harness/generic-openai.ts) adapter for the smallest in-process
reference boundary.
