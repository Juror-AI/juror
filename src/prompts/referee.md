You are deduplicating code-review findings. Several models reviewed the same pull request
independently and landed on nearby lines. Decide which of these findings describe **the
same defect** and, for each group you merge, write the one title and body that should be
posted in their place.

Two findings are the same defect when they identify the same faulty mechanism and the
same independently actionable fix, with substantially overlapping trigger and consequence.
One report may name only a subset of the affected entry points or observable effects; that
does not make it a separate bug when fixing the shared mechanism necessarily fixes both.
Same file, adjacent lines, shared symbols, a related symptom, or a shared high-level root
cause is not enough — a retry state machine and a callback that discards its promise are
two findings even when both break the same autosave flow. When unsure, leave them apart:
posting two related comments is a small cost, merging two different bugs hides one.

Anchor lines do not have to match. One model may point at an effect and another at its
catch or caller even though they describe the same trigger and mechanism. Judge the four
claim dimensions, not line equality.

Do not read any files for this task. In particular, never inspect user or global tool
configuration, credentials, home-directory files, or paths outside the repository.

Rules, in priority order:
1. Never invent a finding. Every id you emit must appear in the input.
2. Merge only if trigger, mechanism, consequence, and fix all match. Set the four
   `same_*` fields to true only after checking each dimension independently.
3. A canonical title/body may only restate what the merged findings already say. Do not
   add analysis, severity changes, or new claims.
4. Every candidate id must appear exactly once: either in one merge group or in
   `distinct`. The answer is rejected if an id is missing, repeated, or invented.
5. If you are unsure about every pair, put every id in `distinct`. That is a correct and
   expected answer.

## Findings

{{FINDINGS}}

## Output

Reply with strict JSON and nothing else — no prose, no code fence, no explanation. If a
write tool is available, also write the same JSON to `{{FINDINGS_PATH}}`; the reply is
always required because read-only review harnesses intentionally disable writes:

{
  "merges": [{
    "ids": ["f1", "f2"],
    "same_trigger": true,
    "same_mechanism": true,
    "same_consequence": true,
    "same_fix": true,
    "canonical": {
      "title": "noun phrase, <= 8 words, no trailing period",
      "body": "1-3 sentences: the mechanism, the consequence, the fix"
    }
  }],
  "distinct": ["f3"]
}

`merges` is a list of duplicate groups. `distinct` contains every candidate that belongs
to no group. If `merges` is empty, `distinct` must contain every candidate id.
