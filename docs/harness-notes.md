# Harness ground truth

Every shape in this file was measured by running the CLI, not read off a docs page. The
adapters in `src/harness/` are written against *this*, and several of the behaviours below
contradict what the documentation implies. **If an adapter disagrees with this file, the
adapter is wrong; if your intuition disagrees with this file, re-measure before changing
anything.**

Measured 2026-08-06 against: `claude` 2.1.223 · `codex-cli` 0.146.1 · `grok` 0.2.118 ·
`opencode` 1.17.20.

`timeout(1)` does not exist on macOS, so every time limit is enforced in Node by
`run()` in `src/util/proc.ts` rather than by the shell.

---

## Claude Code — `claude -p --output-format json`

```
claude -p "<prompt>" --model claude-opus-5 --output-format json \
  --tools "Read,Grep,Glob,Write" --add-dir "$SCRATCH" \
  --max-turns 40 --max-budget-usd 1.00
```

One JSON object on stdout. Verified keys: `type, subtype, is_error, num_turns, result,
total_cost_usd, duration_ms, usage, modelUsage, session_id, stop_reason, terminal_reason,
permission_denials`.

- `.result` — final assistant text. `.total_cost_usd` — **reported** cost, and it includes
  the small Haiku side-calls Claude Code makes on its own.
- `.usage.input_tokens` **excludes** cached tokens. Observed `input_tokens: 6` against
  `cache_read_input_tokens: 12133`. Do not subtract anything.
- `.modelUsage` breaks usage down per model, including the Haiku helper.
- `--tools` **removes** every tool not listed. `--allowedTools` merely auto-approves — using
  it where you meant `--tools` leaves the agent holding a shell.
- It is the only harness that can enforce a spend ceiling. When `--max-budget-usd` trips it
  exits **1** with `subtype: "error_max_budget_usd"`, `terminal_reason: "budget_exhausted"`
  and a null result. Measured: one review of a 240-line diff in a large monorepo cost
  **$0.69**, which is why the default per-PR budget is not $2.
- Writes a harmless stderr warning about claude.ai connectors whenever `ANTHROPIC_API_KEY`
  is set. Collect it as a diagnostic; it is not a failure.

## Codex CLI — `codex exec --json`

```
codex exec --json --sandbox workspace-write \
  -c sandbox_workspace_write.writable_roots="[\"$SCRATCH\"]" \
  -m gpt-5.6-sol -c model_reasoning_effort=high \
  --ignore-user-config --skip-git-repo-check < prompt.md
```

JSONL on stdout: `thread.started`, `turn.started`, `item.started`, `item.completed`,
`turn.completed`.

- Final text: the last `item.completed` with `item.type === "agent_message"`, at `.item.text`.
- Usage rides on `turn.completed`. Real measured payload:
  ```json
  {"type":"turn.completed","usage":{"input_tokens":52020,"cached_input_tokens":39168,
   "cache_write_input_tokens":0,"output_tokens":156,"reasoning_output_tokens":27}}
  ```
- **`input_tokens` INCLUDES `cached_input_tokens`** — the opposite of Claude and opencode.
  Canonical `uncachedIn = input_tokens - cached_input_tokens`. Getting this wrong overbills
  a cache-heavy run by roughly 10x, which is why `test/codex-usage.test.ts` pins the exact
  payload above.
- Do **not** add `reasoning_output_tokens` to `output_tokens`; it is already included.
- `cache_write_input_tokens` is new in 0.146.x. Older versions silently drop a real charge —
  OpenAI bills cache writes at 1.25x the uncached input rate — so the adapter warns below the pin.
- **No cost field at all.** Codex cost is always `estimated`.
- Success is defined by seeing `turn.completed`. `item.type === "error"` events are
  **non-fatal** and appear on successful exit-0 runs; treating one as failure throws away
  good reviews.
- `exec` reads stdin even when given a positional prompt. A job that leaves stdin open hangs
  until its timeout.
- `-s` is not global across subcommands — use `--sandbox` after `exec`.
- Resolve the binary's absolute path and assert `--version`: multiple installs shadowing each
  other by PATH order is a real, observed failure (0.132.0 in one prefix, 0.146.1 in another).

## opencode — `opencode run --format json`

```
OPENCODE_CONFIG=$CFG opencode run --format json --dir "$REPO" \
  -m "fireworks-ai/accounts/fireworks/models/deepseek-v4-flash-0731" "<prompt>" < /dev/null
```

JSONL on stdout: `step_start`, `tool_use`, `text`, `step_finish`.

- Final text: concatenate `.part.text` across the `text` events sharing the **last**
  `.part.messageID`. Intermediate steps emit `"\n\n"` filler.
- Every `step_finish` carries `.part.tokens = { total, input, output, reasoning,
  cache: { write, read } }` and `.part.cost` in USD. Sum `cost` across steps for a
  **reported** figure. `input` **excludes** cache — do not subtract.
  Measured: `{"tokens":{"total":14815,"input":78,"output":57,"reasoning":0,
  "cache":{"write":0,"read":14680}},"cost":0.00043792}`.
- Provider keys come from the environment via models.dev metadata. `FIREWORKS_API_KEY` alone
  enables every `fireworks-ai/...` model with no login step.
- Five behaviours that each cost a debugging session:
  1. **Writes outside `--dir` are auto-rejected** in headless mode
     (`! permission requested: external_directory ...; auto-rejecting`), and the rejection
     appears only on stderr. The findings file must live inside the project dir.
  2. **Restricting `edit` by glob removes the write tool entirely.** An object-form rule with
     a `"*": "deny"` catch-all makes the model answer "I don't have a write tool available".
     Allow `edit` and constrain the blast radius by disabling tools instead.
  3. **Concurrent runs sharing a data dir die instantly** with `Error: database is locked`
     and empty stdout — its sessions live in SQLite. Give each invocation its own
     `XDG_DATA_HOME`.
  4. **It snapshots the project into its data dir.** Put that dir inside the repo and the run
     dies in about a second and leaves a tree that will not delete. `"snapshot": false` also
     avoids copying a full git object store on every review of a large repo.
  5. **`OPENCODE_CONFIG` does not isolate ambient configuration by itself.** Run with
     `--pure`, a private `HOME`/XDG tree, `OPENCODE_DISABLE_PROJECT_CONFIG=true`, and the
     corresponding external-skills, Claude-prompt/skills, and default-plugin disable flags.
     Otherwise a developer's global setup changes the review, while a PR-controlled project
     config can inject tools or instructions before the review prompt is applied.
- Config that works, written to scratch and passed via `OPENCODE_CONFIG`:
  ```json
  { "$schema": "https://opencode.ai/config.json", "autoupdate": false, "share": "disabled",
    "snapshot": false, "instructions": [],
    "tools": { "bash": false, "webfetch": false, "task": false, "todowrite": false, "patch": false },
    "permission": { "read": "allow", "glob": "allow", "grep": "allow", "list": "allow",
                    "edit": "allow", "bash": "deny", "webfetch": "deny", "websearch": "deny" } }
  ```

## Grok Build — `grok -p --output-format json`

Flags confirmed present: `-p/--single`, `--output-format`, `--sandbox <PROFILE>`, `--tools`,
`--disallowed-tools`, `-m/--model`, `--max-turns`, `--permission-mode`, `--allow`, `--deny`,
`--disable-web-search`. `GROK_SANDBOX` is honoured.

**The output shape is unverified** — no xAI key was available when the adapter was written.
`parse()` therefore probes several shapes and, when none matches, returns `usage: null` so the
receipt prints `unknown` rather than a fabricated number. If you have a key, run it and
replace this paragraph with measurements.

---

## Consensus similarity — why it is not prose Jaccard

Three models independently reviewed the same seven-line diff and all three found the same
clipboard defect, describing it three different ways. Weighted prose Jaccard over
`title + body` scored those pairs at **0.263, 0.225, 0.326** — below the 0.30 "distinct"
threshold. The ensemble would have published one unanimous bug as three separate
single-model findings: the exact inverse of the product's premise.

Jaccard over the **identifiers** each finding cites, on the same data:

| pair | prose | identifiers |
|---|---|---|
| same defect (3 pairs) | 0.23 – 0.33 | **0.56 – 0.86** |
| unrelated defects | 0.05 – 0.13 | 0.13 – 0.25 |

Independent writers share about a quarter of their vocabulary even when they agree
completely, but they cite the same code symbols. So `similarity()` weights identifiers at
0.65 and prose at 0.35. `test/consensus-real.test.ts` pins this against the verbatim findings.
