# Harness ground truth

Harness behavior here is measured by running the CLI whenever a provider key is available;
the one source-inspected exception is labeled explicitly. The adapters in `src/harness/`
are written against *this*, and several behaviours below contradict what documentation
implies. **If an adapter disagrees with this file, the adapter is wrong; if your intuition
disagrees with this file, re-measure before changing anything.**

Measured 2026-08-06 against: `claude` 2.1.223 · `codex-cli` 0.146.1 · `grok` 0.2.118 ·
`opencode` 1.17.20.

Source-inspected (no paid provider run) against: `@moonshot-ai/kimi-code` 0.34.0. Its
section below names that distinction rather than presenting inferred usage as measured.

`timeout(1)` does not exist on macOS, so every time limit is enforced in Node by
`run()` in `src/util/proc.ts` rather than by the shell. On Unix the harness starts in its
own process group and the timeout kills that group, including tool/server grandchildren;
Windows falls back to terminating the direct child.

---

## Claude Code — `claude -p --output-format json`

```
claude --bare -p --model claude-opus-5 --output-format json \
  --no-session-persistence --tools "Read,Grep,Glob" --add-dir "$REPO" \
  --max-budget-usd 1.00 < prompt.md
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
- Juror omits `--max-turns` by default, leaving the per-model wall-clock timeout as the
  termination boundary. A positive custom `max_turns` restores the CLI flag.
- It is the only harness that can enforce its per-model spend allocation. When `--max-budget-usd` trips it
  exits **1** with `subtype: "error_max_budget_usd"`, `terminal_reason: "budget_exhausted"`
  and a null result. Measured: one review of a 240-line diff in a large monorepo cost
  **$0.69**, which is why the default planning target is not $2.
- `--bare` disables project/user hooks, settings, MCP, skills, and instruction discovery.
  Juror starts Claude outside the repository; the repo is attached read-only through its
  tool list.
- Writes a harmless stderr warning about claude.ai connectors whenever `ANTHROPIC_API_KEY`
  is set. Collect it as a diagnostic; it is not a failure.

## Codex CLI — `codex exec --json`

```
CODEX_HOME="$PRIVATE_HOME" codex exec --json --ephemeral \
  -m gpt-5.6-sol -c model_reasoning_effort=high \
  --strict-config --ignore-rules --skip-git-repo-check < prompt.md
```

`$PRIVATE_HOME/config.toml` selects a managed permission profile with `:minimal` runtime
reads, read access to the sealed checkout, read/write access to Juror scratch, an explicit
deny for the private Codex home, and no shell network. This is intentionally narrower than
legacy `--sandbox read-only`, which prevents writes but permits host-wide reads.
The same private config disables shell snapshots and gives model-controlled commands an
explicit minimal environment (`PATH`, private `HOME`, scratch `TMPDIR`, and locale/shell
metadata); the OpenAI credential stays in the Codex client process and never enters a tool
command's environment.

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
- A single `turn.completed` can aggregate several provider requests around tool calls. Juror
  therefore records the per-request count as unknown, so a session total cannot spuriously
  trigger a per-request long-context price cliff.
- Success is defined by seeing `turn.completed`. `item.type === "error"` events are
  **non-fatal** and appear on successful exit-0 runs; treating one as failure throws away
  good reviews.
- `exec` reads stdin even when given a positional prompt. A job that leaves stdin open hangs
  until its timeout.
- Juror starts Codex in a private directory outside the repository so project `AGENTS.md`
  is not auto-discovered; trusted base-revision rules are already embedded in the prompt.
- Resolve the binary's absolute path and assert `--version`: multiple installs shadowing each
  other by PATH order is a real, observed failure (0.132.0 in one prefix, 0.146.1 in another).

## opencode — `opencode run --format json`

```
OPENCODE_CONFIG=$CFG opencode run --format json --dir "$REPO" \
  -m "fireworks-ai/accounts/fireworks/models/deepseek-v4-flash-0731" \
  "Read the attached review prompt completely…" --file prompt.md < /dev/null
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
- Three behaviours that each cost a debugging session:
  1. **Concurrent runs sharing a data dir die instantly** with `Error: database is locked`
     and empty stdout — its sessions live in SQLite. Give each invocation its own
     `XDG_DATA_HOME`.
  2. **It snapshots the project into its data dir.** Put that dir inside the repo and the run
     dies in about a second and leaves a tree that will not delete. `"snapshot": false` also
     avoids copying a full git object store on every review of a large repo.
  3. **`OPENCODE_CONFIG` does not isolate ambient configuration by itself.** Run with
     `--pure`, a private `HOME`/XDG tree, `OPENCODE_DISABLE_PROJECT_CONFIG=true`, and the
     corresponding external-skills, Claude-prompt/skills, and default-plugin disable flags.
     Otherwise a developer's global setup changes the review, while a PR-controlled project
     config can inject tools or instructions before the review prompt is applied.
- Config that works, written to scratch and passed via `OPENCODE_CONFIG`:
  ```json
  { "$schema": "https://opencode.ai/config.json", "autoupdate": false, "share": "disabled",
    "snapshot": false, "instructions": [],
    "tools": { "bash": false, "edit": false, "webfetch": false, "task": false, "todowrite": false, "patch": false },
    "permission": { "read": "allow", "glob": "allow", "grep": "allow", "list": "allow",
                    "edit": "deny", "bash": "deny", "webfetch": "deny", "websearch": "deny",
                    "external_directory": { "*": "deny", "$REPO/**": "allow", "$SCRATCH/**": "allow" } } }
  ```

## Kimi Code — `kimi -p --output-format stream-json`

```
KIMI_MODEL_PROVIDER_TYPE=openai \
KIMI_MODEL_BASE_URL=https://api.fireworks.ai/inference/v1 \
KIMI_MODEL_NAME=accounts/fireworks/models/kimi-k3 \
KIMI_MODEL_API_KEY="$FIREWORKS_API_KEY" \
KIMI_CODE_EXPERIMENTAL_FLAG=1 \
  kimi -p "Read $SCRATCH/prompt.md completely…" --output-format stream-json \
  --skills-dir "$EMPTY_SKILLS" --agent-file "$REVIEW_PROFILE" \
  --add-dir "$REPO" --add-dir "$SCRATCH"
```

Kimi K3 is always served through Fireworks in Juror's built-in presets. The provider's model
page is the source of truth for the model id, 1.04M context window, and current
`$3 / $0.30 / $15` per-million input/cached-input/output prices.

- `KIMI_MODEL_NAME` synthesizes a temporary provider/model and selects it as the default.
  The model name is the provider model id, not a CLI alias, so passing the same value via
  `-m` would select a nonexistent alias.
- `KIMI_LOOP_MAX_STEPS_PER_TURN=0` is passed by default. Kimi Code 0.34.0 defines zero as
  no cap; a positive custom `max_turns` value opts back into a step limit.
- Print mode creates/resumes the session with `permission: "auto"` and installs an approval
  handler that approves every call. Juror therefore supplies an explicit agent file whose
  complete tool list is `Read, Grep, Glob`; write, shell, web, MCP, and subagents never enter
  the model's tool set.
- Run from a private directory outside the repository and attach the repo with `--add-dir`.
  Otherwise Kimi discovers project `.mcp.json` before the model starts, which could launch a
  PR-controlled stdio command while the Fireworks key is present.
- `stream-json` writes one JSON object per line. Assistant output is
  `{"role":"assistant","content":"..."}`; tool calls/results occupy their own messages.
  It does not expose token usage or provider-computed USD cost. Kimi does persist one
  normalized `usage.record` per provider request in its private session `wire.jsonl`, so the
  adapter sums those records before deleting the runtime and estimates the charge from the
  checked-in Fireworks rates. If a future CLI omits those records, the receipt falls back to
  unknown rather than inventing a number.
- `--skills-dir` replaces auto-discovered skill directories. `KIMI_CODE_HOME`, telemetry,
  auto-update, and built-in product skills are also isolated/disabled so a local
  developer setup cannot change a CI review.

## Grok Build — `grok -p --output-format json`

```text
(cd "$PRIVATE_CWD" && \
  HOME="$PRIVATE_HOME" GROK_HOME="$PRIVATE_HOME/.grok" \
    grok --prompt-file "$PROMPT" -m grok-4.5 \
    --output-format json --sandbox juror-review --tools "Read,Grep,Glob" \
    --deny 'MCPTool(*)' --permission-mode dontAsk --no-subagents --no-memory \
    --disable-web-search)
```

Flags confirmed present: `-p/--single`, `--prompt-file`, `--output-format`,
`--sandbox <PROFILE>`, `--tools`, `--disallowed-tools`, `-m/--model`, `--max-turns`,
`--permission-mode`, `--allow`, `--deny`, `--reasoning-effort`, `--no-subagents`,
`--no-memory`, and `--disable-web-search`. `GROK_SANDBOX` is honoured.

Juror supplies the review with `--prompt-file`, avoiding OS command-line size limits. It
omits `--max-turns` by default and adds it only for a positive custom `max_turns`.

- Grok discovers project rules, `.grok/config.toml`, hooks, plugins, skills, agents, and MCP
  servers from its startup directory. Juror therefore starts it in a private non-repository
  cwd with a private `HOME`/`GROK_HOME`, not in the reviewed checkout. Trusted base-revision
  `AGENTS.md` content is already embedded in the prompt.
- `--tools` names Grok's canonical built-ins (`Read,Grep,Glob`), not the lower-level tool
  function names. MCP meta-tools deliberately survive that built-in allowlist, so Juror also
  supplies `--deny 'MCPTool(*)'` and disables subagents, memory, and web tools.
- The private `sandbox.toml` extends Grok's `strict` kernel profile and adds exactly the
  sealed checkout and Juror scratch as read-only roots. The model can inspect PR-side config
  files as source, but those files cannot participate in startup discovery or execute hooks.
- A timeout, nonzero exit, `is_error`, turn-limit stop reason, or exhaustion of an explicit
  `max_turns` is marked partial even when Grok managed to return a parseable report.

`parse()` probes the documented whole-object and JSONL shapes and, when neither exposes
usage, returns `usage: null` so the receipt prints `unknown` rather than a fabricated number.

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
0.65 and prose at 0.35. Similarity routes these pairs to the referee; it never merges
non-identical reports on its own. The referee must confirm the same faulty mechanism and
actionable fix plus substantially overlapping behavior; one report may list extra entry
points or effects. Its response must account for every candidate id. A malformed complete
partition gets one bounded retry, then fails open. A post-merge audit proves every raw
atomic finding still has one final disposition.
`test/consensus-real.test.ts` pins the routing against the verbatim findings.
