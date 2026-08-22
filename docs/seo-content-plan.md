# Juror website, SEO, and localized content plan

Status: route manifest and technical templates implemented; native localization and editorial approvals remain pending.
Research date: 2026-08-22
Scope: Juror’s public marketing site, docs, resource center, comparison library, and localized routes.

## 1. Decision summary

Juror should own the category **multi-model AI code review for GitHub pull requests**. Its credible differentiation is not a generic claim that it is “better AI”; it is a concrete workflow:

> **Several frontier reviewers. One clear pull-request decision.**

Juror runs several models in parallel, conservatively collapses duplicate findings, exposes agreement and merge confidence, and shows the actual cost of the review. It is installed as a GitHub Action and can optionally conduct sealed post-merge browser QA. These are documented product capabilities, not aspirational marketing claims. See [the repository README](../README.md), [the benchmark corpus](../benchmarks/platform-10359.json), and [benchmark methodology](benchmarking.md).

The site should use a Vercel-like *visual grammar*—quiet, technical, sparse, grid-based, high-density product proof—but must not reproduce Vercel artwork, illustrations, UI, wording, or distinctive page compositions. “Vercel-like” here means restrained and fast, not copied.

### The first-page proposition

| Element | Final direction |
| --- | --- |
| Category label | `MULTI-MODEL CODE REVIEW` |
| H1 | `The AI code review jury for GitHub pull requests.` |
| Supporting copy | `Run frontier models in parallel. Juror merges duplicate findings into one review, shows the confidence behind it, and gives you the bill.` |
| Primary CTA | `Add Juror to GitHub` → GitHub Marketplace / generated install flow |
| Secondary CTA | `See a real review` → `/en/benchmarks` (or the localized equivalent) |
| Proof strip | `GitHub Action` · `Read-only review agents` · `Deduplicated findings` · `Cost receipt` |
| Required disclaimer | Benchmark cards name the corpus, sample size, date, model/preset, definitions of recall and precision, and a link to raw evidence. Never turn the current one-PR seed into a universal performance claim. |

### Positioning guardrails

1. Do not say “the best,” “catches every bug,” “zero false positives,” “secure,” “enterprise-ready,” or quote percentage ROI without public, reproducible evidence.
2. Do not promise GitLab, Bitbucket, self-hosting, SSO, IDE support, automatic fixes, or an API. They are not present in Juror’s current product scope.
3. Do say “GitHub Action,” “frontier models in parallel,” “duplicate-collapse,” “optional consensus filtering,” “merge confidence,” “cost receipt,” and “optional post-merge browser QA” only where the release being promoted supports them.
4. Competitor pages use nominative fair use: explain the decision, identify the reviewed version/date, cite primary sources, include a “when to choose them” section, and never imply affiliation or use their logos without permission.
5. Every numerical claim needs an evidence owner, source URL/file, calculation, observation date, and review date in the CMS. If this record is missing, omit the number.

## 2. Market and competitor sitemap map

The inventory below is a crawl of each competitor’s public XML sitemap on 2026-08-22. Counts are sitemap URLs, not an estimate of indexed pages or traffic. They establish content strategy and IA patterns; they are **not** instructions to duplicate copy, code, or thin programmatic pages.

| Competitor | Sitemap finding | What it is doing | Juror response |
| --- | ---: | --- | --- |
| Greptile | 95 marketing/content pages + 473 `/grepository/` pages + 48 docs = **616** | Strong category page, proof/examples, comparisons, customer stories, benchmark, large repo/topic programmatic hub | Win on transparent, multi-model review and first-party benchmark evidence. Build an evidence hub, not a 473-page superficial repository directory. |
| CodeRabbit | **515** URLs: 154 blog, 32 guides, 23 case studies, 26 newsroom, 229 Japanese routes | Broad “agentic change management” narrative, substantial customer proof, guide library, full Japanese mirror | Match its localization discipline and guide depth; differentiate with a narrower GitHub Action / multi-model jury story. |
| Qodo | Sitemap index has 18 child maps totaling **1,213** URLs: 388 blog, 139 glossary, 131 questions, 108 developer-hub, 106 resources, 89 pages, 51 tips, and taxonomy/media routes | Captures definitions and question intent at scale; combines quality governance, rules, and codebase context | Build smaller, expert-authored definition/checklist/template clusters. Do not launch hundreds of generic FAQ pages. |
| Bito | **362** URLs: 55 pages, 25 AI-tools pages, 10 case studies, 272 blog | Product suites plus a direct comparison matrix (15 comparison routes) and AI-tool content | Publish genuinely useful alternatives/comparison pages only after a documented feature and evidence review. |
| CodeAnt | **6,417** URLs: 5,816 vulnerability database, 457 blog, 19 comparison, 11 AI-review feature pages | Uses an enormous security-vulnerability index to own security long-tail and feature subpages for product intent | Do not compete as a vulnerability database. Juror should target review workflow and AI-generated-code validation intent, then link to specialist security tooling where appropriate. |
| Cursor Bugbot | **189** URLs: 121 blog, 16 workflows, 5 guides | Minimal, product-demo-led page; positioned around catching real bugs with low noise and custom rules | Use a high-fidelity interactive review demo and evidence cards. Emphasize independent, cross-model review rather than editor affinity. |
| Ellipsis | **140** URLs: 82 docs, 14 agent templates, 10 blog, 9 platform, 7 use-case, 6 integration, 3 comparison | A configurable agent-cloud platform that treats code review as one use case, with unusually deep task documentation | Keep Juror’s docs as an SEO and activation surface. Its unique action-level configuration deserves search-first task pages, without inflating into agent-platform claims. |
| Korbit, PullFlow, Sourcery | No usable public XML sitemap was returned at the checked root sitemap paths; their accessible product/docs pages were still reviewed manually | These adjacent competitors expand the buyer’s consideration set: review bots, human-and-AI collaboration, and AI review plus security/IDE platforms | Include them in the market narrative and future comparison backlog; do not claim a sitemap count without a crawlable sitemap. |
| GitHub Copilot Code Review | Product content is in GitHub docs, not a comparable standalone marketing sitemap | Owns native GitHub-distribution queries and “request Copilot review” how-tos | Make the comparison about multi-model review, cost visibility, configuration, and marketplace setup—not an unsupported quality contest. |
| Graphite | `graphite.com/sitemap.xml` currently points to a staging Vercel sitemap; no reliable public page inventory was used | Not reliable for sitemap analysis on this crawl date | Monitor quarterly; do not infer its IA from this response. |

### Complete sitemap endpoint inventory

This table maps every public XML sitemap endpoint discovered from the primary sitemap indexes during the research crawl. “URLs” is the exact count returned by that endpoint on 2026-08-22; category/tag/author maps count separately because they are public URLs even though they should generally be `noindex` on a new Juror site unless they carry unique editorial value.

| Site | XML sitemap endpoint | URLs | Dominant path families / SEO lesson |
| --- | --- | ---: | --- |
| Greptile | [`sitemap-pages.xml`](https://www.greptile.com/sitemap-pages.xml) | 95 | Blog 30, careers 17, content library 12, customers 5; commercial, proof, and resource mix. |
| Greptile | [`sitemap-grepository.xml`](https://www.greptile.com/sitemap-grepository.xml) | 473 | All `/grepository/`; evidence that a proprietary repository/topic directory is its programmatic expansion layer. |
| Greptile | [`docs/sitemap.xml`](https://www.greptile.com/docs/sitemap.xml) | 48 | All `/docs/`; task documentation is a separate acquisition surface. |
| Qodo | [`post-sitemap.xml`](https://www.qodo.ai/post-sitemap.xml) | 388 | `/blog/`; editorial scale. |
| Qodo | [`page-sitemap.xml`](https://www.qodo.ai/page-sitemap.xml) | 89 | Webinars 12, solutions 5, products 4, reports/partners; commercial and campaign pages. |
| Qodo | [`case-study-sitemap.xml`](https://www.qodo.ai/case-study-sitemap.xml) | 8 | `/case-study/`; relatively small proof library. |
| Qodo | [`glossary-sitemap.xml`](https://www.qodo.ai/glossary-sitemap.xml) | 139 | `/glossary/`; definition-intent capture. |
| Qodo | [`resource-sitemap.xml`](https://www.qodo.ai/resource-sitemap.xml) | 106 | `/resources/`; older evergreen product education. |
| Qodo | [`tip-sitemap.xml`](https://www.qodo.ai/tip-sitemap.xml) | 51 | `/tip/`; short-form advice. |
| Qodo | [`hub-sitemap.xml`](https://www.qodo.ai/hub-sitemap.xml) | 108 | `/developers-hub/`; problem/solution directory. |
| Qodo | [`question-sitemap.xml`](https://www.qodo.ai/question-sitemap.xml) | 131 | `/question/`; exact question-intent pages. |
| Qodo | [`learn-sitemap.xml`](https://www.qodo.ai/learn-sitemap.xml) | 11 | `/learn/` plus blog; learning hub. |
| Qodo | [`podcast-sitemap.xml`](https://www.qodo.ai/podcast-sitemap.xml) | 9 | `/podcasts/`; media. |
| Qodo | [`academy_chapter-sitemap.xml`](https://www.qodo.ai/academy_chapter-sitemap.xml) | 11 | `/academy/`; educational course content. |
| Qodo | [`category-sitemap.xml`](https://www.qodo.ai/category-sitemap.xml) | 11 | Blog categories; taxonomy. |
| Qodo | [`post_tag-sitemap.xml`](https://www.qodo.ai/post_tag-sitemap.xml) | 107 | Blog tags; taxonomy at significant scale. |
| Qodo | [`case-study-category-sitemap.xml`](https://www.qodo.ai/case-study-category-sitemap.xml) | 5 | Case-study taxonomy. |
| Qodo | [`resources_category-sitemap.xml`](https://www.qodo.ai/resources_category-sitemap.xml) | 4 | Resource taxonomy. |
| Qodo | [`tips_category-sitemap.xml`](https://www.qodo.ai/tips_category-sitemap.xml) | 6 | Tip taxonomy. |
| Qodo | [`related_reads_category-sitemap.xml`](https://www.qodo.ai/related_reads_category-sitemap.xml) | 1 | Blog taxonomy. |
| Qodo | [`author-sitemap.xml`](https://www.qodo.ai/author-sitemap.xml) | 28 | `/authors/`; author attribution pages. |
| Bito | [`page-sitemap.xml`](https://bito.ai/page-sitemap.xml) | 55 | Compare 15, product 6, benchmarks 2; direct commercial pages. |
| Bito | [`ai-tools-sitemap.xml`](https://bito.ai/ai-tools-sitemap.xml) | 25 | `/ai-tools/`; adjacent-tool comparison content. |
| Bito | [`blog-sitemap.xml`](https://bito.ai/blog-sitemap.xml) | 272 | `/blog/`; editorial library. |
| Bito | [`case-studies-sitemap.xml`](https://bito.ai/case-studies-sitemap.xml) | 10 | `/case-studies/`; proof. |
| CodeRabbit | [`sitemap.xml`](https://www.coderabbit.ai/sitemap.xml) | 515 | Japanese 229, blog 154, guides 32, newsroom 26, case studies 23; localization and editorial depth are core strategy. |
| CodeAnt | [`sitemap.xml`](https://www.codeant.ai/sitemap.xml) | 6,417 | Vulnerability DB 5,816, blogs 457, developer-360 22, comparisons 19; a broad security/database strategy, outside Juror’s core product scope. |
| Cursor | [`sitemap.xml`](https://www.cursor.com/sitemap.xml) | 189 | Blog 121, workflows 16, guides 5; product-led storytelling with workflows. |
| Ellipsis | [`sitemap.xml`](https://www.ellipsis.dev/sitemap.xml) | 140 | Docs 82, agents 14, blog 10, platform 9, use cases 7, integrations 6, comparisons 3; docs depth supports activation. |
| PullFlow | [`sitemap.xml`](https://www.pullflow.com/sitemap.xml) | 0 | No public URL entries returned in this crawl. Use human page review, not sitemap count. |
| Korbit | [`sitemap.xml`](https://www.korbit.ai/sitemap.xml) | 0 | No public URL entries returned in this crawl. Use human page review, not sitemap count. |
| Sourcery | [`sitemap.xml`](https://sourcery.ai/sitemap.xml) | 0 | No public URL entries returned in this crawl. Its docs still expose a useful index via `llms.txt`; do not treat that as a substitute for a sitemap. |

**Juror policy:** do not expose category, tag, author, site-search, filter, or pagination routes in a sitemap unless they contain original, maintained editorial content and have a distinct search purpose. Qodo’s taxonomy volume is an observation, not a target.

### What the leading pages say, and what to learn—not copy

| Product | Observed message/structure | Reusable mechanism for Juror |
| --- | --- | --- |
| Greptile | Product category first; logos; a three-step “index → agents → learning” explanation; real bug cards; personalization; integrations; runtime test offer; security; testimonials; FAQ. It also publishes `/greptile-vs-coderabbit`, `/greptile-vs-bugbot`, `/benchmarks`, `/examples`, and `/what-is-ai-code-review`. | Lead with one job and a visually inspectable review. Put the actual mechanism and raw evidence above vague feature claims. Add comparison, benchmark, examples, and educational pillars. Juror’s equivalent mechanism is “fan out → anchor/deduplicate/referee → confidence and receipt.” |
| CodeRabbit | Frames the problem as AI code outpacing human review, then broadens to review, prioritization, understanding, and security. Its sitemap gives guides and localized pages real weight. | Use the “AI code volume created a validation bottleneck” problem, but keep Juror’s product promise focused. Allocate a real editorial cadence and localized editorial ownership. |
| Qodo | Leads with governance at AI speed, then cross-repo context, focused findings, visibility, and living rules. Its long-tail library includes definitions and questions. | Address standards, auditability, and review policy for teams, but do not represent unsupported centralized governance features as product functionality. Provide templates that users can run in their own repository. |
| Bito | Leads with whole-system context, a large availability statement, outcomes, then practical review components (summary, inline suggestions, analysis, chat). | Make the visible artifact—the final GitHub review—central. Juror’s differentiator is a unified review from several independent reviewers, with costs exposed. |
| Cursor Bugbot | Leads with a realistic PR comment demo, then automatic pre-merge check, custom standards, and “high signal, low noise.” | Build an interactive, accessible PR review proof component. Show duplicate reports being combined and a disagreement being visible rather than hand-wave about quality. |
| Ellipsis | Organizes its public site around an agent platform, then gives code review a dedicated use case, comparisons, templates, and an 82-page documentation corpus. | Publish task-completion docs, templates, and configuration examples as first-class content. Keep the product category tightly bounded to Juror’s released GitHub Action. |

### Sitemap patterns worth adopting

1. **One commercial page per high-intent job.** Greptile’s `/agent`, `/cli`, `/enterprise`, `/trex`, and comparisons each have one purpose.
2. **Proof that is linkable.** Benchmark methodology, reproducible examples, changelog, and customer evidence earn links more reliably than feature prose.
3. **Editorial hubs, not orphan posts.** Every guide needs a parent cluster and two contextual next links.
4. **Real localization.** CodeRabbit has 229 Japanese URLs. Juror must translate the actual page and metadata, not ship English copy under a localized URL.
5. **Programmatic SEO only with unique data.** A Greptile-like project directory or CodeAnt-like database is warranted only when Juror has a maintained, permissioned dataset plus unique analysis. Until then, do not manufacture it.

## 3. Search demand and keyword strategy

This is a complete **intent and SERP-coverage analysis**, not a fabricated traffic-volume report. Exact monthly volume, difficulty, CPC, and country splits must be exported from the team’s Ahrefs/Semrush/Google Keyword Planner account before publication. The measurement columns and ownership are pre-created in [seo-keyword-backlog.csv](seo-keyword-backlog.csv); do not use third-party estimates in copy. Priority below is based on buying intent, semantic fit, competitor coverage, and Juror’s ability to answer the query credibly.

### Keyword clusters and canonical ownership

| Priority | Search intent and keyword family | One canonical owner | Required answer / conversion |
| --- | --- | --- | --- |
| P0 | `ai code review`, `AI code reviewer`, `AI code review tool`, `automated code review` | `/en/ai-code-review` | Define the category, show a real review, explain the multi-model jury, link to install and benchmark. |
| P0 | `GitHub AI code review`, `GitHub Action code review`, `AI code review GitHub Actions`, `pull request review bot GitHub` | `/en/github-ai-code-review` | Give a working SHA-pinned workflow, permissions, fork-safety caveat, expected output, and setup CTA. |
| P0 | `review AI generated code`, `AI agent code review`, `code review for Claude Code`, `code review for Codex`, `vibe code review` | `/en/solutions/review-ai-generated-code` | Explain why generated-code volume changes review; show review policy/template; make no claims about vendor integration that is not supported. |
| P0 | `Greptile alternative`, `CodeRabbit alternative`, `Qodo alternative`, `Cursor Bugbot alternative` | One route per named competitor in the `/en/compare` hub | Date-stamped side-by-side decision, Juror workflow, fair “choose them if” section, source citations, FAQ. |
| P1 | `multi model code review`, `multiple LLM code review`, `LLM ensemble code review`, `consensus code review` | `/en/multi-model-code-review` and `/en/consensus-code-review` | Explain independent reviews, dedupe, agreement, high-recall versus consensus modes, and trade-offs. |
| P1 | `code review cost`, `AI code review pricing`, `LLM code review cost`, `code review ROI` | `/en/transparent-ai-code-review-costs` | Show the receipt, provider-cost variables, budget controls, and calculator/template. Avoid universal saving claims. |
| P1 | `pull request review checklist`, `code review checklist`, `code review best practices`, `PR review checklist` | `/en/resources/code-review-checklist` | A downloadable/copyable checklist with security, behavior, tests, observability, and rollout sections. |
| P1 | `AI code review benchmark`, `code review benchmark`, `Greptile benchmark`, `AI reviewer evaluation` | `/en/benchmarks` | Methodology, corpus, metrics, limitations, raw artifacts, reproduce command, release notes. |
| P1 | `post merge testing`, `post deployment QA`, `AI browser QA`, `synthetic user journey testing` | `/en/post-merge-qa` | Clearly explain Juror’s optional capability, sealed observations, synthetic account constraints, and setup prerequisites. |
| P2 | `code review bot`, `automated pull request review`, `PR review automation`, `code review workflow` | `/en/resources/automated-pull-request-review` | How-to guide; link to GitHub setup and configuration docs. |
| P2 | `static analysis vs AI code review`, `AI code review vs human review`, `code review vs testing`, `SAST vs code review` | `/en/resources/static-analysis-vs-ai-code-review` and sibling pages | Honest boundary-setting comparison; link to linters/test suites rather than claim replacement. |
| P2 | `TypeScript code review checklist`, `Python code review checklist`, `Go code review checklist`, `Java code review checklist` | `/en/resources/{language}-code-review-checklist` | Language-specific examples and tools, not merely translated generic copy. |
| P2 | `GitHub Actions PR template`, `pull request template`, `CODEOWNERS template`, `code review policy template` | `/en/templates/…` | Copyable, versioned repository files and explanations. |

### Cannibalization rules

- `/ai-code-review` owns the category phrase. Feature pages may use it naturally but their title, H1, URL, and anchor text must target their narrower concept.
- `/github-ai-code-review` owns GitHub-install intent; `/docs/getting-started` owns task-completion intent. The former sells and demonstrates; the latter is terse, procedural documentation.
- Comparison pages own `[competitor] alternative` and `[competitor] vs Juror`; no blog post competes for these queries.
- The benchmark page owns performance claims. Feature and comparison pages link to it rather than repeat isolated percentages.
- “AI code review” content is human-reviewable thought leadership. Do not create hundreds of pages that only swap language, framework, competitor, or adjective.

### Search-result targets

| Page type | Title formula | Description formula | Rich-result/schema target |
| --- | --- | --- | --- |
| Category | `AI Code Review for GitHub Pull Requests | Juror` | `Run several frontier models on every GitHub pull request. Juror unifies duplicate findings, shows confidence, and displays review cost.` | `SoftwareApplication`, `FAQPage` only for visible, non-duplicated FAQs |
| Integration | `GitHub AI Code Review with a GitHub Action | Juror` | `Add multi-model AI review to pull requests with a SHA-pinned GitHub Action and a clear cost receipt.` | `HowTo` only when the page visibly contains the steps; `SoftwareApplication` |
| Feature | `{Feature}: Multi-Model PR Review | Juror` | `{One user outcome}. See the exact review behavior, controls, and limitations.` | `SoftwareApplication` |
| Comparison | `Juror vs {Competitor}: AI Code Review Compared` | `A date-stamped comparison of workflow, setup, model approach, evidence, and pricing model. See when each fits.` | `Article`, `FAQPage` if eligible; never `Review` schema for Juror’s self-review |
| Guide | `{Question} | Juror Resources` | `A practical answer with examples, checklists, and links to the implementation workflow.` | `Article`, `BreadcrumbList` |
| Template | `{Template name} | Juror` | `Copy a versioned {file/template} and learn when to use each section.` | `Article`, `BreadcrumbList` |

## 4. Information architecture and full route inventory

### Route model

There are **91 logical public pages** in the launch architecture. Each is released in six full locales (`en`, `de`, `fr`, `es`, `ja`, `pt-BR`) for **546 public localized URLs**, plus localized `sitemap.xml` entries and locale indexes. The English source is not a privileged, unlocalized route: every page has locale metadata and a locale-specific URL.

The table shows the English logical route. Section 5 defines its locale transformation, and the complete route-by-route preliminary localization registry is in [seo-route-manifest.csv](seo-route-manifest.csv). `Docs` pages preserve code/API identifiers within localized explanatory prose.

#### A. Core, conversion, trust, and company (19 pages)

| Route | Primary intent | H1 / page promise | Content needed | Primary CTA |
| --- | --- | --- | --- | --- |
| `/en` | Brand/category | `The AI code review jury for GitHub pull requests.` | Full landing specification in section 6. | Add Juror to GitHub |
| `/en/ai-code-review` | Category | `AI code review that shows its work.` | Definition, demo, Juror process, role of humans/linters/tests, FAQ, benchmark link. | Install on GitHub |
| `/en/product` | Product evaluation | `One pull request. Several reviewers. One decision.` | Product tour: fan-out, finding lifecycle, score, receipt, configuration; screenshots. | View setup |
| `/en/how-it-works` | Mechanism | `How Juror turns many model reviews into one useful review.` | Five merge stages, consensus verifier, data flow, limitations, glossary links. | Read configuration |
| `/en/github-ai-code-review` | Integration purchase | `Multi-model AI code review, installed as a GitHub Action.` | Copyable YAML, permissions, secure fork policy, before/after PR visual, install time. | Add action |
| `/en/multi-model-code-review` | Feature/category | `More than one model. Less repeated feedback.` | Why independent perspectives matter, dedupe, models/presets, measurement plan, trade-offs. | Choose a preset |
| `/en/consensus-code-review` | Feature/category | `Use agreement as a precision control.` | High recall vs consensus mode, refutation stage, severity behavior, configuration snippet. | Configure consensus |
| `/en/transparent-ai-code-review-costs` | Pricing/cost | `See what every review costs.` | Example receipt, cost drivers, `cost-target-usd`, calculator/template, FAQ. | Run a review |
| `/en/post-merge-qa` | Capability | `Validate the live journey after the merge.` | What it tests, sealed-evidence model, synthetic-account needs, preconditions, demo/checklist. | Read QA quickstart |
| `/en/benchmarks` | Evidence | `Measure reviewers on real pull requests.` | Methodology, corpus, definitions, results table, limitations, reproduction, changelog. | Inspect the corpus |
| `/en/examples` | Product proof | `Read the review before you install it.` | 6 anonymized/reproducible PR examples: a bug found, duplicates collapsed, disagreement, consensus suppression, cost receipt, no-findings result. | Install Juror |
| `/en/pricing` | Purchase | `Pay the model providers. See the receipt.` | Current product economics only, setup requirements, budget guardrails, open-source route, pricing FAQ. No invented plan tiers. | Get started |
| `/en/security` | Trust | `Designed for a review workflow with clear boundaries.` | Actual data flow, read-only checkout, fork protections, secrets handling, post-merge QA constraints; security-contact policy. | Read security notes |
| `/en/open-source` | Community | `Keep open-source pull requests moving.` | Eligibility, setup, community/help channel, contributor example; only promise a program after it exists. | Add to an OSS repo |
| `/en/changelog` | Trust/retention | `Every release, explained.` | Versioned release notes, migration notices, date and GitHub release link. | Subscribe / view GitHub |
| `/en/about` | Brand trust | `Why Juror exists.` | Founding problem, review principles, open-source/MIT facts, project links. | Read the docs |
| `/en/contact` | Sales/support | `Talk to the Juror team.` | Support vs security vs partnership routing, response expectations only if maintained. | Contact |
| `/en/legal/privacy` and `/en/legal/terms` | Compliance | `Privacy policy` / `Terms of service` | Counsel-approved text, effective date, language/version selector. | None |

#### B. Capability pages (8 pages)

| Route | Keyword / H1 | Required sections and proof |
| --- | --- | --- |
| `/en/features` | `Juror features for clearer pull-request decisions` | Feature index with a decision matrix, capability boundaries, seven feature cards, and links to product/demo/docs. |
| `/en/features/parallel-model-review` | `Parallel model review for pull requests` | Harnesses supported today, independent checkout pattern, timing/cost trade-off, real output. |
| `/en/features/deduplicated-findings` | `One bug should produce one finding.` | Anchor, block, exact-collapse, similarity/referee, coverage audit; diagram and a before/after finding set. |
| `/en/features/merge-confidence` | `A merge score with its reasoning attached.` | Score inputs, severity cap, model votes, what it does *not* decide, sample comment. |
| `/en/features/consensus-mode` | `Tune review for recall or agreement.` | Mode comparison, verifier/refutation workflow, recommended use cases, config. |
| `/en/features/cost-receipts` | `No mystery AI review bill.` | Cost-source labeling, reporting caveats, sample receipt, budgeting controls. |
| `/en/features/repository-context-without-indexing` | `Repository context without a standing index.` | Read/search tools, no prebuilt semantic index, staleness/cost trade-off, supported boundaries. |
| `/en/features/post-merge-browser-qa` | `A controlled post-merge browser QA loop.` | Deployment selection, private ledger/sealed evidence, synthetic session, no-reset mode, exact limitations. |

#### C. Solution pages (9 pages)

| Route | H1 | Unique content required |
| --- | --- | --- |
| `/en/solutions` | `Code-review workflows for the way your team ships.` | Solution index with audience/workflow selection, explicit capability boundaries, and links to all solution pages. |
| `/en/solutions/review-ai-generated-code` | `Review code generated at AI speed.` | Larger PR risk, review policy, generated-code checklist, linked benchmarks; no named-vendor feature claims. |
| `/en/solutions/github-actions-code-review` | `Add an AI review gate to GitHub Actions.` | Event flow, minimal workflow, SHA pinning, fork safety, CI relationship. |
| `/en/solutions/engineering-teams` | `Give engineering teams a shared first review.` | Roles, noisy-review avoidance, score interpretation, rollout plan. |
| `/en/solutions/platform-engineering` | `A configurable review layer for platform teams.` | Central workflow template, config review, model/provider policy, audit/cost artifacts. |
| `/en/solutions/open-source-maintainers` | `Spend maintainer time where it matters.` | Contributor PRs, safe workflow condition, triage, issue template. |
| `/en/solutions/startups` | `Ship quickly without guessing at review cost.` | Fast setup, budget controls, early-team review loop, transparent limitations. |
| `/en/solutions/monorepo-pull-requests` | `Review changes that reach beyond one file.` | Cross-file reasoning examples, changed-file scope, why tests and human reviewers still matter. |
| `/en/solutions/post-merge-quality` | `Close the loop after merge.` | Review plus optional QA, deployment evidence, synthetic testing rules, release checklist. |

#### D. Integration and ecosystem pages (6 pages)

| Route | H1 | Required content |
| --- | --- | --- |
| `/en/integrations` | `Use Juror in the GitHub review workflow.` | Integration index that distinguishes released integrations from model/provider configuration; link to task docs. |
| `/en/integrations/github` | `Juror for GitHub pull requests.` | Marketplace/action installation, trigger configuration, permissions, sample output, docs links. |
| `/en/integrations/github-actions` | `A GitHub Action for multi-model review.` | Full YAML, pinning, secrets, permissions, workflow troubleshooting. |
| `/en/integrations/codex` | `Use Codex in a Juror review preset.` | Exact currently supported harness/configuration, responsible model-version notes, no affiliation. |
| `/en/integrations/claude` | `Use Claude in a Juror review preset.` | Same pattern; capabilities only confirmed by released configuration. |
| `/en/integrations/openrouter` | `Configure a starter multi-model preset with OpenRouter.` | Exact provider requirements, key handling, cost/security caveats, supported models. |

#### E. Comparison and alternatives pages (11 pages)

All comparison pages use the same evidence-first format: update date and product version; target buyer; shared table with “confirmed / not offered / not evaluated” states; Juror workflow; competitor workflow sourced from primary docs; pricing model as-of date; setup; privacy/deployment facts; reproducible benchmark only where relevant; “choose {competitor} if”; “choose Juror if”; FAQ; sources. They must not use a scoring graphic unless every row has sourced, comparable data.

| Route | Query | H1 |
| --- | --- | --- |
| `/en/compare` | `AI code review tool comparisons` | `Compare AI code review approaches.` |
| `/en/compare/juror-vs-greptile` | `Juror vs Greptile`, `Greptile alternative` | `Juror vs Greptile: two approaches to AI code review.` |
| `/en/compare/juror-vs-coderabbit` | `Juror vs CodeRabbit`, `CodeRabbit alternative` | `Juror vs CodeRabbit: review workflow, context, and evidence.` |
| `/en/compare/juror-vs-qodo` | `Juror vs Qodo`, `Qodo alternative` | `Juror vs Qodo: AI code review for different operating models.` |
| `/en/compare/juror-vs-cursor-bugbot` | `Juror vs Bugbot`, `Cursor Bugbot alternative` | `Juror vs Cursor Bugbot: independent jury or editor ecosystem.` |
| `/en/compare/juror-vs-github-copilot-code-review` | `Juror vs Copilot code review` | `Juror vs GitHub Copilot code review.` |
| `/en/compare/juror-vs-bito` | `Juror vs Bito`, `Bito alternative` | `Juror vs Bito: code-review approaches compared.` |
| `/en/compare/juror-vs-codeant` | `Juror vs CodeAnt`, `CodeAnt alternative` | `Juror vs CodeAnt: PR review and code-security scope.` |
| `/en/compare/juror-vs-sonarqube` | `Juror vs SonarQube`, `AI review vs static analysis` | `Juror and SonarQube solve different review problems.` |
| `/en/compare/best-ai-code-review-tools` | `best AI code review tools` | `How to choose an AI code review tool.` |
| `/en/compare/ai-code-review-vs-static-analysis` | `AI code review vs static analysis` | `AI review and static analysis: use both for different jobs.` |

#### F. Resource pillars, guides, and templates (28 pages)

Every resource includes an author/editor, last reviewed date, purpose-built diagrams or code, sources, and links to one parent, two siblings, and one commercial page. Do not publish a resource until it has a distinct answer and at least 800–1,500 words of substantive content; benchmark and flagship guides will be longer.

| Route | Content title / primary term | Required contents |
| --- | --- | --- |
| `/en/resources` | `Juror resources for better code review` | Hub filtering by guides, checklists, templates, benchmarks, comparisons. |
| `/en/resources/what-is-ai-code-review` | `What is AI code review?` | Definition, workflow, limitations, human role, tool criteria, FAQ. |
| `/en/resources/ai-code-review-guide` | `A practical guide to AI code review` | Adoption steps, policy, pilot, metrics, controls, setup. |
| `/en/resources/code-review-checklist` | `The pull request code review checklist` | Copyable checklist, Markdown download, use by risk level. |
| `/en/resources/code-review-best-practices` | `Code review best practices for fast teams` | Preparation, comments, risk, tests, decision hygiene. |
| `/en/resources/automated-pull-request-review` | `How automated pull request review works` | Bots, CI, reviewer responsibilities, configuration example. |
| `/en/resources/reviewing-ai-generated-code` | `How to review AI-generated code` | Threat model, verification questions, test and rollout checklist. |
| `/en/resources/agentic-code-review` | `What is agentic code review?` | Agent/tools/context, risks, evaluation, policy. |
| `/en/resources/ai-code-review-benchmarks` | `How to evaluate AI code reviewers` | Dataset design, adjudication, precision/recall, false-positive cost, reproducibility. |
| `/en/resources/code-review-metrics` | `Code review metrics that do not reward noise` | Review latency, fixed-finding rate, defects escaped, confidence calibration, measurement caveats. |
| `/en/resources/ai-code-review-costs` | `How to model AI code review cost` | Token/model cost, PR size, ceilings, provider billing, worksheet. |
| `/en/resources/code-review-vs-testing` | `Code review vs testing: where each fails` | Decision table, test layers, review checklists. |
| `/en/resources/static-analysis-vs-ai-code-review` | `Static analysis vs AI code review` | Strengths/limits/integration rather than a winner. |
| `/en/resources/github-actions-code-review` | `Set up AI code review in GitHub Actions` | Minimal YAML, least privilege, SHA pinning, troubleshoot. |
| `/en/resources/pull-request-template` | `Pull request templates that improve review quality` | Template variants and downloadable files. |
| `/en/resources/codeowners-and-ai-review` | `How CODEOWNERS and AI review work together` | Routing vs review analysis, example setup. |
| `/en/resources/typescript-code-review-checklist` | `TypeScript code review checklist` | Type-specific risks, examples, tools. |
| `/en/resources/python-code-review-checklist` | `Python code review checklist` | Python-specific risks, examples, tools. |
| `/en/resources/go-code-review-checklist` | `Go code review checklist` | Go-specific risks, examples, tools. |
| `/en/resources/java-code-review-checklist` | `Java code review checklist` | Java-specific risks, examples, tools. |
| `/en/templates` | `Code review templates` | Template hub, versioning policy, GitHub links. |
| `/en/templates/github-actions-juror-workflow` | `Juror GitHub Actions workflow template` | Current SHA-pinned YAML, inputs, secrets, explanation. |
| `/en/templates/pull-request-template` | `Pull request template for reliable review` | Small/feature/hotfix variants in Markdown. |
| `/en/templates/code-review-checklist` | `Code review checklist template` | Markdown and issue-template versions. |
| `/en/templates/ai-code-review-policy` | `AI code review policy template` | Team policy, risk levels, human ownership, exceptions. |
| `/en/templates/post-merge-qa-plan` | `Post-merge QA plan template` | Synthetic account, journey/checkpoint, reset/rollback fields. |
| `/en/templates/benchmark-scorecard` | `AI code review benchmark scorecard` | Dataset and adjudication spreadsheet schema; no results implied. |
| `/en/templates/model-review-config` | `Multi-model review configuration template` | Preset, provider, budget, consensus configuration only for released fields. |

#### G. Documentation (10 pages)

Documentation is product truth, not blog content. It should use a separate docs template with permanent anchors, version banner, copyable blocks, “edit on GitHub,” and exactly one canonical source version. The public page has translated surrounding prose and slug; commands, YAML field names, environment variable names, version pins, and code stay exact.

| Route | H1 | Minimum content |
| --- | --- | --- |
| `/en/docs` | `Juror documentation` | Docs landing and task paths. |
| `/en/docs/getting-started` | `Install Juror on a pull request` | Marketplace and direct workflow paths; prerequisites; expected comment. |
| `/en/docs/configuration` | `Configure a Juror review` | Inputs, repository config, safe defaults, links to reference. |
| `/en/docs/presets-and-models` | `Choose presets and models` | Current harness/provider table, cost/speed trade-offs, availability caveat. |
| `/en/docs/consensus-mode` | `Use consensus mode` | Eligibility, refutation, false-positive trade-off. |
| `/en/docs/cost-controls` | `Set review cost controls` | Receipt, target/budget semantics, provider charges. |
| `/en/docs/post-merge-qa` | `Set up post-merge browser QA` | Deployment, targets, synthetic identity, secrets, reset policy, evidence. |
| `/en/docs/security-and-forks` | `Protect secrets and forked pull requests` | Workflow condition, permissions, safe examples. |
| `/en/docs/benchmarking` | `Benchmark Juror` | Corpus, commands, results, limitations. |
| `/en/docs/troubleshooting` | `Troubleshoot Juror` | Provider/setup/output cost/QA decision tree. |

### Pages deliberately excluded until real evidence exists

- Customer stories: launch the `/customers` hub and individual pages only when a customer has approved their name, quote, outcome, and source material.
- Generic “repository intelligence” or project profile pages: launch only with consented, maintained, and uniquely useful data.
- Security compliance / trust-center pages: launch specific certification pages only after counsel and security owner approval.
- GitLab, Bitbucket, Azure DevOps, self-hosted, IDE, API, and autofix pages: do not create until the product actually supports them.
- Persona and location doorway pages: no `/for-developers-in-{city}` or near-duplicate framework landing pages.

## 5. Localization at slug level

### Non-negotiable URL behavior

Every public route above has a locale prefix and a **localized human-language slug**, not only translated page body text. Example equivalents for the category route:

| Locale | Route | Native title direction |
| --- | --- | --- |
| English | `/en/ai-code-review` | `AI Code Review for GitHub Pull Requests` |
| German | `/de/ki-code-review` | `KI-Code-Review für GitHub-Pull-Requests` |
| French | `/fr/revue-de-code-ia` | `Revue de code par IA pour les pull requests GitHub` |
| Spanish | `/es/revision-de-codigo-con-ia` | `Revisión de código con IA para pull requests de GitHub` |
| Japanese | `/ja/ai-コードレビュー` | `GitHubプルリクエストのAIコードレビュー` |
| Brazilian Portuguese | `/pt-br/revisao-de-codigo-com-ia` | `Revisão de código com IA para pull requests do GitHub` |

Use UTF-8 paths for Japanese where the native keyword is materially better. Generate escaped URLs only in XML/HTTP representations; render a readable Unicode URL in page navigation. Retain trademarked technical identifiers (`GitHub`, `Juror`, `Codex`, environment variable names) unchanged.

### Localized segment and page-key registry

This registry belongs in version control/CMS and is the routing source of truth. Never derive slugs with a machine translation at request time.

| Page key / English segment | `de` | `fr` | `es` | `ja` | `pt-br` |
| --- | --- | --- | --- | --- | --- |
| `ai-code-review` | `ki-code-review` | `revue-de-code-ia` | `revision-de-codigo-con-ia` | `ai-コードレビュー` | `revisao-de-codigo-com-ia` |
| `product` | `produkt` | `produit` | `producto` | `製品` | `produto` |
| `how-it-works` | `so-funktioniert-es` | `comment-ca-marche` | `como-funciona` | `仕組み` | `como-funciona` |
| `features` | `funktionen` | `fonctionnalites` | `funciones` | `機能` | `funcionalidades` |
| `solutions` | `loesungen` | `solutions` | `soluciones` | `ソリューション` | `solucoes` |
| `integrations` | `integrationen` | `integrations` | `integraciones` | `連携` | `integracoes` |
| `compare` | `vergleich` | `comparer` | `comparar` | `比較` | `comparar` |
| `resources` | `ressourcen` | `ressources` | `recursos` | `リソース` | `recursos` |
| `templates` | `vorlagen` | `modeles` | `plantillas` | `テンプレート` | `modelos` |
| `docs` | `dokumentation` | `documentation` | `documentacion` | `ドキュメント` | `documentacao` |
| `benchmarks` | `benchmarks` | `benchmarks` | `benchmarks` | `ベンチマーク` | `benchmarks` |
| `pricing` | `preise` | `tarifs` | `precios` | `料金` | `precos` |
| `security` | `sicherheit` | `securite` | `seguridad` | `セキュリティ` | `seguranca` |
| `open-source` | `open-source` | `open-source` | `codigo-abierto` | `オープンソース` | `codigo-aberto` |
| `changelog` | `aenderungsprotokoll` | `journal-des-modifications` | `registro-de-cambios` | `変更履歴` | `registro-de-alteracoes` |

Each leaf has an explicit localized slug too. The complete preliminary registry is [seo-route-manifest.csv](seo-route-manifest.csv); for example, `compare/juror-vs-greptile` becomes `/de/vergleich/juror-vs-greptile`, `/fr/comparer/juror-vs-greptile`, and `/ja/比較/juror-vs-greptile`. Branded comparator names remain stable while the category segment is localized. The CMS must reject a locale publication with a missing title, description, H1, slug, body, image alt text, and reviewer.

### International SEO implementation checklist

1. Each locale URL is self-canonical. Do **not** canonicalize translated pages back to English.
2. Render a complete `hreflang` set on every page: `en`, `de`, `fr`, `es`, `ja`, `pt-BR`, plus `x-default` pointing to `/en` or the English equivalent. Use valid BCP 47 casing.
3. Use an explicit locale switcher that links to exact equivalents. Do not browser-redirect search crawlers or users; offer a non-blocking suggestion instead.
4. Translate `<title>`, meta description, H1, Open Graph text, JSON-LD text, navigation labels, image alt text, and on-page anchors. Do not machine-translate benchmark evidence or legal text without human/legal review.
5. Maintain locale-specific XML sitemaps and a sitemap index. A page enters a locale sitemap only after it is complete and indexable.
6. Keep language-specific keyword research and native editorial review. Direct English translations often miss the terminology real developers search for.
7. Code snippets may remain English. Explain them in the locale and do not translate fields, commands, values, file paths, API identifiers, or pinned SHAs.
8. Every content update enters a translation queue with a target SLA. If a translated page becomes materially stale, add a visible version notice; do not silently leave it old while English changes.

## 6. Homepage: exact content and design specification

### Page hierarchy

1. **Utility bar (optional and dismissible):** a real release/benchmark announcement only. No fake urgency.
2. **Header:** Juror mark; Product, Solutions, Resources, Docs, Pricing; locale switcher; GitHub icon link; `Add to GitHub` button.
3. **Hero:** category label, H1, supporting sentence, two CTAs, micro-proof. The hero visual is a living PR review—not an abstract AI animation.
4. **Proof band:** source links to GitHub Marketplace, MIT license, benchmark methodology, and release status. Use only facts that can be linked.
5. **Problem/answer:** `AI writes more code. Review still decides what ships.` Explain the validation bottleneck in 80–110 words.
6. **Product proof:** full-width terminal-to-GitHub diagram: diff → isolated model reviewers → anchored findings → duplicate collapse/referee → final batched GitHub review + merge confidence + cost receipt.
7. **Three outcome cards:** `Independent perspectives`, `One non-repetitive review`, `A cost you can inspect`. Each includes one short fact and a “learn more” link.
8. **Finding lifecycle section:** titled `How several reviews become one decision.` The five stages displayed as a horizontally scrollable but text-equivalent timeline. This is the core product explanation.
9. **Proof examples:** three tabs—`Bug found`, `Duplicates merged`, `Consensus refutes`. Each is backed by sanitized/reproducible data and clearly labels whether it is a demo or actual corpus artifact.
10. **Cost receipt section:** title `The receipt belongs in the pull request.` Show input/cached/output/cost/harness table with “estimated” versus “reported” labels.
11. **Post-merge QA section:** title `Review the diff. Then validate the journey.` Brief optional module with strong limitations link; it must not distract from PR review.
12. **Benchmark module:** `Evidence beats a leaderboard.` Results teaser, corpus size, date, limitations, and link. Hide the module until evidence passes the claim policy.
13. **Configuration strip:** a real, short YAML snippet; link to docs. Mention least privilege and pinned action usage.
14. **FAQ:** 6 questions: what Juror does, models/providers, duplicate handling, consensus mode, costs, fork security. Answers must match released behavior.
15. **Final CTA:** `Put a jury on the next pull request.` Buttons `Add Juror to GitHub` and `Read the docs`.
16. **Footer:** product, resources, docs, legal, GitHub, locale selector. Include company/legal data only when confirmed.

### Homepage draft copy

Use this as the first English source copy; legal/product review is required before publishing.

```text
Eyebrow: MULTI-MODEL CODE REVIEW

H1: The AI code review jury for GitHub pull requests.

Body: Run frontier models in parallel. Juror merges duplicate findings into one review,
shows the confidence behind it, and gives you the bill.

Primary CTA: Add Juror to GitHub
Secondary CTA: See a real review

Micro-proof: GitHub Action · Read-only reviewers · Deduplicated findings · Cost receipt

Section: AI writes more code. Review still decides what ships.
The fastest way to create a pull request is no longer the hard part. The hard part is deciding
whether a change is safe to merge. Juror gives each model room to inspect the change, then
turns overlapping reports into a review a human can actually use.

Section: One pull request, several independent reviewers.
Each reviewer receives the diff and a clean read-only checkout. Juror anchors findings to the
change, groups possible duplicates, asks a referee only when needed, and accounts for every
report before it publishes one batched GitHub review.

Card: Independent perspectives
Different models notice different failure modes. Review in parallel instead of betting every
pull request on one point of view.

Card: One non-repetitive review
When reports describe the same defect, Juror keeps the evidence without making the author read
the same comment three times.

Card: Cost you can inspect
Every review includes a receipt with model, harness, token usage when available, and cost source.

Section: Tune for recall or agreement.
Default review preserves unique eligible findings. Consensus mode adds an adversarial refutation
pass so teams can use model agreement as a precision filter.

Final CTA: Put a jury on the next pull request.
```

### Visual system brief

- **Canvas:** white/near-white in light mode, near-black in dark mode. Use a single accent reserved for severity and primary action; never borrow Vercel gradients or asset treatments.
- **Type:** modern system/geometric sans with a high-quality mono face for diffs and receipts. 12-column desktop grid, 4-column mobile grid, max content width 1200–1280px.
- **Surfaces:** 1px neutral borders, 8–12px radius max, shallow/no shadow, dense panels. Let the product artifact carry visual interest.
- **Motion:** `prefers-reduced-motion` by default; 150–220ms opacity/transform transitions only. The timeline may animate through stages but must expose equivalent static text and never block LCP.
- **Hero artifact:** DOM text/code, not an image; accessible labels for diff, finding, severity, agreement, score, and receipt. It should work without JavaScript.
- **Media:** no stock robot art. Required assets are product screenshot/recreated demo, diagram, small severity icons, and social-card illustration built from Juror’s own visual language.
- **Mobile:** header menu retains locale switcher; code artifacts support horizontal scroll with visible affordance; tables become labelled cards; all CTA copy remains visible.

## 7. Content templates and production requirements

### Commercial page template

1. Breadcrumb (except home), category label, one H1, 2-sentence answer, CTA.
2. Product proof above the first scroll: a real output, setup clip, or reproducible artifact.
3. Three to five benefit sections where each ties directly to an existing capability.
4. “How it works” with text-equivalent diagram.
5. Setup/configuration path, security/cost caveat where relevant.
6. FAQ with genuinely different questions.
7. Related pages and one final CTA.

Target: 700–1,200 words, not including code, FAQs, captions, or legal text. It earns a commercial intent query rather than pretending to be an article.

### Comparison template

1. Transparent editorial note: owner, comparison date, versions, and how facts were sourced.
2. Two-sentence neutral answer to “which should I choose?”
3. Decision table with no unverified score. Separate capability, integration, deployment, pricing model, evidence, and workflow.
4. Product workflows shown side by side; link to primary competitor docs for all competitor facts.
5. Benchmark only if method, corpus, and limitations are on-page.
6. `Choose {competitor} if…` and `Choose Juror if…` sections, each with at least three honest conditions.
7. Setup/migration guidance limited to actual Juror support.
8. Source list, update date, and factual correction contact.

Target: 1,400–2,200 words. An editor must re-verify all competitor facts each quarter and immediately after material product changes.

### Educational guide template

1. Direct 40–70 word answer, then an on-page table of contents.
2. Definition/decision framework, detailed steps, examples, common mistakes, checklist or template, FAQ.
3. Use original diagrams, citations, and expert review where a claim is controversial.
4. Contextual commercial CTA after the reader has received the answer; never gate the essential content.

Target: 1,200–2,500 words. Every guide has a clear author, editor, publication date, and reviewed date.

### Template page template

1. One-sentence use case, version/date, and the full copyable file in the page source.
2. Explain every non-obvious line, use cases, variations, security risks, and testing/validation.
3. Link to canonical GitHub file so users can audit revision history.

## 8. Technical SEO, performance, and accessibility definition of done

### Crawl and rendering

- Use statically rendered, indexable HTML for all marketing, resource, comparison, and documentation pages. No critical copy, title, internal links, or structured data may depend on client-side hydration.
- One indexable 200 URL per published locale page. Enforce 301 redirects from old/alternate URL patterns, remove redirect targets from sitemaps, and never return `200` for a missing translated page.
- Generate `sitemap-index.xml` → one sitemap per locale and content type. Include `lastmod` only when a meaningful page content change occurred.
- Keep staging, preview deployments, search pages, internal CMS previews, tag filters, thank-you pages, and query-param duplicates `noindex`. Disallow them in robots only as a supplement, not instead of `noindex`.
- Use clean lowercase routes; retain a translation registry to prevent accidental slug changes. When a slug changes, 301 it and update internal links/hreflang/sitemap in the same deployment.

### Metadata and structured data

- Unique title (roughly 50–60 characters when possible), visible H1, concise meta description (roughly 140–160 characters), canonical, Open Graph, Twitter card, and social image per page/locale.
- Use `Organization`, `WebSite`, `SoftwareApplication`, `BreadcrumbList`, and `Article` only where the visible page supports them. Use `HowTo` and `FAQPage` only when the exact steps/FAQ are visibly on that page and eligible for Google display.
- Do not use fake star ratings, `Review` schema about Juror from Juror, unverified price fields, or invisible schema content.
- Publish a stable `/en/llms.txt` only as a convenience document, not as an SEO substitute; it must never diverge from canonical product docs. Add it to the localization registry only after a specific strategy decision.

### Internal linking contract

- Home links to every commercial hub; commercial pages link to their related resource and docs task page.
- Each resource guide has: breadcrumb → hub, cluster parent, two sibling guides, one template, one relevant product page.
- Comparison pages link to benchmark methodology once and source URLs directly; they do not use each other as a ring of low-value links.
- Docs link to setup/product pages only where relevant and use task-driven navigation above generic product navigation.
- Every visible link has descriptive anchor text. Avoid “click here,” repeated footer-only links, and a dependence on JS menus for discovery.

### Core Web Vitals and accessibility budgets

| Area | Requirement |
| --- | --- |
| LCP | No autoplay hero video or oversized client bundle; prioritize the H1 and DOM-based PR visual. Target p75 LCP ≤2.5s on mobile. |
| INP | No interaction-heavy canvas hero; defer analytics and non-essential chat widgets. Target p75 INP ≤200ms. |
| CLS | Reserve image/embed dimensions and avoid late banner insertion. Target p75 CLS ≤0.1. |
| Performance testing | Test launch routes on mobile/desktop with real WebPageTest/Lighthouse profiles before release; monitor CrUX/Search Console afterward. |
| Semantics | One H1, logical heading order, landmarks, keyboard-visible focus, skip link, native buttons/links, no empty icon controls. |
| Artifacts | PR visual is selectable text with accessible table/list fallback; color is never the sole severity or agreement signal. |
| Localization | `<html lang>` matches route, `dir` is set where applicable, Unicode URLs work, locale names are native-language labels. |

### Measurement plan

| Funnel stage | Events / KPI | Decision rule |
| --- | --- | --- |
| Discovery | Impressions, non-brand clicks, query/page coverage, indexed localized routes | Expand a cluster only when the first pillar has impressions and the next page is substantively distinct. |
| Evaluation | Benchmark clicks, comparison scroll depth, docs visits from commercial pages | Improve proof placement and answer summary if readers leave before product evidence. |
| Activation | Marketplace click, workflow copy, install completion, first-review completion | Attribute by canonical landing page and locale; do not treat a CTA click as activation. |
| Quality | First-review cost receipt viewed, consensus configuration, return review rate | Use product telemetry only with a stated privacy policy and consent model. |
| Editorial | Update freshness, broken links, source re-check rate, localization lag | Quarterly audit; comparison facts and benchmark claims are revalidated before the next quarter. |

## 9. Launch sequence and content operating model

### Phase 0 — foundation (before public indexing)

1. Confirm brand/domain, GitHub Marketplace destination, support contact, analytics/privacy decision, and legal owner.
2. Build the locale/page-key registry, canonical/hreflang/sitemap generator, redirect testing, and static HTML template.
3. Produce the product artifact set: authentic example review, pipeline diagram, cost receipt, configuration snippet, benchmark methodology artifact.
4. Create claim register and competitor-source register. Reject claims with no owner/evidence.

### Phase 1 — launchable conversion surface (weeks 1–3)

Publish all six locales together for these 21 logical pages: home, AI code review, product, how it works, GitHub AI code review, multi-model review, consensus review, transparent costs, post-merge QA, benchmarks, examples, pricing, security, open source, integrations/GitHub, integrations/GitHub Actions, docs, docs/getting started, docs/security and forks, privacy, and terms. Validate all 126 localized URLs before indexing.

Phase 1 navigation may link only to pages that are live. Keep the header to Product, Docs, Pricing, GitHub, locale switcher, and the install CTA until the Solutions, Resources, Integrations, and Compare hubs ship; do not use placeholder or `#` navigation links.

### Phase 2 — comparison, proof, and long-tail foundations (weeks 4–7)

Publish the Features, Solutions, Integrations, Compare, and Resources hubs; their capability/solution/integration children; the first five comparison pages (Greptile, CodeRabbit, Qodo, Cursor Bugbot, GitHub Copilot); seven flagship guides; and three templates. Add only localized pages that have native editorial review; the launch constraint remains that a planned public page is not considered live in one locale only.

### Phase 3 — depth and authority (weeks 8–12)

Publish the remaining comparisons, language-specific checklists, the remaining templates, docs, changelog, and approved customer proof. Start one flagship original research asset: an expanded, externally reviewable code-review benchmark—not a marketing leaderboard.

### Phase 4 — evidence-led expansion (quarterly)

Add a guide or template only when Search Console shows a query cluster the existing page cannot serve without cannibalization. Consider programmatic pages only after Juror owns an updated, unique dataset and every page has enough original analysis to be useful without a conversion CTA.

### Roles and quality gates

| Deliverable | Accountable owner | Required approver |
| --- | --- | --- |
| Product claims/configuration | Engineering/product | Release owner |
| Benchmark/results | Research lead | Independent technical reviewer |
| Comparisons | Content lead | Product + legal/brand reviewer |
| Localized copy | Native technical editor | Locale lead |
| Security/legal | Security/legal owner | Authorized signer |
| Metadata/schema/links | SEO engineer | QA reviewer |

No page ships without: a unique intent; page key and all locale slugs; final H1/title/description; original body; canonical/hreflang; source/claim record; internal links; social image alt; static render check; mobile/a11y review; and measurement events.

## 10. Research sources

Primary competitor pages and sitemap endpoints inspected for this plan:

- [Greptile homepage](https://www.greptile.com/), [Greptile sitemap](https://www.greptile.com/sitemap.xml), [marketing pages](https://www.greptile.com/sitemap-pages.xml), [Grepository](https://www.greptile.com/sitemap-grepository.xml), [docs sitemap](https://www.greptile.com/docs/sitemap.xml), [Greptile vs CodeRabbit](https://www.greptile.com/greptile-vs-coderabbit)
- [CodeRabbit homepage](https://www.coderabbit.ai/), [sitemap](https://www.coderabbit.ai/sitemap.xml)
- [Qodo homepage](https://www.qodo.ai/), [sitemap](https://www.qodo.ai/sitemap.xml), [page sitemap](https://www.qodo.ai/page-sitemap.xml), [glossary sitemap](https://www.qodo.ai/glossary-sitemap.xml), [question sitemap](https://www.qodo.ai/question-sitemap.xml)
- [Bito AI code review page](https://bito.ai/product/ai-code-review-agent/), [sitemap](https://bito.ai/sitemap.xml)
- [CodeAnt AI code review page](https://codeant.ai/ai-code-review), [sitemap](https://www.codeant.ai/sitemap.xml)
- [Cursor Bugbot](https://cursor.com/bugbot), [Cursor sitemap](https://www.cursor.com/sitemap.xml)
- [GitHub Copilot code review documentation](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/use-code-review)

Re-crawl these endpoints before the design/content build starts. Sitemaps and product positioning change frequently; this document is a build specification grounded in the date above, not an evergreen claim about competitors.
