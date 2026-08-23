import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const LOCALES = [
  { code: 'en', manifestKey: 'en_path', language: 'English', htmlLang: 'en' },
  { code: 'de', manifestKey: 'de_path', language: 'Deutsch', htmlLang: 'de' },
  { code: 'fr', manifestKey: 'fr_path', language: 'Français', htmlLang: 'fr' },
  { code: 'es', manifestKey: 'es_path', language: 'Español', htmlLang: 'es' },
  { code: 'ja', manifestKey: 'ja_path', language: '日本語', htmlLang: 'ja' },
  { code: 'pt-BR', manifestKey: 'pt_br_path', language: 'Português (Brasil)', htmlLang: 'pt-BR' },
] as const;

export type Locale = (typeof LOCALES)[number]['code'];
export type ContentType =
  | 'core'
  | 'feature'
  | 'solution'
  | 'integration'
  | 'comparison'
  | 'resource'
  | 'template'
  | 'docs'
  | 'legal';

export type PageRecord = {
  id: string;
  contentType: ContentType;
  paths: Record<Locale, string>;
  localizationStatus: string;
};

export type PageSpec = {
  h1: string;
  description: string;
  summary: string;
  focus: readonly string[];
  cta?: string;
};

const manifestPath = resolve(process.cwd(), '../../docs/seo-route-manifest.csv');
const manifestRows = readFileSync(manifestPath, 'utf8').trim().split(/\r?\n/);
const manifestHeaders = manifestRows[0].split(',');

function parseManifest(): PageRecord[] {
  const records: PageRecord[] = manifestRows.slice(1).map((line: string): PageRecord => {
    const values = line.split(',');
    const value = (key: string) => values[manifestHeaders.indexOf(key)] ?? '';
    return {
      id: value('page_id'),
      contentType: value('content_type') as ContentType,
      paths: Object.fromEntries(
        LOCALES.map((locale) => [locale.code, value(locale.manifestKey)]),
      ) as Record<Locale, string>,
      localizationStatus: value('localization_status'),
    };
  });

  if (records.length !== 91) throw new Error(`Expected 91 page records; received ${records.length}.`);
  if (new Set(records.map((record: PageRecord) => record.id)).size !== records.length) {
    throw new Error('The route manifest contains duplicate page IDs.');
  }
  const paths = records.flatMap((record: PageRecord) => Object.values(record.paths));
  if (paths.length !== 546 || new Set(paths).size !== paths.length || paths.some((path: string) => !path.startsWith('/'))) {
    throw new Error('The route manifest must contain 546 unique absolute locale paths.');
  }
  return records;
}

export const PAGES = parseManifest();
export const PAGE_BY_ID = new Map(PAGES.map((page) => [page.id, page]));

/**
 * Canonical production origin. The reserved default ensures an unconfigured build never
 * accidentally claims an indexable production domain.
 */
function configuredSiteOrigin(): string {
  const rawOrigin = (process.env.SITE_ORIGIN || 'https://juror.example').replace(/\/$/, '');
  let parsed: URL;
  try {
    parsed = new URL(rawOrigin);
  } catch {
    throw new Error('SITE_ORIGIN must be an absolute URL, for example https://www.juror.dev.');
  }

  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('SITE_ORIGIN must contain only an origin; paths, queries, and hashes are not allowed.');
  }

  return parsed.origin;
}

export const SITE_ORIGIN = configuredSiteOrigin();
export const CONTENT_RELEASE = process.env.CONTENT_RELEASE || 'draft';
export const ALL_PAGES_APPROVED = PAGES.every((page) => page.localizationStatus.startsWith('approved_'));
const siteHostname = new URL(SITE_ORIGIN).hostname;
export const IS_CONFIGURED_ORIGIN = new URL(SITE_ORIGIN).protocol === 'https:'
  && !siteHostname.endsWith('.example')
  && !siteHostname.endsWith('.workers.dev')
  && siteHostname !== 'localhost';
/**
 * Indexing is intentionally an all-or-nothing release decision. This avoids publishing an
 * alternate-language set where a page is missing, unreviewed, or canonicalized to a preview.
 */
export const IS_INDEXABLE_RELEASE = CONTENT_RELEASE === 'approved'
  && IS_CONFIGURED_ORIGIN
  && ALL_PAGES_APPROVED;
export const EDITORIAL_DATE = '2026-08-22';
export const GITHUB_REPOSITORY = 'https://github.com/Juror-AI/juror';
export const JUROR_CLOUD_SIGN_IN = 'https://app.juror.dev/signin';
export const ACTION_SHA = '3eb0c88ce1931dd6227d554b2d9707ee4bca123f';

export const PAGE_SPECS: Record<string, PageSpec> = {
  home: spec('The AI code review jury for GitHub pull requests.', 'Run several frontier models in parallel, merge duplicate findings, and see the cost of every review.', 'Juror gives pull requests independent review perspectives without turning the result into repeated comments or an opaque bill.', ['Independent reviewers', 'Deduplicated findings', 'A visible cost receipt'], 'Add Juror to GitHub'),
  ai_code_review: spec('AI code review that shows its work.', 'A practical, evidence-led approach to AI review for GitHub pull requests.', 'AI review is useful when it adds a clear, inspectable first pass. Juror keeps human review, tests, and static analysis in the decision loop.', ['How an AI review is assembled', 'What stays with humans', 'Where benchmarks matter'], 'Install on GitHub'),
  product: spec('One pull request. Several reviewers. One decision.', 'A product tour of parallel review, finding lifecycle, merge confidence, and cost receipts.', 'Juror fans out a sealed checkout to independent reviewers, then returns one review with anchored findings and its reasoning.', ['Fan out independent reviewers', 'Merge related findings', 'Read the decision and receipt'], 'View setup'),
  how_it_works: spec('How Juror turns many model reviews into one useful review.', 'Follow the five stages from isolated checkout to an evidence-backed GitHub review.', 'The workflow is deliberately narrow: collect independent observations, align them to the diff, collapse overlap, and make uncertainty visible.', ['Isolate the review context', 'Anchor and cluster findings', 'Verify agreement before publishing'], 'Read configuration'),
  github_ai_code_review: spec('Multi-model AI code review, installed as a GitHub Action.', 'Install a SHA-pinned action with least-privilege permissions and visible output.', 'Juror runs in the pull-request workflow you already use. The workflow should be pinned, scoped to safe events, and explicit about provider credentials.', ['Copy a pinned workflow', 'Keep credentials out of forks', 'Read the posted review'], 'Add action'),
  multi_model_code_review: spec('More than one model. Less repeated feedback.', 'Use independent model perspectives while returning one coherent pull-request review.', 'Multiple reviewers can broaden a first pass; they do not make a finding true by vote alone. Juror exposes model evidence and removes repeated observations.', ['Independent perspectives', 'One merged finding', 'Clear trade-offs'], 'Choose a preset'),
  consensus_code_review: spec('Use agreement as a precision control.', 'Tune Juror for high recall or agreement with a visible refutation step.', 'Consensus is a publishing control, not a guarantee. Use it when reducing noisy comments matters more than surfacing every uncertain lead.', ['Recall versus agreement', 'Refutation before publish', 'Severity remains explicit'], 'Configure consensus'),
  transparent_ai_code_review_costs: spec('See what every review costs.', 'Inspect provider-reported or estimated cost beside the pull-request result.', 'Review cost depends on the configured models, changed scope, tool use, and provider billing. Juror reports coverage rather than treating unknown cost as zero.', ['Model and token drivers', 'Reported versus estimated', 'Per-review budget controls'], 'Run a review'),
  post_merge_qa: spec('Validate the live journey after the merge.', 'An optional browser-QA loop with sealed evidence and synthetic-account boundaries.', 'Post-merge QA is separate from code review. It can validate an approved deployment journey when prerequisites, synthetic identity, and evidence handling are explicit.', ['Choose a deployment', 'Use a synthetic session', 'Keep a sealed evidence ledger'], 'Read QA quickstart'),
  benchmarks: spec('Measure reviewers on real pull requests.', 'Benchmark with adjudicated corpora, visible limitations, and a reproducible command.', 'A single favorable pull request is not a benchmark. Juror keeps the corpus, expected findings, coverage, cost, and missed defects visible for review.', ['Adjudicated corpus', 'Precision and recall definitions', 'Known limitations'], 'Inspect the corpus'),
  examples: spec('Read the review before you install it.', 'Inspect reproducible examples of findings, deduplication, disagreement, and receipts.', 'Examples are useful only when they preserve context and label their evidence. Review the finding lifecycle before using examples as a product claim.', ['A bug found', 'Duplicates collapsed', 'A consensus refutation'], 'Install Juror'),
  pricing: spec('Pay the model providers. See the receipt.', 'Juror is open source; provider charges depend on your chosen configuration.', 'There are no invented plan tiers here. Configure providers, set a target, and inspect the receipt that comes back with each review.', ['Open-source route', 'Provider billing remains yours', 'Budget guardrails'], 'Get started'),
  security: spec('Designed for a review workflow with clear boundaries.', 'Review data flow, read-only checkouts, fork protections, and provider-key boundaries.', 'Security claims must follow the released workflow. Juror keeps privileged GitHub tokens out of model processes and documents safety boundaries for forks.', ['Read-only review context', 'Separate privileged tokens', 'Fork-safe workflow conditions'], 'Read security notes'),
  open_source: spec('Keep open-source pull requests moving.', 'A measured review workflow for maintainers who need to protect attention and contributor trust.', 'Open-source maintainers need a useful first pass without a noisy automated gate. Configure Juror around safe events, clear ownership, and transparent limits.', ['Contributor-safe workflow', 'Maintainer triage', 'Open-source license'], 'Add to an OSS repo'),
  changelog: spec('Every release, explained.', 'Versioned release notes, migration context, and links to the source release.', 'Product changes should be understandable at the point of upgrade. Juror releases are tied to source history rather than a generic marketing timeline.', ['Release provenance', 'Migration notes', 'GitHub release links'], 'View GitHub'),
  about: spec('Why Juror exists.', 'The project principles behind evidence-led multi-model pull-request review.', 'Juror exists to make an AI review easier to inspect: multiple viewpoints, one decision surface, and a receipt that acknowledges cost.', ['Review before speed', 'Evidence over claims', 'MIT-licensed project'], 'Read the docs'),
  contact: spec('Talk to the Juror team.', 'Route support, security, and partnership questions to the right public channel.', 'Use the public repository for product questions and the security policy for vulnerability reports. Do not put credentials, code, or private repository data into a contact request.', ['Product support', 'Security reports', 'Project collaboration'], 'Open GitHub'),
  privacy: spec('Privacy policy', 'Privacy information for the Juror marketing site and product documentation.', 'This page is a publication surface for counsel-approved policy text. It does not replace the repository security policy or provider agreements.', ['Data minimization', 'No secret collection', 'Policy versioning']),
  terms: spec('Terms of service', 'Terms and conditions for using the Juror marketing site and related project resources.', 'This page is a publication surface for counsel-approved terms. Product use also remains subject to the licenses and provider terms that apply to the selected workflow.', ['Scope of service', 'Open-source license', 'Policy versioning']),
  features: spec('Juror features for clearer pull-request decisions', 'Explore the review controls that turn several model outputs into one auditable result.', 'Each feature is designed around a concrete decision: what evidence to collect, what to merge, what to publish, and what to leave to the reviewer.', ['Review architecture', 'Decision controls', 'Documented limits'], 'View product'),
  parallel_model_review: spec('Parallel model review for pull requests', 'Run supported harnesses independently against a sealed checkout.', 'Parallel review increases perspective, not certainty. Keep the configured model set visible and weigh timing, cost, and review quality together.', ['Supported harnesses', 'Independent checkout', 'Time and cost trade-offs'], 'Choose a preset'),
  deduplicated_findings: spec('One bug should produce one finding.', 'Collapse exact and similar reports without losing evidence or coverage.', 'A useful review must preserve each reviewer observation while returning a human-readable decision. Juror uses anchors, similarity, and a referee stage to do that.', ['Anchor to the diff', 'Cluster overlap', 'Audit coverage'], 'See examples'),
  merge_confidence: spec('A merge score with its reasoning attached.', 'Read the inputs and limits behind a merge-confidence signal.', 'A score is context, not an approval. Juror keeps severe findings, model votes, and rationale visible so people can decide what ships.', ['Severity cap', 'Visible votes', 'Not an autonomous merge'], 'Read configuration'),
  consensus_mode: spec('Tune review for recall or agreement.', 'Choose a publication mode that matches the risk and noise tolerance of your team.', 'Consensus mode changes what is published after a review, not what your team must verify. The refutation stage and source evidence remain part of the result.', ['High-recall mode', 'Agreement mode', 'Recommended use cases'], 'Configure consensus'),
  cost_receipts: spec('No mystery AI review bill.', 'Keep provider cost coverage and budget controls attached to the review.', 'Cost receipts distinguish provider-reported values, estimates, partial coverage, and unknowns. That makes a budget conversation possible without false precision.', ['Source labeling', 'Coverage caveats', 'Budget controls'], 'Read cost controls'),
  repository_context_without_indexing: spec('Repository context without a standing index.', 'Use read and search tools without creating a permanent semantic index of the repository.', 'Juror works from the review checkout and configured tools. This avoids a standing repository index while making scope and context limits explicit.', ['Read and search tools', 'No standing index', 'Context boundaries'], 'Read security notes'),
  post_merge_browser_qa: spec('A controlled post-merge browser QA loop.', 'Validate an approved deployment with a synthetic session and sealed evidence.', 'Browser QA must be bounded. Juror supports deliberate deployment selection, synthetic identity, and a no-reset mode that keeps evidence traceable.', ['Deployment selection', 'Sealed evidence', 'Exact limitations'], 'Read QA quickstart'),
  solutions: spec('Code-review workflows for the way your team ships.', 'Choose a Juror workflow by team, risk profile, and delivery path.', 'The right review workflow is operational rather than generic. Start with the problem you need to reduce, then keep humans, tests, and release checks in the loop.', ['Audience selection', 'Workflow boundaries', 'Evidence handoffs'], 'Explore solutions'),
  review_ai_generated_code: spec('Review code generated at AI speed.', 'A policy-led first review for larger, faster-changing pull requests.', 'Generated code can change the volume of review work; it does not remove the need to verify behavior, security, tests, and rollout conditions.', ['Generated-code checklist', 'Risk-based review policy', 'Human verification'], 'Read the guide'),
  github_actions_code_review: spec('Add an AI review gate to GitHub Actions.', 'Connect a SHA-pinned review action to a least-privilege pull-request workflow.', 'A review action belongs alongside CI, not in place of it. Pin the action, set safe fork conditions, and keep the review output accountable to humans.', ['Event flow', 'Pinned action', 'Fork safety'], 'Copy workflow'),
  engineering_teams: spec('Give engineering teams a shared first review.', 'Create a consistent first-pass review without replacing ownership or discussion.', 'Juror can reduce repetitive review work when teams agree on how findings, merge confidence, and exceptions are handled.', ['Reviewer roles', 'Noise reduction', 'Rollout plan'], 'View product'),
  platform_engineering: spec('A configurable review layer for platform teams.', 'Centralize policy while keeping repositories explicit about models, cost, and safe workflows.', 'Platform teams can offer a review baseline without hiding how it works. Keep provider policy, workflow configuration, and audit artifacts visible.', ['Shared workflow template', 'Provider policy', 'Cost artifacts'], 'Read configuration'),
  open_source_maintainers: spec('Spend maintainer time where it matters.', 'Use a transparent first pass for contributor pull requests without weakening fork safety.', 'Maintainers need triage help, not an opaque replacement for judgment. Set conditions that protect secrets and leave the final decision with project owners.', ['Safe pull-request events', 'Triage support', 'Issue templates'], 'Read security notes'),
  startups: spec('Ship quickly without guessing at review cost.', 'Start with a small, inspectable multi-model review loop.', 'Small teams can use independent review perspectives while keeping spend, operational limits, and human ownership explicit from the first workflow.', ['Fast setup', 'Budget controls', 'Transparent limits'], 'Get started'),
  monorepo_pull_requests: spec('Review changes that reach beyond one file.', 'Use scoped repository context to reason about cross-file changes without pretending every risk is known.', 'Monorepo review needs a clear changed-file scope and useful context. Tests and domain owners remain essential for verifying broader system behavior.', ['Cross-file reasoning', 'Changed-file scope', 'Human and test boundaries'], 'Read the guide'),
  post_merge_quality: spec('Close the loop after merge.', 'Pair pull-request review with optional, bounded post-merge journey validation.', 'Code review and deployment validation answer different questions. Keep the transition explicit and use synthetic QA only where an approved environment supports it.', ['Review before merge', 'Synthetic post-merge QA', 'Release checklist'], 'Read QA quickstart'),
  integrations: spec('Use Juror in the GitHub review workflow.', 'See released GitHub integration paths and supported provider configurations.', 'Juror focuses on GitHub pull-request review. Provider and model configuration is distinct from a source-control integration and must reflect released support.', ['GitHub workflow', 'Action installation', 'Provider configuration'], 'Read documentation'),
  github: spec('Juror for GitHub pull requests.', 'Install Juror into the GitHub pull-request workflow with clear permissions and output.', 'Juror posts a merged review to the pull request after independent harnesses have completed. The action should be pinned and its permissions kept minimal.', ['Marketplace path', 'Trigger configuration', 'Sample review output'], 'View setup'),
  github_actions: spec('A GitHub Action for multi-model review.', 'Configure an auditable multi-model review workflow in GitHub Actions.', 'The workflow is ordinary YAML: use a verified action SHA, minimal permissions, protected secrets, and a pull-request event policy that accounts for forks.', ['Pinned YAML', 'Secret handling', 'Troubleshooting steps'], 'Copy workflow'),
  codex: spec('Use Codex in a Juror review preset.', 'Configure the released Codex harness in a Juror preset without implying affiliation.', 'The available harness and model identifiers must match the released Juror configuration. Model capabilities and availability are provider-controlled and can change.', ['Released harness', 'Preset selection', 'Version caveats'], 'Read presets'),
  claude: spec('Use Claude in a Juror review preset.', 'Configure the released Claude harness in a Juror preset without implying affiliation.', 'Use the harness and version spec supported by the current release. Provider behavior, availability, and billing remain subject to the provider.', ['Released harness', 'Preset selection', 'Version caveats'], 'Read presets'),
  openrouter: spec('Configure a starter multi-model preset with OpenRouter.', 'Use a provider key with explicit cost and security boundaries.', 'The starter preset is opt-in and should be benchmarked before it is promoted. Keep provider credentials in repository secrets, never in the configuration body.', ['Provider requirements', 'Key handling', 'Cost caveats'], 'Read presets'),
  compare: spec('Compare AI code review approaches.', 'Use an evidence-first framework for evaluating AI review tools and workflows.', 'A comparison is useful when it names its evidence, version date, unknowns, and buyer context. Do not compress unlike products into a single score.', ['Decision criteria', 'Source freshness', 'Workflow fit'], 'Read the guide'),
  juror_vs_greptile: spec('Juror vs Greptile: two approaches to AI code review.', 'A date-stamped, source-led comparison of workflow, context, evidence, and setup.', 'Compare the documented workflow and verify current vendor facts before making a choice. This page does not publish a synthetic leaderboard.', ['Review workflow', 'Evidence and freshness', 'Choose by fit']),
  juror_vs_coderabbit: spec('Juror vs CodeRabbit: review workflow, context, and evidence.', 'A source-led comparison for teams evaluating AI pull-request review workflows.', 'Compare documented workflows, operating boundaries, and current commercial terms using their primary sources. Unknowns remain explicit.', ['Review workflow', 'Context boundaries', 'Choose by fit']),
  juror_vs_qodo: spec('Juror vs Qodo: AI code review for different operating models.', 'An evidence-led comparison of review workflow, setup, and decision controls.', 'Compare documented product facts at a known date. The right choice depends on the team workflow, evidence needs, and configuration model.', ['Operating model', 'Setup and controls', 'Choose by fit']),
  juror_vs_cursor_bugbot: spec('Juror vs Cursor Bugbot: independent jury or editor ecosystem.', 'A neutral comparison of independent review and editor-ecosystem approaches.', 'The products may fit different workflows. Read current primary sources for support, configuration, and pricing before making a decision.', ['Workflow fit', 'Configuration scope', 'Choose by fit']),
  juror_vs_github_copilot_code_review: spec('Juror vs GitHub Copilot code review.', 'A dated comparison of AI review approaches in the GitHub workflow.', 'Use primary documentation to check current availability and permissions. Keep the decision tied to how review evidence and ownership work for your repositories.', ['GitHub workflow', 'Evidence model', 'Choose by fit']),
  juror_vs_bito: spec('Juror vs Bito: code-review approaches compared.', 'A source-led comparison of documented code-review workflows and operating boundaries.', 'A meaningful comparison states what was confirmed, not offered, or not evaluated. Revalidate vendor facts before operational decisions.', ['Documented capabilities', 'Source notes', 'Choose by fit']),
  juror_vs_codeant: spec('Juror vs CodeAnt: PR review and code-security scope.', 'Compare documented pull-request review and security-analysis scope without a synthetic score.', 'Use each product where its documented workflow fits. Static analysis, security scanning, and review assistance should not be treated as interchangeable.', ['Review versus security scope', 'Evidence records', 'Choose by fit']),
  juror_vs_sonarqube: spec('Juror and SonarQube solve different review problems.', 'Use AI review and static analysis together for different jobs.', 'Static analysis and AI review have different signal sources and failure modes. Teams usually get better coverage by making the boundary explicit rather than choosing a winner.', ['Different signal sources', 'Complementary controls', 'Choose by fit']),
  best_ai_code_review_tools: spec('How to choose an AI code review tool.', 'A practical selection framework for workflow fit, evidence, cost, and operational boundaries.', 'Start with the review bottleneck, then evaluate source transparency, setup, privacy, false-positive handling, and cost coverage against real pull requests.', ['Decision matrix', 'Trial design', 'Evidence requirements']),
  ai_code_review_vs_static_analysis: spec('AI review and static analysis: use both for different jobs.', 'Compare the strengths and limits of reasoning-assisted review and deterministic analysis.', 'Use static analysis for codified rules and AI review for context-sensitive questions. Neither replaces testing, ownership, or deployment validation.', ['Different jobs', 'Failure modes', 'Layered controls']),
  resources: spec('Juror resources for better code review', 'Guides, checklists, comparisons, benchmarks, and templates for evidence-led review.', 'Resources are organized by the decision you need to make: understand the workflow, set a policy, configure a review, or evaluate its output.', ['Guides', 'Checklists', 'Templates'], 'Browse resources'),
  what_is_ai_code_review: spec('What is AI code review?', 'A definition of AI-assisted code review, its workflow, limits, and human role.', 'AI code review uses models or tooling to inspect a change and propose questions or findings. It is a review aid, not a replacement for tests or accountable owners.', ['Definition', 'Workflow', 'Limits and human role']),
  ai_code_review_guide: spec('A practical guide to AI code review', 'Adopt AI review with a policy, a pilot, useful metrics, and clear controls.', 'A responsible rollout begins with a narrow pilot, known risks, measurable outcomes, and a process for handling incorrect findings.', ['Adoption steps', 'Pilot policy', 'Useful metrics']),
  code_review_checklist: spec('The pull request code review checklist', 'A risk-aware checklist for behavior, security, tests, observability, and rollout.', 'A checklist should focus reviewer attention without turning review into box ticking. Scale it with the risk and scope of the change.', ['Behavior', 'Security and data', 'Tests and rollout']),
  code_review_best_practices: spec('Code review best practices for fast teams', 'Make review faster by improving preparation, discussion, risk signals, and decisions.', 'Fast review is not shallow review. Teams improve throughput by giving reviewers context, separating severity from style, and recording decisions.', ['Prepare the change', 'Discuss risk clearly', 'Decide and follow up']),
  automated_pull_request_review: spec('How automated pull request review works', 'Understand the roles of bots, CI, reviewers, and configuration in a PR workflow.', 'Automation can prepare context and flag risks, but people still own the merge decision. Make the execution conditions and failure modes visible.', ['Bot responsibilities', 'CI relationship', 'Human ownership']),
  reviewing_ai_generated_code: spec('How to review AI-generated code', 'Use a threat model, verification questions, and rollout checks for generated changes.', 'Generated code can look complete before its assumptions are verified. Review behavior, boundaries, tests, dependencies, and release conditions deliberately.', ['Threat model', 'Verification questions', 'Test and rollout checklist']),
  agentic_code_review: spec('What is agentic code review?', 'Understand tool-using review agents, their context, risks, and evaluation needs.', 'Agentic review uses tools to gather context before producing findings. That can expand the review surface, so execution controls and evaluation matter.', ['Tools and context', 'Risks', 'Evaluation policy']),
  ai_code_review_benchmarks: spec('How to evaluate AI code reviewers', 'Design an adjudicated benchmark that measures value rather than raw comment volume.', 'Evaluate on representative pull requests, record misses and false positives, and preserve cost and latency coverage so comparisons remain honest.', ['Dataset design', 'Adjudication', 'Reproducibility']),
  code_review_metrics: spec('Code review metrics that do not reward noise', 'Measure review quality with outcome coverage, latency, calibration, and limitations.', 'Counted comments are not value. Use explicit human outcomes, escaped defects, time to review, and uncertainty coverage to understand a workflow.', ['Latency', 'Human outcomes', 'Calibration caveats']),
  ai_code_review_costs: spec('How to model AI code review cost', 'Model provider cost, pull-request scope, coverage, and explicit review ceilings.', 'Cost starts with the configured model and context, then varies by change size and tool use. Keep estimates, reported values, and unknowns separate.', ['Cost drivers', 'Review ceiling', 'Coverage reporting']),
  code_review_vs_testing: spec('Code review vs testing: where each fails', 'Use review and testing as complementary controls with different failure modes.', 'Review can question intent and integration; tests can repeatedly check specified behavior. Both need ownership and neither catches every defect.', ['Decision table', 'Test layers', 'Review questions']),
  static_analysis_vs_ai_code_review: spec('Static analysis vs AI code review', 'Combine deterministic analysis and contextual review instead of forcing a false winner.', 'Static tools enforce known patterns; AI review can surface context-sensitive questions. Keep both outputs reviewable and verify their limits.', ['Strengths', 'Limits', 'Integration']),
  github_actions_code_review_guide: spec('Set up AI code review in GitHub Actions', 'Add a least-privilege, SHA-pinned review workflow to a pull request.', 'Start with a small workflow, protected secrets, explicit fork handling, and a dry run. Then observe the posted review before making it a required check.', ['Minimal YAML', 'Least privilege', 'Troubleshooting']),
  pull_request_template_guide: spec('Pull request templates that improve review quality', 'Use small, feature, and hotfix templates to give reviewers decision-ready context.', 'A good template makes behavior, risk, tests, and rollout plans easy to scan. Keep it lightweight enough that teams use it honestly.', ['Template variants', 'Risk context', 'Downloadable files']),
  codeowners_and_ai_review: spec('How CODEOWNERS and AI review work together', 'Use ownership routing and review assistance for separate, complementary jobs.', 'CODEOWNERS routes a change to accountable people. AI review can add a first pass, but it must not obscure the required human owner.', ['Routing', 'Review analysis', 'Example setup']),
  typescript_code_review_checklist: spec('TypeScript code review checklist', 'Review TypeScript changes for types, runtime behavior, boundaries, and tests.', 'Type checks are valuable but do not prove runtime behavior. Review type narrowing, input validation, async behavior, and build output alongside tests.', ['Type boundaries', 'Runtime behavior', 'Tooling and tests']),
  python_code_review_checklist: spec('Python code review checklist', 'Review Python changes for data boundaries, errors, dependencies, and tests.', 'Python review needs attention to dynamic behavior, exceptions, environment differences, and dependency assumptions as well as readable code.', ['Data boundaries', 'Errors and async work', 'Tests and dependencies']),
  go_code_review_checklist: spec('Go code review checklist', 'Review Go changes for concurrency, errors, APIs, and operational behavior.', 'Go review benefits from checking context cancellation, error handling, ownership of goroutines, and behavior under load or failure.', ['Concurrency', 'Errors and APIs', 'Operational behavior']),
  java_code_review_checklist: spec('Java code review checklist', 'Review Java changes for contracts, concurrency, dependencies, and tests.', 'Java review should make contracts, nullability, resource ownership, threading, and framework behavior explicit before a change is merged.', ['Contracts', 'Concurrency', 'Tests and dependencies']),
  templates: spec('Code review templates', 'Versioned templates for a review workflow, pull request, policy, QA plan, and scorecard.', 'Templates are starting points rather than policy by themselves. Adapt them to your repository, risk model, and responsible reviewers.', ['Workflow files', 'Review policy', 'Evaluation templates'], 'Browse templates'),
  github_actions_juror_workflow: spec('Juror GitHub Actions workflow template', 'Copy a SHA-pinned starting workflow for a Juror pull-request review.', 'Use this as a reviewed starting point. Replace the pin only through your dependency-update policy and configure secrets in GitHub, not in the file.', ['Pinned action', 'Inputs', 'Secrets'], 'Read setup docs'),
  pull_request_template: spec('Pull request template for reliable review', 'Copy small, feature, and hotfix pull-request templates with risk prompts.', 'Choose the smallest template that captures context, verification, and rollout. A template should help reviewers ask better questions, not create filler.', ['Small change', 'Feature change', 'Hotfix']),
  code_review_checklist_template: spec('Code review checklist template', 'Copy a Markdown checklist or issue-template version for your team.', 'Use the checklist as a prompt for evidence. Make critical controls visible, then allow reviewers to record meaningful exceptions.', ['Markdown', 'Issue template', 'Risk levels']),
  ai_code_review_policy: spec('AI code review policy template', 'Set risk levels, human ownership, exceptions, and provider boundaries for AI review.', 'A policy should say what an automated review can do, who owns verification, which changes need extra scrutiny, and how exceptions are documented.', ['Risk levels', 'Human ownership', 'Exceptions']),
  post_merge_qa_plan: spec('Post-merge QA plan template', 'Plan a synthetic post-merge journey with checkpoints, evidence, reset, and rollback fields.', 'Use only an approved environment and synthetic identity. The plan should make scope, reset behavior, and escalation paths explicit before automation starts.', ['Synthetic account', 'Journey checkpoints', 'Rollback']),
  benchmark_scorecard: spec('AI code review benchmark scorecard', 'Create a versioned scorecard for corpus design, adjudication, coverage, and cost.', 'A scorecard records method before results. Preserve the corpus, expected findings, reviewer versions, failures, and unknown cost coverage.', ['Dataset fields', 'Adjudication', 'Coverage']),
  model_review_config: spec('Multi-model review configuration template', 'Configure released presets, providers, budgets, and consensus options.', 'Start from released configuration fields and keep provider keys outside the file. A model configuration is a review policy, not just a speed setting.', ['Preset', 'Provider', 'Budget and consensus']),
  docs: spec('Juror documentation', 'Task-focused documentation for installing, configuring, reviewing, and validating Juror.', 'Documentation is product truth: it preserves released identifiers and commands while making the surrounding task clear in each supported locale.', ['Install', 'Configure', 'Operate'], 'Start here'),
  getting_started: spec('Install Juror on a pull request', 'Add a pinned Juror workflow, set provider secrets, and inspect the first result.', 'Use the Marketplace or a direct workflow path. Start with a safe event, least privilege, and a dry run before making the review required.', ['Prerequisites', 'Workflow', 'Expected comment']),
  configuration: spec('Configure a Juror review', 'Set action inputs and repository configuration with safe, released defaults.', 'Configuration decides which reviewers run, where output is posted, and how cost is reported. Keep secrets in environment storage and validate changes with a dry run.', ['Action inputs', 'Repository config', 'Safe defaults']),
  presets_and_models: spec('Choose presets and models', 'Select a released preset by review depth, speed, provider availability, and cost.', 'Preset names identify released configuration, not quality guarantees. Check current provider availability and benchmark a workflow before changing a critical gate.', ['Preset table', 'Cost-speed trade-offs', 'Availability caveats']),
  consensus_mode_docs: spec('Use consensus mode', 'Configure the published-finding threshold and understand the false-positive trade-off.', 'Consensus applies a visible agreement policy after review collection. It can reduce noise but it can also suppress useful minority observations.', ['Eligibility', 'Refutation', 'Trade-off']),
  cost_controls: spec('Set review cost controls', 'Use receipts, targets, provider billing awareness, and coverage labels.', 'A cost target is a planning control rather than a guarantee that every provider can enforce a hard stop. Read the receipt and provider bill together.', ['Receipt', 'Target semantics', 'Provider charges']),
  post_merge_qa_docs: spec('Set up post-merge browser QA', 'Configure an approved deployment, target journey, synthetic identity, and evidence rules.', 'Do not run browser QA against an unapproved environment or real customer data. Define reset policy, secrets, and evidence handling before enabling the task.', ['Deployment', 'Synthetic identity', 'Evidence']),
  security_and_forks: spec('Protect secrets and forked pull requests', 'Use event conditions and permissions that protect secrets when reviewing forked pull requests.', 'A pull-request workflow must distinguish trusted and untrusted code paths. Keep secrets out of model input and never make fork safety an implicit assumption.', ['Workflow condition', 'Permissions', 'Safe example']),
  benchmarking: spec('Benchmark Juror', 'Run the released benchmark command and record corpus, findings, cost, and limitations.', 'A benchmark is a repeatable adjudication process, not a single score. Preserve all failed or skipped reviews and report unknowns alongside results.', ['Corpus', 'Command', 'Limitations']),
  troubleshooting: spec('Troubleshoot Juror', 'Work through provider, setup, output, cost, and post-merge QA questions step by step.', 'Start by separating configuration, credentials, harness execution, and output expectations. Keep secrets out of logs and use a dry run to reduce risk.', ['Provider', 'Setup and output', 'Cost and QA']),
};

function spec(h1: string, description: string, summary: string, focus: readonly string[], cta?: string): PageSpec {
  return { h1, description, summary, focus, cta };
}

if (Object.keys(PAGE_SPECS).length !== PAGES.length || PAGES.some((page) => !PAGE_SPECS[page.id])) {
  throw new Error('Every manifest page must have a curated English content specification.');
}

type LocaleCopy = {
  nav: Record<'product' | 'solutions' | 'resources' | 'docs' | 'pricing', string>;
  typeLabel: Record<ContentType, string>;
  homeTitle: string;
  overview: string;
  directAnswer: string;
  whatYouGet: string;
  implementation: string;
  limitations: string;
  related: string;
  sources: string;
  reviewed: string;
  language: string;
  install: string;
  cloud: string;
  docs: string;
  viewOnGitHub: string;
  copy: string;
  copied: string;
  prerequisites: string;
  steps: string;
  next: string;
  chooseJuror: string;
  chooseAlternative: string;
  statusConfirmed: string;
  statusUnknown: string;
  footer: string;
  editorialNotice: string;
  skipToContent: string;
  homeAriaLabel: string;
  primaryNavigation: string;
  breadcrumb: string;
};

export const COPY: Record<Locale, LocaleCopy> = {
  en: {
    nav: { product: 'Product', solutions: 'Solutions', resources: 'Resources', docs: 'Docs', pricing: 'Pricing' },
    typeLabel: { core: 'Product guide', feature: 'Feature', solution: 'Solution', integration: 'Integration', comparison: 'Comparison', resource: 'Resource', template: 'Template', docs: 'Documentation', legal: 'Legal' },
    homeTitle: PAGE_SPECS.home.h1, overview: 'Overview', directAnswer: 'Direct answer', whatYouGet: 'What this covers', implementation: 'How it works', limitations: 'Limits to keep in view', related: 'Continue reading', sources: 'Sources and provenance', reviewed: 'Last reviewed', language: 'Language', install: 'Add to GitHub', cloud: 'Get started', docs: 'Read the docs', viewOnGitHub: 'View on GitHub', copy: 'Copy', copied: 'Copied', prerequisites: 'Before you start', steps: 'Steps', next: 'Next task', chooseJuror: 'Choose Juror if', chooseAlternative: 'Choose the alternative if', statusConfirmed: 'Confirmed', statusUnknown: 'Not evaluated', footer: 'Evidence-led multi-model review for GitHub pull requests.', editorialNotice: 'This locale is awaiting the review recorded in the route manifest and remains out of search indexing.', skipToContent: 'Skip to content', homeAriaLabel: 'Juror home', primaryNavigation: 'Primary navigation', breadcrumb: 'Breadcrumb'
  },
  de: {
    nav: { product: 'Produkt', solutions: 'Lösungen', resources: 'Ressourcen', docs: 'Dokumentation', pricing: 'Preise' },
    typeLabel: { core: 'Produktleitfaden', feature: 'Funktion', solution: 'Lösung', integration: 'Integration', comparison: 'Vergleich', resource: 'Ressource', template: 'Vorlage', docs: 'Dokumentation', legal: 'Rechtliches' },
    homeTitle: 'Die KI-Code-Review-Jury für GitHub-Pull-Requests.', overview: 'Überblick', directAnswer: 'Kurzantwort', whatYouGet: 'Das wird behandelt', implementation: 'So funktioniert es', limitations: 'Wichtige Grenzen', related: 'Weiterlesen', sources: 'Quellen und Herkunft', reviewed: 'Zuletzt geprüft', language: 'Sprache', install: 'Zu GitHub hinzufügen', cloud: 'Jetzt starten', docs: 'Dokumentation lesen', viewOnGitHub: 'Auf GitHub ansehen', copy: 'Kopieren', copied: 'Kopiert', prerequisites: 'Vor dem Start', steps: 'Schritte', next: 'Nächste Aufgabe', chooseJuror: 'Juror wählen, wenn', chooseAlternative: 'Alternative wählen, wenn', statusConfirmed: 'Bestätigt', statusUnknown: 'Nicht bewertet', footer: 'Evidenzbasierte Multi-Model-Code-Reviews für GitHub-Pull-Requests.', editorialNotice: 'Diese Übersetzung wartet noch auf die im Routenmanifest vermerkte Prüfung und wird nicht indexiert.', skipToContent: 'Zum Inhalt springen', homeAriaLabel: 'Juror-Startseite', primaryNavigation: 'Hauptnavigation', breadcrumb: 'Navigationspfad'
  },
  fr: {
    nav: { product: 'Produit', solutions: 'Solutions', resources: 'Ressources', docs: 'Documentation', pricing: 'Tarifs' },
    typeLabel: { core: 'Guide produit', feature: 'Fonctionnalité', solution: 'Solution', integration: 'Intégration', comparison: 'Comparaison', resource: 'Ressource', template: 'Modèle', docs: 'Documentation', legal: 'Mentions légales' },
    homeTitle: 'Le jury de revue de code par IA pour les pull requests GitHub.', overview: 'Vue d’ensemble', directAnswer: 'Réponse directe', whatYouGet: 'Ce que cette page couvre', implementation: 'Fonctionnement', limitations: 'Limites à connaître', related: 'À lire ensuite', sources: 'Sources et provenance', reviewed: 'Dernière révision', language: 'Langue', install: 'Ajouter à GitHub', cloud: 'Commencer', docs: 'Lire la documentation', viewOnGitHub: 'Voir sur GitHub', copy: 'Copier', copied: 'Copié', prerequisites: 'Avant de commencer', steps: 'Étapes', next: 'Tâche suivante', chooseJuror: 'Choisissez Juror si', chooseAlternative: 'Choisissez l’alternative si', statusConfirmed: 'Confirmé', statusUnknown: 'Non évalué', footer: 'Revue multi-modèle fondée sur des preuves pour les pull requests GitHub.', editorialNotice: 'Cette traduction attend la révision indiquée dans le manifeste des routes et n’est pas indexée.', skipToContent: 'Aller au contenu', homeAriaLabel: 'Accueil Juror', primaryNavigation: 'Navigation principale', breadcrumb: 'Fil d’Ariane'
  },
  es: {
    nav: { product: 'Producto', solutions: 'Soluciones', resources: 'Recursos', docs: 'Documentación', pricing: 'Precios' },
    typeLabel: { core: 'Guía de producto', feature: 'Función', solution: 'Solución', integration: 'Integración', comparison: 'Comparación', resource: 'Recurso', template: 'Plantilla', docs: 'Documentación', legal: 'Legal' },
    homeTitle: 'El jurado de revisión de código con IA para pull requests de GitHub.', overview: 'Resumen', directAnswer: 'Respuesta directa', whatYouGet: 'Qué cubre esta página', implementation: 'Cómo funciona', limitations: 'Límites importantes', related: 'Sigue leyendo', sources: 'Fuentes y procedencia', reviewed: 'Última revisión', language: 'Idioma', install: 'Añadir a GitHub', cloud: 'Empezar', docs: 'Leer la documentación', viewOnGitHub: 'Ver en GitHub', copy: 'Copiar', copied: 'Copiado', prerequisites: 'Antes de empezar', steps: 'Pasos', next: 'Siguiente tarea', chooseJuror: 'Elige Juror si', chooseAlternative: 'Elige la alternativa si', statusConfirmed: 'Confirmado', statusUnknown: 'No evaluado', footer: 'Revisión multimodelo basada en evidencia para pull requests de GitHub.', editorialNotice: 'Esta traducción espera la revisión indicada en el manifiesto de rutas y no se indexa.', skipToContent: 'Saltar al contenido', homeAriaLabel: 'Inicio de Juror', primaryNavigation: 'Navegación principal', breadcrumb: 'Ruta de navegación'
  },
  ja: {
    nav: { product: '製品', solutions: 'ソリューション', resources: 'リソース', docs: 'ドキュメント', pricing: '料金' },
    typeLabel: { core: '製品ガイド', feature: '機能', solution: 'ソリューション', integration: '連携', comparison: '比較', resource: 'リソース', template: 'テンプレート', docs: 'ドキュメント', legal: '法務' },
    homeTitle: 'GitHubプルリクエストのためのAIコードレビュー・ジュリー。', overview: '概要', directAnswer: '要点', whatYouGet: 'このページの内容', implementation: '仕組み', limitations: '確認すべき制約', related: '関連コンテンツ', sources: '出典と根拠', reviewed: '最終確認日', language: '言語', install: 'GitHub に追加', cloud: '今すぐ始める', docs: 'ドキュメントを読む', viewOnGitHub: 'GitHub で見る', copy: 'コピー', copied: 'コピーしました', prerequisites: '始める前に', steps: '手順', next: '次のタスク', chooseJuror: 'Juror を選ぶ場面', chooseAlternative: '別の選択肢を選ぶ場面', statusConfirmed: '確認済み', statusUnknown: '未評価', footer: 'GitHubプルリクエスト向けの、根拠を重視したマルチモデルレビュー。', editorialNotice: 'この翻訳はルートマニフェストに記録されたレビュー待ちのため、検索には登録されません。', skipToContent: '本文へ移動', homeAriaLabel: 'Juror ホーム', primaryNavigation: 'メインナビゲーション', breadcrumb: 'パンくずリスト'
  },
  'pt-BR': {
    nav: { product: 'Produto', solutions: 'Soluções', resources: 'Recursos', docs: 'Documentação', pricing: 'Preços' },
    typeLabel: { core: 'Guia do produto', feature: 'Recurso', solution: 'Solução', integration: 'Integração', comparison: 'Comparação', resource: 'Recurso', template: 'Modelo', docs: 'Documentação', legal: 'Jurídico' },
    homeTitle: 'O júri de revisão de código por IA para pull requests do GitHub.', overview: 'Visão geral', directAnswer: 'Resposta direta', whatYouGet: 'O que esta página aborda', implementation: 'Como funciona', limitations: 'Limites importantes', related: 'Continue lendo', sources: 'Fontes e procedência', reviewed: 'Última revisão', language: 'Idioma', install: 'Adicionar ao GitHub', cloud: 'Começar', docs: 'Ler a documentação', viewOnGitHub: 'Ver no GitHub', copy: 'Copiar', copied: 'Copiado', prerequisites: 'Antes de começar', steps: 'Etapas', next: 'Próxima tarefa', chooseJuror: 'Escolha o Juror se', chooseAlternative: 'Escolha a alternativa se', statusConfirmed: 'Confirmado', statusUnknown: 'Não avaliado', footer: 'Revisão multimodelo orientada por evidências para pull requests do GitHub.', editorialNotice: 'Esta tradução aguarda a revisão registrada no manifesto de rotas e não é indexada.', skipToContent: 'Ir para o conteúdo', homeAriaLabel: 'Início do Juror', primaryNavigation: 'Navegação principal', breadcrumb: 'Trilha de navegação'
  },
};

export function pagePath(page: PageRecord, locale: Locale): string {
  return `${page.paths[locale]}/`.replace(/\/+/g, '/');
}

export function canonicalUrl(page: PageRecord, locale: Locale): string {
  return `${SITE_ORIGIN}${pagePath(page, locale)}`;
}

export function pageTitle(page: PageRecord, locale: Locale): string {
  if (locale === 'en') return PAGE_SPECS[page.id].h1;
  if (page.id === 'home') return COPY[locale].homeTitle;
  const readableSegment = decodeURIComponent(page.paths[locale].split('/').filter(Boolean).at(-1) || '')
    .replace(/[-_]/g, ' ')
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
  return `${COPY[locale].typeLabel[page.contentType]}: ${readableSegment}`;
}

export function pageDescription(page: PageRecord, locale: Locale): string {
  if (locale === 'en') return PAGE_SPECS[page.id].description;
  const name = pageTitle(page, locale);
  const templates: Record<Locale, string> = {
    en: PAGE_SPECS[page.id].description,
    de: `${name}. Praktische, quellengestützte Hinweise für einen nachvollziehbaren Juror-Workflow.`,
    fr: `${name}. Des repères pratiques et sourcés pour un workflow Juror vérifiable.`,
    es: `${name}. Orientación práctica y basada en fuentes para un flujo de trabajo Juror verificable.`,
    ja: `${name}。検証可能な Juror ワークフローのための実践的で根拠のあるガイドです。`,
    'pt-BR': `${name}. Orientações práticas e baseadas em fontes para um fluxo de trabalho Juror verificável.`,
  };
  return templates[locale];
}

export function localizedSummary(page: PageRecord, locale: Locale): string {
  if (locale === 'en') return PAGE_SPECS[page.id].summary;
  const title = pageTitle(page, locale);
  const summaries: Record<Locale, string> = {
    en: PAGE_SPECS[page.id].summary,
    de: `${title} erklärt den veröffentlichten Juror-Workflow mit nachvollziehbaren Schritten, Grenzen und weiterführenden Quellen.`,
    fr: `${title} présente le workflow Juror publié avec des étapes vérifiables, ses limites et des sources pour aller plus loin.`,
    es: `${title} explica el flujo de trabajo publicado de Juror con pasos verificables, límites y fuentes para profundizar.`,
    ja: `${title} では、公開されている Juror のワークフローを、検証可能な手順、制約、参考資料とともに説明します。`,
    'pt-BR': `${title} explica o fluxo de trabalho publicado do Juror com etapas verificáveis, limites e fontes para aprofundar.`,
  };
  return summaries[locale];
}

export function localizedFocus(page: PageRecord, locale: Locale): readonly string[] {
  if (locale === 'en') return PAGE_SPECS[page.id].focus;
  const translations: Record<Locale, readonly string[]> = {
    en: PAGE_SPECS[page.id].focus,
    de: ['Nachvollziehbarer Workflow', 'Sichere Konfiguration', 'Dokumentierte Grenzen'],
    fr: ['Workflow vérifiable', 'Configuration sûre', 'Limites documentées'],
    es: ['Flujo verificable', 'Configuración segura', 'Límites documentados'],
    ja: ['検証可能なワークフロー', '安全な設定', '文書化された制約'],
    'pt-BR': ['Fluxo verificável', 'Configuração segura', 'Limites documentados'],
  };
  return translations[locale];
}

export function isIndexable(page: PageRecord): boolean {
  return IS_INDEXABLE_RELEASE && page.localizationStatus.startsWith('approved_');
}

export function robotsFor(page: PageRecord): string {
  return isIndexable(page) ? 'index, follow' : 'noindex, nofollow';
}

export function breadcrumbItems(page: PageRecord, locale: Locale): { name: string; href: string }[] {
  const home = PAGE_BY_ID.get('home')!;
  if (page.id === home.id) return [{ name: 'Juror', href: pagePath(home, locale) }];
  const currentPath = page.paths[locale];
  const parent = PAGES
    .filter((candidate) => candidate.id !== page.id)
    .filter((candidate) => currentPath.startsWith(`${candidate.paths[locale]}/`))
    .sort((a, b) => b.paths[locale].length - a.paths[locale].length)[0];
  return [
    { name: 'Juror', href: pagePath(home, locale) },
    ...(parent && parent.id !== home.id ? [{ name: pageTitle(parent, locale), href: pagePath(parent, locale) }] : []),
    { name: pageTitle(page, locale), href: pagePath(page, locale) },
  ];
}

export function childrenOf(page: PageRecord): PageRecord[] {
  const parent = page.paths.en;
  return PAGES.filter((candidate) => {
    if (candidate.id === page.id || !candidate.paths.en.startsWith(`${parent}/`)) return false;
    return candidate.paths.en.slice(parent.length + 1).split('/').length === 1;
  });
}

export function relatedPages(page: PageRecord): PageRecord[] {
  const siblings = PAGES.filter((candidate) => candidate.contentType === page.contentType && candidate.id !== page.id);
  const featured = [PAGE_BY_ID.get('product'), PAGE_BY_ID.get('getting_started'), PAGE_BY_ID.get('resources')].filter(Boolean) as PageRecord[];
  return [...siblings, ...featured].filter((candidate, index, list) => list.findIndex((item) => item.id === candidate.id) === index).slice(0, 3);
}

export function actionWorkflow(): string {
  return `name: Juror review\non:\n  pull_request:\n    types: [opened, synchronize, reopened]\n\npermissions:\n  contents: read\n  pull-requests: write\n\njobs:\n  review:\n    if: github.event.pull_request.head.repo.fork == false\n    runs-on: ubuntu-latest\n    steps:\n      - uses: Juror-AI/juror@${ACTION_SHA}\n        with:\n          github-token: \${{ github.token }}\n          preset: balanced\n          cost-target-usd: \"4.00\"`;
}
