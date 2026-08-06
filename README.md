# Juror

**N frontier models review your PR in parallel, through their own native agent harnesses.
Only what they *agree on* gets posted. Every review prints its own receipt.**

```
npx juror review --pr 1234
```

---

## Why

Single-model PR bots have two problems, in order of how much they cost you:

1. **Noise.** One model's false positives are unfiltered. Teams stop reading the bot.
2. **Opacity.** You pay per seat or per PR and never see what the inference actually cost.

Juror attacks both with the same mechanism. Running several models and publishing only the
intersection converts *model disagreement* — normally invisible — into a precision filter.
A finding three models independently flag is real. A finding one model flags is usually a
style opinion wearing a bug costume.

And there is no index and no SaaS. A coding agent doesn't need a prebuilt semantic index:
Claude Code, Codex, and opencode all ship `Read`/`Grep`/`Glob` and will go read the callers
of the function you changed. You get repo-wide context for the price of a few tool calls,
with zero indexing infrastructure, zero staleness, and no code leaving the runner beyond the
model API call itself.

**Non-goals.** Not an autofix bot. Not a linter (yours is better and free). Not a chat
interface. It reviews a diff and posts findings.

---

## What you get

A sticky summary comment with a deterministic merge score, a findings table annotated with
how many models agreed, a collapsed block showing everything that was *suppressed* and why,
and a cost receipt:

```
💸 This review cost $0.97 · 4 models · 2m14s

| Model                | Harness     | Input | Cached | Output | Cost  | Source    |
| claude-opus-5        | Claude Code | 41.2k | 38.0k  | 6.1k   | $0.18 | reported  |
| gpt-5.6-sol          | Codex       | 39.8k | 12.1k  | 8.9k   | $0.41 | estimated |
| deepseek-v4-flash…   | opencode    | 40.1k | 0      | 5.2k   | $0.02 | reported  |
| grok-4.5             | Grok Build  | —     | —      | —      | —     | skipped   |
```

Plus inline comments, posted as **one batched review** — one notification, not twelve.

---

## Install

### GitHub Action

```yaml
name: Juror
on:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
  pull-requests: write
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: juror-dev/juror@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          OPENAI_API_KEY:    ${{ secrets.OPENAI_API_KEY }}
          FIREWORKS_API_KEY: ${{ secrets.FIREWORKS_API_KEY }}
          XAI_API_KEY:       ${{ secrets.XAI_API_KEY }}
```

**Any model whose key is absent is skipped with a note in the receipt.** A repo with one key
still gets a working single-model review. Degrade, never fail.

### Locally

The same binary, the same code path, no CI-only surprises:

```bash
npm i -g @juror/cli

juror review --base main                       # review your working branch
juror review --pr 1234 --repo owner/name       # review a PR, print to the terminal
juror review --pr 1234 --repo owner/name --post  # ...and post it
```

Put your keys in a `.env` beside the repo (it is loaded automatically and never committed):

```
ANTHROPIC_API_KEY=…
OPENAI_API_KEY=…
FIREWORKS_API_KEY=…
```

---

## Supported models & harnesses

Juror drives each model through its **native agent harness**, so each one greps your repo
the way its vendor intended.

| Harness | CLI | Models | Reports cost | Sandbox |
|---|---|---|---|---|
| `claude-code` | `claude -p` | any Anthropic model | ✅ `total_cost_usd` | tool removal |
| `codex` | `codex exec` | any OpenAI model | ❌ → estimated | `--sandbox` (kernel) |
| `opencode` | `opencode run` | anything on [models.dev](https://models.dev) — Fireworks, Groq, OpenRouter, … | ✅ per-step `cost` | tool removal |
| `grok-build` | `grok -p` | Grok models | ✅ `total_cost_usd` | Landlock |
| `generic-openai` | *(in-process)* | any OpenAI-compatible endpoint | ❌ → estimated | path-confined tools |

The `opencode` harness is the reason adding a model is a config edit rather than a PR. To add
**DeepSeek V4 Flash** to your jury:

```yaml
models:
  - id: deepseek-v4-flash-0731
    harness: opencode
    harness_model: fireworks-ai/accounts/fireworks/models/deepseek-v4-flash-0731
    pricing_key: accounts/fireworks/models/deepseek-v4-flash-0731
    secret: FIREWORKS_API_KEY
    args: { variant: high }
```

---

## Configuration

`.juror.yml` at the repo root. Every key is optional; the defaults are what you see below.

```yaml
version: 1

models:
  - { id: claude-opus-5,          harness: claude-code, secret: ANTHROPIC_API_KEY }
  - { id: gpt-5.6-sol,            harness: codex,       secret: OPENAI_API_KEY, args: { reasoning_effort: high } }
  - { id: deepseek-v4-flash-0731, harness: opencode,    secret: FIREWORKS_API_KEY }
  - { id: grok-4.5,               harness: grok-build,  secret: XAI_API_KEY }

consensus:
  min_agreement: majority        # majority | all | <number>
  verify_solo_findings: true     # adversarially refute anything only one model saw
  verify_model: deepseek-v4-flash-0731

review:
  severity_floor: P2             # don't post P3 inline
  max_inline_comments: 15
  incremental: true              # re-review only new commits
  paths_ignore: ["**/*.lock", "dist/**", "**/*.generated.*"]

budget:
  max_cost_usd_per_pr: 5.00      # split evenly across the models that have a key
  on_exceed: partial             # partial | skip

output:
  sequence_diagram: true
  cost_receipt: true
  suppressed_findings: collapsed # collapsed | hidden | inline
```

---

## How consensus works

Cheap methods first; a model call only where the free ones are ambiguous.

1. **Anchor** *(free)* — snap every finding to a line the diff actually adds or modifies.
   Findings landing outside the diff are reported separately, never silently dropped.
2. **Block** *(free)* — group by file, then by overlapping line window.
3. **Jaccard merge** *(free)* — token-set similarity over `title + body`, identifiers
   weighted 2×. `J > 0.55` → same finding. `J < 0.30` → distinct.
4. **Referee** *(cheap, rare)* — one small call per ambiguous block. Typically 0–2 per PR.
5. **Verify** *(adversarial)* — every P0/P1 and every single-model finding gets a refutation
   pass. The verifier is asked to *refute*, and defaults to refuted when the evidence isn't
   clear. That asymmetry is deliberate: precision is what we're buying.

Then:

```
publish if  agreement >= majority
        or (agreement >= 2 and severity in {P0,P1})
        or (agreement == 1 and severity in {P0,P1} and survived refutation)
```

Everything else lands in the collapsed **suppressed** block with the reason. Nothing is
thrown away — that transparency is what makes the filter trustworthy.

## The merge score

Not a model opinion — a deterministic function of verified findings, with the votes shown
so the arithmetic is auditable.

```
base    = median(each model's self-reported merge confidence)
penalty = 2·P0 + 1·P1 + min(1, 0.5·P2)     (confirmed, published findings only)
score   = clamp(round(min(base, 5 - penalty)), 1, 5)
```

`min(base, 5 - penalty)` is the load-bearing part: models cannot vote away a confirmed
blocker, and a clean diff still can't reach 5 if the models were individually unsure.

---

## Cost accounting

The differentiator, and the thing that must never be wrong.

- **Never fabricate.** Every figure is labeled `reported` (provider-computed) or `estimated`
  (tokens × list price). A harness that returns neither prints **`unknown`**, and the total
  is marked as a lower bound. We do not guess.
- **Long-context tiers are cliffs, not slopes.** GPT-5.6 Sol reprices the *entire request* at
  2× input above 272k tokens; Grok 4.5 does the same above 200k. A flat per-token config
  silently underbills exactly the large-diff reviews that cost the most.
- **Cache writes are not free.** On GPT-5.6 and later they bill at 1.25× the uncached input
  rate. Anthropic bills them too. Juror models a review as write-once, read-many: the first
  model to see a diff pays the write premium, and re-reviews on later pushes get cheap.
- **Codex `input_tokens` includes cached tokens; Claude's and opencode's do not.** Normalizing
  naively overbills a cache-heavy Codex run by up to an order of magnitude. There is a
  regression test pinned to a real `turn.completed` payload for exactly this.

`src/cost/pricing.json` is versioned, dated, and every entry carries a source URL.

---

## Security

This is a bot that pipes attacker-controlled text into an agent and then writes to your PR.
It is designed for that.

1. **No model process ever sees `GITHUB_TOKEN`.** Agents write JSON to a scratch directory; a
   separate step with no model in the loop reads it and calls the GitHub API. Prompt injection
   can at worst produce a bad review comment — never a push, a merge, or an exfiltration.
2. **Default trigger is `pull_request`, not `pull_request_target`.** Fork PRs get no secrets
   and no review, by design.
3. **Sandbox where the harness supports it.** Codex and Grok Build get kernel-enforced
   sandboxes. Claude Code and opencode get tool removal (no shell, no network tools), plus a
   post-run **workspace guard** that reverts any file an agent modified that was clean before
   the run — and never touches a file that was already dirty.
4. **Keys are passed per harness**, never to all of them. Each model process gets an
   environment containing only its own provider key.
5. **Injection is a finding.** Each model is told the diff is untrusted data and to report
   embedded instructions as a P0. Several independent models make a uniform injection
   substantially harder.
6. **Repository rules come from the base revision.** Juror places the root `AGENTS.md` and
   every applicable nested `AGENTS.md` directly in reviewer and verifier prompts. A PR can
   update those files for future work, but cannot rewrite the policy used to review itself.
   If the base object is unavailable locally, Juror warns and only uses a workspace copy the
   visible diff does not change.
7. **Everything posted is redacted** for secret-shaped strings first.

---

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
node dist/cli.js review --base main
```

Layout follows the pipeline: `src/diff` → `src/harness` → `src/merge` → `src/cost` →
`src/render` → `src/github`. `src/types.ts` is the only shared vocabulary.

## Limitations

- Cost for Codex is **estimated**, not reported — the CLI exposes tokens but no dollar figure.
- Grok Build's headless JSON shape is parsed defensively and marked `unknown` when the fields
  aren't there, rather than guessed at.
- Consensus needs ≥2 models to mean anything. With one key configured you get a competent
  single-model reviewer and an honest receipt, but no precision filter.
- Findings anchored outside the diff are surfaced in the summary but not posted inline,
  because GitHub can't attach them.

## License

MIT.
