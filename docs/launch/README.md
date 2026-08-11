# Post-proof launch playbook

Status: **NO-GO**. This playbook is prepared, but submissions must not begin while the
representative benchmark (#42) and retained lighthouse program (#44) are incomplete.

The launch is an evidence release, not another generic “AI code review” announcement. A
maintainer changes this status only in a dated go/no-go record after every gate below passes.
Channel rules must be rechecked on the day of submission; links here were checked 2026-08-11.

## Go/no-go gate

| Gate | Required evidence | Current state |
|---|---|---|
| Onboarding | #40 workflow is shipped; the lighthouse cohort records setup completion, time-to-first successful two-family review, and every failed setup with no unresolved P0/P1 onboarding defect | Awaiting #44 cohort evidence |
| Representative quality | #42 publishes the frozen 20–30 PR adjudicated corpus, reviewer/model versions, P0–P2 recall, precision, duplicates, latency, and complete/partial cost coverage against a precommitted comparison gate | Blocked on #42 |
| Public proof | At least three consented/public reviews cover materially different stacks and link the reviewed commit, visible Juror output, adjudicated outcome, limitations, and cost receipt | Awaiting public examples/lighthouse permission |
| Security | `SECURITY.md`, threat model, immutable Action pins, release provenance/SBOM, private reporting, and a current secret-isolation test are public; no unresolved credential/sandbox P0/P1 | Shipped; recheck at go/no-go |
| Retention | #44 completes the week-0/week-4 window and reports retained repositories, denominator, recruited-cohort caveat, and reasons for churn under the #49 metric definitions | Blocked on #44 |
| Positioning | The article and every channel draft lead with reproducible evidence, BYOK/local execution, receipts, and named limitations—not “free Greptile” parity claims | Drafted; final numbers blocked |
| Operations | One launch owner and one incident owner can monitor replies, onboarding failures, provider/model availability, and security reports for 48 hours | Unassigned |

Go/no-go record:

```text
Decision date:
Launch owner:
Incident owner:
Benchmark evidence URL/commit:
Public examples:
Onboarding baseline/report:
Week-4 retention report:
Security/release version:
Decision: GO / NO-GO
Unresolved risks and accepted limitations:
```

Any missing field is a no-go. Pause an active campaign for a credential exposure, sandbox
escape, broken install on the supported runner, corrected benchmark result that invalidates the
lead claim, or widespread provider/model unavailability. Post the correction where the original
claim appeared; do not silently edit only the repository copy.

## Campaign sequence

1. Freeze one release and evidence commit. Re-run install, seed/expanded benchmark, public
   examples, provenance verification, and the compatibility check from that commit.
2. Replace every bracketed placeholder in [`article-draft.md`](article-draft.md). A second
   person verifies every number and follows every reproduction command.
3. Refresh Marketplace metadata and screenshots from the same release. GitHub requires a
   public repository, one root Action metadata file, a unique Action name, a release, accepted
   Marketplace terms, and 2FA; follow the current
   [official publishing guide](https://docs.github.com/en/actions/how-tos/create-and-publish-actions/publish-in-github-marketplace).
4. Submit to one community at a time. Disclose maintainer affiliation, answer questions, log
   the URL/result, and adapt based on feedback before the next channel. Never coordinate votes.
5. Submit only to directories whose scope and contribution rules clearly fit. A rejected or
   ambiguous fit is recorded, not routed around through another account.
6. Freeze the campaign log at day 7 and publish the retrospective after the week-4 return
   window, even when reach or activation is zero.

## Channel-specific drafts and rules

All copy links directly to runnable/reproducible material. Do not paste the same paragraph into
multiple communities.

### Hacker News

Title:

> Show HN: Juror – multi-model pull-request review with per-review cost receipts

First comment outline:

> I built Juror because running several review agents produced duplicate comments and no
> trustworthy bill. It runs [N] model families in isolated checkouts, collapses only findings
> about the same mechanism, and labels provider-reported vs estimated cost. The expanded
> adjudicated corpus is reproducible here: [commit/link]. Results: [P0–P2 recall], [precision],
> [duplicate rate], [cost]. The important limitations are [three limitations]. The quickest
> trial is [one command]. I’ll be here to answer implementation and benchmark questions.

Use Show HN only for the runnable project, not the article alone. The official
[Show HN guidelines](https://news.ycombinator.com/showhn.html) require something users can try,
easy access without signup barriers, personal involvement by the submitter, and no requests for
upvotes/comments. A minor release is not a reason to repost; the completed proof milestone is.

### Reddit

Candidate communities must be selected on launch day from genuine maintainer participation,
then their current rules checked or moderators asked before posting. Start with a text post:

> **I maintain Juror, an open-source/BYOK multi-model PR reviewer. We just finished a [size]-PR
> adjudicated comparison and a four-week lighthouse cohort.**
>
> What changed since the earlier launch: [evidence/onboarding/security milestones]. The full
> corpus and reproduction command are [link]. Results are [metrics], with [limitations]. I’m
> sharing this here because [community-specific reason/question], and I’d value feedback on
> [specific technical tradeoff].

Reddit's [spam policy](https://support.reddithelp.com/hc/en-us/articles/360043504051-Spam)
prohibits repeated/unsolicited mass posting and tells self-interested posters to be thoughtful
about frequency and follow each community's rules. One tailored post is not permission to
cross-post it everywhere. No automated posts, unsolicited DMs, or vote requests.

### X

Use a short technical thread, not launch adjectives:

1. “We measured Juror on [corpus]: [recall/precision/cost], with the complete cases public.”
2. One diagram explaining independent model families → lossless deduplication → receipt.
3. One public review with confirmed/dismissed outcomes.
4. Security/BYOK boundary and three limitations.
5. Reproduction/install link and a request for technical feedback, not reposts.

### LinkedIn

Write for engineering leads: describe the evaluation design, setup time and week-4 cohort, cost
coverage, and decision boundary. Disclose that the author maintains Juror. Avoid unsupported
productivity percentages, competitor disparagement, and screenshots without source links.

### GitHub Community and maintainer communities

Use Juror's own GitHub Discussion for the canonical announcement and feedback thread. Post in
another project/community only where its rules invite tools or project showcases and Juror
solves a stated problem there. GitHub describes Discussions as a place for project-specific
announcements and conversation; follow the host's categories and
[Community Code of Conduct](https://docs.github.com/en/site-policy/github-terms/github-community-code-of-conduct).

Maintainer outreach is individual and opt-in: contact lighthouse participants and maintainers
who previously asked for the result. Do not scrape addresses, mass-DM repository owners, or ask
participants to manufacture engagement.

## Marketplace and directory queue

| Destination | Fit/evidence to submit | Rule check | Status |
|---|---|---|---|
| GitHub Marketplace | Root `action.yml`, immutable release, README quickstart, security/provenance, screenshots from public examples | Official publishing guide above; organization owner must accept terms and use 2FA | Blocked until go gate/release |
| analysis-tools.dev curated list | Open-source code-quality tool; submit only if maintainers confirm AI review fits its static-analysis scope | Read repository contribution files immediately before PR; one factual entry | Candidate—fit confirmation required |
| Open-source alternative directories | Repository/license, BYOK/local boundary, exact category, current evidence link | Use each directory's normal submission form once; no reciprocal-link or paid-ranking claims | Candidate—select at launch |
| Curated AI coding/tool awesome lists | Only lists with active maintenance and an explicit code-review/tool category | Follow alphabetical/description/commit rules exactly; do not open duplicate PRs across forks | Candidate—select at launch |
| Self-hosted directories | Juror is a CLI/Action, not a hosted network service | Do not submit unless the directory explicitly accepts developer CLIs/Actions | Presumed out of scope |

For each attempt, record destination, rule URL/date, proposed category, submission URL, status,
maintainer feedback, and the substantive evidence used. “Relevant” is a maintained scope match,
not merely a directory that accepts pull requests.

## Privacy-preserving attribution

Use one closed campaign code per channel: `documentation`, `github_marketplace`,
`public_pr_comment`, `research_post`, `launch_hacker_news`, `launch_reddit`, or `launch_other`.
These are the source values already defined in [`docs/metrics.md`](../metrics.md).

- Channel links may include `utm_campaign=post-proof-<release>` and the closed source code.
  Do not put repository/user identifiers in parameters.
- Prefer aggregate native channel clicks and GitHub traffic referrers. Do not add a redirector,
  cookie, pixel, fingerprint, or IP log solely for the campaign.
- Setup source is self-reported/explicitly opted in; never join a visitor to a repository by
  owner/name, URL, pull request, IP, or credential.
- Use [`campaign-template.csv`](campaign-template.csv) for manual aggregation. `unknown` is not
  zero, and small source cohorts are not published separately.

## Retrospective

Create the retrospective from [`retrospective-template.md`](retrospective-template.md) on day
35, when week-4 retention can be computed. Publish it even if submissions were removed, visits
were low, no repository retained, or the lead claim needed correction. Link it from #50 and the
canonical launch Discussion.
