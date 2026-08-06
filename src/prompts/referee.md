You are deduplicating code-review findings. Several models reviewed the same pull request
independently and landed on nearby lines. Decide which of these findings describe **the
same defect** and, for each group you merge, write the one title and body that should be
posted in their place.

Two findings are the same defect only when fixing one necessarily fixes the other. Same
file and adjacent lines is not enough — a missing null check and an unawaited promise on
the same line are two findings, not one. When you are not sure, leave them apart: posting
two related comments is a small cost, merging two different bugs into one hides a bug.

Rules, in priority order:
1. Never invent a finding. Every id you emit must appear in the input.
2. Never merge findings that describe different defects, different mechanisms, or
   different fixes.
3. A canonical title/body may only restate what the merged findings already say. Do not
   add analysis, severity changes, or new claims.
4. If you are unsure about every pair, return `{"merges":[],"canonical":{}}`. That is a
   correct and expected answer.

## Findings

{{FINDINGS}}

## Output

Write strict JSON to `{{FINDINGS_PATH}}` with your write tool, and reply with the same
JSON and nothing else — no prose, no code fence, no explanation. The file is read first;
the reply is the fallback:

{
  "merges": [["f1", "f2"]],
  "canonical": {
    "f1": {
      "title": "noun phrase, <= 8 words, no trailing period",
      "body": "1-3 sentences: the mechanism, the consequence, the fix"
    }
  }
}

`merges` is a list of groups; every id in a group refers to the same defect. Use the first
id of each group as its key in `canonical`. Ids that belong to no group are left alone —
do not list them. `canonical` may be empty when `merges` is empty.
