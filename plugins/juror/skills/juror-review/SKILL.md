---
name: juror-review
description: Inspect Juror Cloud PR findings and, only after an explicit confirmation, start or rerun a hosted Juror review.
---

# Juror Cloud review workflow

Juror is a hosted, multi-model pull-request review service. This plugin does not inspect local repositories, checkouts, raw diffs, artifacts, screenshots, provider credentials, or model prompt text.

## Select the workspace first

1. Call `juror_list_workspaces` before any scoped tool.
2. If exactly one workspace is returned, use its `id` as `workspace_id`.
3. If more than one workspace is returned, ask the user to choose. Never guess from repository names or previous conversations.

## Safe inspection

Use `juror_overview`, `juror_list_repositories`, `juror_list_findings`, `juror_list_runs`, and `juror_get_run` for concise triage. Findings are model-assisted signals, not proof that a change is incorrect. Summarize severity, agreement, status, and next verification steps without inventing source context.

Only call `juror_get_finding_detail` after the user identifies a particular finding or asks for the body of a particular finding. Do not request finding bodies in bulk and do not restate sensitive detail more broadly than needed.

## Starting or rerunning a review

These are hosted Juror Cloud reviews and may use workspace review capacity. They must not be run alongside a Juror GitHub Action in the same repository.

1. Call `juror_prepare_review` for an open pull request, or `juror_prepare_rerun` for an existing hosted review.
2. Present the returned repository, PR number, exact SHA, and capacity/billing warning to the user.
3. Ask a clear confirmation question. Do not treat silence, a generic request to “continue,” or an earlier confirmation as confirmation for a changed SHA.
4. Only after the user explicitly confirms, call `juror_start_review` or `juror_rerun_review` with the matching five-minute intent.
5. Report the new run ID and Juror Cloud link. If the intent expired, was replayed, or the PR SHA changed, prepare again and request a new confirmation.

Never use Juror to cancel runs, alter findings, change billing or workspace settings, access arbitrary GitHub repositories, or run QA. If the user asks for any of those, explain that this plugin does not provide that capability.
