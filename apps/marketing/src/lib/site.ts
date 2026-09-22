import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { COMPANY_COPY, isCompanyPage } from './company';
import { POLICIES } from '../../../../shared/public-content';

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

  if (!records.length) throw new Error('The route manifest must contain at least one page record.');
  if (new Set(records.map((record: PageRecord) => record.id)).size !== records.length) {
    throw new Error('The route manifest contains duplicate page IDs.');
  }
  const paths = records.flatMap((record: PageRecord) => Object.values(record.paths));
  const expectedPathCount = records.length * LOCALES.length;
  if (paths.length !== expectedPathCount || new Set(paths).size !== paths.length || paths.some((path: string) => !path.startsWith('/'))) {
    throw new Error(`The route manifest must contain ${expectedPathCount} unique absolute locale paths.`);
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
  home: spec('Open-source AI code review you can inspect—and afford.', 'Use the models you choose, keep the workflow in your repository, and pay providers directly.', 'Juror is the open-source GitHub Action for teams that want serious AI code review without black-box credits, per-seat markups, or a permanent codebase index.', ['Your models and keys', 'One deduplicated review', 'A cost receipt you can audit'], 'Add Juror to GitHub'),
  ai_code_review: spec('AI code review without the black box.', 'Several independent reviewers, one evidence-backed result, and no proprietary credit system.', 'Juror gives every pull request a transparent first pass: configured models inspect a sealed checkout, duplicate reports are collapsed, and the result links back to the evidence.', ['Inspect the workflow', 'Keep humans in charge', 'Measure on your own pull requests'], 'Install on GitHub'),
  product: spec('Your pull request deserves more than one model’s opinion.', 'Juror runs independent reviewers, removes duplicate noise, and leaves a single review your team can act on.', 'Use Juror when one opaque agent is not enough. The action, prompts, model choices, and result-merging logic are open source and live with your code.', ['Choose the reviewers', 'Keep every finding traceable', 'See what the review cost'], 'View setup'),
  agent: spec('An AI review agent that works for your team—not around it.', 'Juror gives each pull request independent model reviews, then returns one evidence-backed result in GitHub.', 'Juror is an open-source review agent for GitHub pull requests. It works from a sealed checkout, leaves the merge decision with your team, and makes every review path inspectable.', ['Works in GitHub pull requests', 'Uses independent model harnesses', 'Keeps the final decision human'], 'Add Juror to GitHub'),
  cli: spec('Catch review issues before the pull request exists.', 'Run Juror locally against your branch with the same open-source workflow you use in GitHub.', 'The Juror CLI makes a local, inspectable review loop possible: choose a preset, review the findings, fix the code, and open a pull request with fewer surprises.', ['Review a local branch', 'Use your provider keys', 'Keep results in your terminal'], 'Install the CLI'),
  independence: spec('Independent models catch different things.', 'Juror asks several model families to review the same change separately, then publishes one deduplicated result.', 'A model should not be the only judge of its own work. Juror keeps reviewers independent until their observations are anchored, clustered, and checked before a human-readable review is published.', ['Independent perspectives', 'Conservative consensus', 'One review for the author'], 'Choose a preset'),
  knowledge_base: spec('Repository context without a vendor-owned knowledge base.', 'Juror gives reviewers scoped access to the checkout and configured tools without building a permanent index of your codebase.', 'Good review needs context; it does not require a standing copy of your repository in a proprietary system. Juror works from the review checkout, makes its boundaries explicit, and keeps context under your workflow.', ['Context from the checkout', 'No standing repository index', 'Explicit review boundaries'], 'Read configuration'),
  how_it_works: spec('How Juror turns many model reviews into one useful review.', 'Follow the five stages from isolated checkout to an evidence-backed GitHub review.', 'The workflow is deliberately narrow: collect independent observations, align them to the diff, collapse overlap, and make uncertainty visible.', ['Isolate the review context', 'Anchor and cluster findings', 'Verify agreement before publishing'], 'Read configuration'),
  github_ai_code_review: spec('Multi-model AI code review, installed as a GitHub Action.', 'Install a SHA-pinned action with least-privilege permissions and visible output.', 'Juror runs in the pull-request workflow you already use. The workflow should be pinned, scoped to safe events, and explicit about provider credentials.', ['Copy a pinned workflow', 'Keep credentials out of forks', 'Read the posted review'], 'Add action'),
  multi_model_code_review: spec('More than one model. Less repeated feedback.', 'Use independent model perspectives while returning one coherent pull-request review.', 'Multiple reviewers can broaden a first pass; they do not make a finding true by vote alone. Juror exposes model evidence and removes repeated observations.', ['Independent perspectives', 'One merged finding', 'Clear trade-offs'], 'Choose a preset'),
  consensus_code_review: spec('Use agreement as a precision control.', 'Tune Juror for high recall or agreement with a visible refutation step.', 'Consensus is a publishing control, not a guarantee. Use it when reducing noisy comments matters more than surfacing every uncertain lead.', ['Recall versus agreement', 'Refutation before publish', 'Severity remains explicit'], 'Configure consensus'),
  transparent_ai_code_review_costs: spec('See what every review costs.', 'Inspect provider-reported or estimated cost beside the pull-request result.', 'Review cost depends on the configured models, changed scope, tool use, and provider billing. Juror reports coverage rather than treating unknown cost as zero.', ['Model and token drivers', 'Reported versus estimated', 'Per-review budget controls'], 'Run a review'),
  security_review: spec('AI code review with security boundaries you can inspect.', 'Run Juror in a least-privilege GitHub workflow that keeps secrets out of untrusted forks and review context scoped.', 'Juror is not a replacement for dedicated security scanning. It is an open-source AI review workflow with explicit checkout, permission, provider-key, and fork boundaries that teams can audit.', ['Sealed reviewer checkout', 'Fork-safe workflow policy', 'Explicit security limits'], 'Read security notes'),
  post_merge_qa: spec('Validate the live journey after the merge.', 'An optional browser-QA loop with sealed evidence and synthetic-account boundaries.', 'Post-merge QA is separate from code review. It can validate an approved deployment journey when prerequisites, synthetic identity, and evidence handling are explicit.', ['Choose a deployment', 'Use a synthetic session', 'Keep a sealed evidence ledger'], 'Read QA quickstart'),
  benchmarks: spec('Don’t buy AI code review on a leaderboard claim.', 'Run reproducible evaluations on real pull requests, with misses, noise, cost, and source material visible.', 'Juror publishes the ingredients of an honest comparison: an adjudicated corpus, an explicit protocol, per-case output, and the limits of the result.', ['Adjudicated corpus', 'Misses and false positives', 'Cost and latency coverage'], 'Inspect the corpus'),
  examples: spec('Read the review before you install it.', 'Inspect reproducible examples of findings, deduplication, disagreement, and receipts.', 'Examples are useful only when they preserve context and label their evidence. Review the finding lifecycle before using examples as a product claim.', ['A bug found', 'Duplicates collapsed', 'A consensus refutation'], 'Install Juror'),
  pricing: spec('No seats. No credits. No surprise markup.', 'Juror is MIT-licensed. Bring the model accounts you already use and see the review cost beside the result.', 'The Juror Action and CLI cost nothing to use. Your provider charges are separate and visible, so you can choose models, set a budget, and stop paying for a reseller’s opaque unit.', ['MIT-licensed software', 'Direct provider billing', 'Visible cost coverage'], 'Get started'),
  security: spec(POLICIES.security.title, POLICIES.security.summary, POLICIES.security.summary, []),
  open_source: spec('AI code review that belongs to the people using it.', 'Juror is MIT-licensed, configurable in your repository, and designed to leave maintainers with evidence instead of vendor lock-in.', 'Open source is more than a free tier. Juror lets you inspect the review logic, choose the models, contribute improvements, and keep provider relationships in your own name.', ['MIT license', 'Configuration in Git', 'No proprietary credits'], 'Add to an OSS repo'),
  careers: spec('Help build the open-source review workflow.', 'Juror is built in public; the source, issues, and discussion are the place to see how the project is moving.', 'There are no invented hiring claims here. If you want to help make AI code review more accountable, start by inspecting the source, opening an issue, or contributing a tested improvement.', ['Public source', 'Open issues and discussions', 'Contributions with evidence'], 'Explore the source'),
  design: spec('Designed to make an AI review easy to challenge.', 'Juror presents the evidence, uncertainty, and cost behind a finding so engineers can make a decision quickly.', 'The design principle is simple: a review result should be easier to inspect than to trust blindly. Findings stay anchored, overlap is made visible, and uncertainty is not hidden behind decoration.', ['Readable findings', 'Visible uncertainty', 'Evidence before persuasion'], 'See examples'),
  changelog: spec('Every release, explained.', 'Versioned release notes, migration context, and links to the source release.', 'Product changes should be understandable at the point of upgrade. Juror releases are tied to source history rather than a generic marketing timeline.', ['Release provenance', 'Migration notes', 'GitHub release links'], 'View GitHub'),
  about: spec(COMPANY_COPY.en.titles.about, COMPANY_COPY.en.summaries.about, COMPANY_COPY.en.summaries.about, []),
  founders: spec(COMPANY_COPY.en.titles.founders, COMPANY_COPY.en.summaries.founders, COMPANY_COPY.en.summaries.founders, []),
  contact: spec(COMPANY_COPY.en.titles.contact, COMPANY_COPY.en.summaries.contact, COMPANY_COPY.en.summaries.contact, []),
  privacy: spec(POLICIES.privacy.title, POLICIES.privacy.summary, POLICIES.privacy.summary, []),
  terms: spec(POLICIES.terms.title, POLICIES.terms.summary, POLICIES.terms.summary, []),
  imprint: spec(POLICIES.imprint.title, COMPANY_COPY.en.summaries.imprint, POLICIES.imprint.summary, []),
  features: spec('Juror features for clearer pull-request decisions', 'Explore the review controls that turn several model outputs into one auditable result.', 'Each feature is designed around a concrete decision: what evidence to collect, what to merge, what to publish, and what to leave to the reviewer.', ['Review architecture', 'Decision controls', 'Documented limits'], 'View product'),
  parallel_model_review: spec('Parallel model review for pull requests', 'Run supported harnesses independently against a sealed checkout.', 'Parallel review increases perspective, not certainty. Keep the configured model set visible and weigh timing, cost, and review quality together.', ['Supported harnesses', 'Independent checkout', 'Time and cost trade-offs'], 'Choose a preset'),
  deduplicated_findings: spec('One bug should produce one finding.', 'Collapse exact and similar reports without losing evidence or coverage.', 'A useful review must preserve each reviewer observation while returning a human-readable decision. Juror uses anchors, similarity, and a referee stage to do that.', ['Anchor to the diff', 'Cluster overlap', 'Audit coverage'], 'See examples'),
  merge_confidence: spec('A merge score with its reasoning attached.', 'Read the inputs and limits behind a merge-confidence signal.', 'A score is context, not an approval. Juror keeps severe findings, model votes, and rationale visible so people can decide what ships.', ['Severity cap', 'Visible votes', 'Not an autonomous merge'], 'Read configuration'),
  consensus_mode: spec('Tune review for recall or agreement.', 'Choose a publication mode that matches the risk and noise tolerance of your team.', 'Consensus mode changes what is published after a review, not what your team must verify. The refutation stage and source evidence remain part of the result.', ['High-recall mode', 'Agreement mode', 'Recommended use cases'], 'Configure consensus'),
  cost_receipts: spec('No mystery AI review bill.', 'Keep provider cost coverage and budget controls attached to the review.', 'Cost receipts distinguish provider-reported values, estimates, partial coverage, and unknowns. That makes a budget conversation possible without false precision.', ['Source labeling', 'Coverage caveats', 'Budget controls'], 'Read cost controls'),
  repository_context_without_indexing: spec('Repository context without a standing index.', 'Use read and search tools without creating a permanent semantic index of the repository.', 'Juror works from the review checkout and configured tools. This avoids a standing repository index while making scope and context limits explicit.', ['Read and search tools', 'No standing index', 'Context boundaries'], 'Read security notes'),
  post_merge_browser_qa: spec('A controlled post-merge browser QA loop.', 'Validate an approved deployment with a synthetic session and sealed evidence.', 'Browser QA must be bounded. Juror supports deliberate deployment selection, synthetic identity, and a no-reset mode that keeps evidence traceable.', ['Deployment selection', 'Sealed evidence', 'Exact limitations'], 'Read QA quickstart'),
  solutions: spec('Code-review workflows for the way your team ships.', 'Choose a Juror workflow by team, risk profile, and delivery path.', 'The right review workflow is operational rather than generic. Start with the problem you need to reduce, then keep humans, tests, and release checks in the loop.', ['Audience selection', 'Workflow boundaries', 'Evidence handoffs'], 'Explore solutions'),
  enterprise: spec('Open-source AI review for teams that need control.', 'Keep review policy, model choice, cost, and evidence visible in the GitHub workflow your organization already governs.', 'Juror does not hide an enterprise pitch behind vague compliance promises. It gives platform and security teams an inspectable Action and CLI they can evaluate against their own controls.', ['Repository-owned configuration', 'Direct provider relationships', 'Auditable review artifacts'], 'Read the security notes'),
  review_ai_generated_code: spec('Review code generated at AI speed.', 'A policy-led first review for larger, faster-changing pull requests.', 'Generated code can change the volume of review work; it does not remove the need to verify behavior, security, tests, and rollout conditions.', ['Generated-code checklist', 'Risk-based review policy', 'Human verification'], 'Read the guide'),
  github_actions_code_review: spec('Add an AI review gate to GitHub Actions.', 'Connect a SHA-pinned review action to a least-privilege pull-request workflow.', 'A review action belongs alongside CI, not in place of it. Pin the action, set safe fork conditions, and keep the review output accountable to humans.', ['Event flow', 'Pinned action', 'Fork safety'], 'Copy workflow'),
  engineering_teams: spec('Give engineering teams a shared first review.', 'Create a consistent first-pass review without replacing ownership or discussion.', 'Juror can reduce repetitive review work when teams agree on how findings, merge confidence, and exceptions are handled.', ['Reviewer roles', 'Noise reduction', 'Rollout plan'], 'View product'),
  platform_engineering: spec('A configurable review layer for platform teams.', 'Centralize policy while keeping repositories explicit about models, cost, and safe workflows.', 'Platform teams can offer a review baseline without hiding how it works. Keep provider policy, workflow configuration, and audit artifacts visible.', ['Shared workflow template', 'Provider policy', 'Cost artifacts'], 'Read configuration'),
  open_source_maintainers: spec('Spend maintainer time where it matters.', 'Use a transparent first pass for contributor pull requests without weakening fork safety.', 'Maintainers need triage help, not an opaque replacement for judgment. Set conditions that protect secrets and leave the final decision with project owners.', ['Safe pull-request events', 'Triage support', 'Issue templates'], 'Read security notes'),
  startups: spec('Ship quickly without guessing at review cost.', 'Start with a small, inspectable multi-model review loop.', 'Small teams can use independent review perspectives while keeping spend, operational limits, and human ownership explicit from the first workflow.', ['Fast setup', 'Budget controls', 'Transparent limits'], 'Get started'),
  monorepo_pull_requests: spec('Review changes that reach beyond one file.', 'Use scoped repository context to reason about cross-file changes without pretending every risk is known.', 'Monorepo review needs a clear changed-file scope and useful context. Tests and domain owners remain essential for verifying broader system behavior.', ['Cross-file reasoning', 'Changed-file scope', 'Human and test boundaries'], 'Read the guide'),
  post_merge_quality: spec('Close the loop after merge.', 'Pair pull-request review with optional, bounded post-merge journey validation.', 'Code review and deployment validation answer different questions. Keep the transition explicit and use synthetic QA only where an approved environment supports it.', ['Review before merge', 'Synthetic post-merge QA', 'Release checklist'], 'Read QA quickstart'),
  integrations: spec('Use Juror in the GitHub review workflow.', 'See released GitHub integration paths and supported provider configurations.', 'Juror focuses on GitHub pull-request review. Provider and model configuration is distinct from a source-control integration and must reflect released support.', ['GitHub workflow', 'Action installation', 'Provider configuration'], 'Read documentation'),
  partners: spec('Build a more accountable AI review workflow together.', 'Juror is open source and integrates through the GitHub workflow, provider configuration, and a hosted MCP endpoint.', 'There is no invented partner directory or certification program. Teams that want to integrate, evaluate, or contribute can start from the published interfaces and source instead of a closed sales process.', ['GitHub Action', 'Provider configuration', 'MCP integration'], 'Read integrations'),
  github: spec('Juror for GitHub pull requests.', 'Install Juror into the GitHub pull-request workflow with clear permissions and output.', 'Juror posts a merged review to the pull request after independent harnesses have completed. The action should be pinned and its permissions kept minimal.', ['Marketplace path', 'Trigger configuration', 'Sample review output'], 'View setup'),
  github_actions: spec('A GitHub Action for multi-model review.', 'Configure an auditable multi-model review workflow in GitHub Actions.', 'The workflow is ordinary YAML: use a verified action SHA, minimal permissions, protected secrets, and a pull-request event policy that accounts for forks.', ['Pinned YAML', 'Secret handling', 'Troubleshooting steps'], 'Copy workflow'),
  codex: spec('Use Codex in a Juror review preset.', 'Configure the released Codex harness in a Juror preset without implying affiliation.', 'The available harness and model identifiers must match the released Juror configuration. Model capabilities and availability are provider-controlled and can change.', ['Released harness', 'Preset selection', 'Version caveats'], 'Read presets'),
  chatgpt_plugin: spec('Use Juror in ChatGPT and Codex.', 'Inspect concise multi-model PR findings and safely start a Juror Cloud review after explicit confirmation.', 'The Juror Plugin connects to hosted Juror Cloud through OAuth. It is not a local-repository agent: it exposes only workspace-scoped review metadata and does not return raw diffs, source checkouts, reports, artifacts, screenshots, credentials, or prompt text.', ['Choose a workspace', 'Inspect minimal review summaries', 'Confirm hosted review starts'], 'Connect Juror'),
  mcp: spec('Connect Juror through MCP.', 'Use Juror’s OAuth-protected Streamable HTTP endpoint for review triage and explicitly confirmed hosted reviews.', 'Connect directly to the Juror MCP endpoint, authenticate with Juror Cloud, list workspaces, and choose one before inspecting findings or runs. The endpoint runs hosted Juror Cloud, not arbitrary local repositories.', ['Streamable HTTP endpoint', 'OAuth workspace access', 'Minimal data boundary'], 'Read MCP setup'),
  claude: spec('Use Claude in a Juror review preset.', 'Configure the released Claude harness in a Juror preset without implying affiliation.', 'Use the harness and version spec supported by the current release. Provider behavior, availability, and billing remain subject to the provider.', ['Released harness', 'Preset selection', 'Version caveats'], 'Read presets'),
  openrouter: spec('Configure a starter multi-model preset with OpenRouter.', 'Use a provider key with explicit cost and security boundaries.', 'The starter preset is opt-in and should be benchmarked before it is promoted. Keep provider credentials in repository secrets, never in the configuration body.', ['Provider requirements', 'Key handling', 'Cost caveats'], 'Read presets'),
  compare: spec('Compare AI code review approaches.', 'Use an evidence-first framework for evaluating AI review tools and workflows.', 'A comparison is useful when it names its evidence, version date, unknowns, and buyer context. Do not compress unlike products into a single score.', ['Decision criteria', 'Source freshness', 'Workflow fit'], 'Read the guide'),
  juror_vs_greptile: spec('Juror vs Greptile: own your AI review stack.', 'Juror is the open-source alternative for teams that want direct model billing and an inspectable review workflow.', 'Greptile sells a hosted, credit-based code-review service. Juror is an MIT-licensed Action and CLI that lets you bring your own providers, inspect the pipeline, and keep the result in your GitHub workflow.', ['Open source versus hosted service', 'Direct provider cost versus credits', 'Inspectable workflow'], 'Compare the workflows'),
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
  reports: spec('Reports for teams evaluating AI code review.', 'Practical research notes and evaluation guides for deciding what an AI reviewer should be trusted to do.', 'A report is useful when it exposes its method, evidence, and limits. Juror’s research materials focus on reproducible review evaluation rather than vendor-controlled claims.', ['Evaluation methods', 'Open evidence', 'Decision frameworks'], 'Browse resources'),
  state_of_ai_coding: spec('The state of AI coding: the validation bottleneck moved.', 'AI can produce more pull requests than a team can safely review; the next constraint is evidence, ownership, and release confidence.', 'The useful question is no longer whether AI writes code. It is whether the review process can keep up without turning every merge decision into a black-box judgment or a growing credit bill.', ['AI code volume', 'Review capacity', 'Evidence-led validation'], 'Read the guide'),
  ai_code_review_leaderboard: spec('Evaluate AI code review beyond a leaderboard.', 'Compare reviewers on representative pull requests with visible cases, misses, false positives, cost, and configuration.', 'A single rank is not a buying decision. Juror provides a scorecard approach so teams can evaluate the workflow they will actually run, with source material they can inspect.', ['Representative cases', 'False-positive accounting', 'Reproducible configuration'], 'Read benchmarking'),
  customer_stories: spec('Evidence before customer-logo theater.', 'Juror will publish customer stories only when the customer, conditions, and evidence can be named and checked.', 'Until then, the source code, benchmark corpus, examples, and release history are the honest way to evaluate Juror. A logo wall cannot tell you whether an AI reviewer will work on your pull requests.', ['Public source', 'Reproducible examples', 'Benchmark evidence'], 'Inspect the evidence'),
  podcast: spec('Conversations about accountable AI code review.', 'The ideas behind Juror live in public source, issue discussions, documentation, and release notes—not an invented episode catalog.', 'If you want to understand how Juror works today, start with the material that changes with the product: the repository, documentation, benchmarks, and public issues.', ['Source discussions', 'Release notes', 'Technical documentation'], 'Read the docs'),
  review_standards: spec('Set standards for AI review without training a black box.', 'Put review rules, escalation paths, and exceptions in versioned configuration and pull-request policy.', 'Teams do not need a vendor to silently learn their preferences. Juror lets teams make review expectations explicit, reviewable, and changeable alongside the code they apply to.', ['Versioned policy', 'Visible exceptions', 'Human ownership'], 'Use the policy template'),
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

type LocalizedLandingSpec = Partial<Pick<PageSpec, 'h1' | 'description' | 'summary' | 'focus'>>;
const LOCALIZED_LANDING_SPECS: Partial<Record<string, Partial<Record<Locale, LocalizedLandingSpec>>>> = {
  security_review: {
    de: { h1: 'KI-Code-Review mit überprüfbaren Sicherheitsgrenzen.', description: 'Führe Juror mit minimalen GitHub-Berechtigungen aus und halte Secrets von nicht vertrauenswürdigen Forks fern.', summary: 'Juror ersetzt keinen Sicherheitsscanner. Der Open-Source-Workflow macht Checkout, Berechtigungen, Provider-Schlüssel und Fork-Regeln überprüfbar.', focus: ['Abgeschotteter Review-Checkout', 'Fork-sichere Regeln', 'Klare Sicherheitsgrenzen'] },
    fr: { h1: 'Une revue de code IA aux frontières de sécurité vérifiables.', description: 'Exécutez Juror avec des permissions GitHub minimales et protégez les secrets des forks non fiables.', summary: 'Juror ne remplace pas un scanner de sécurité. Son workflow open source rend le checkout, les permissions, les clés et les règles de fork vérifiables.', focus: ['Checkout isolé', 'Règles sûres pour les forks', 'Limites explicites'] },
    es: { h1: 'Revisión de código con IA y límites de seguridad verificables.', description: 'Ejecute Juror con permisos mínimos de GitHub y mantenga los secretos fuera de forks no confiables.', summary: 'Juror no sustituye un escáner de seguridad. Su flujo abierto permite auditar el checkout, los permisos, las claves y las reglas para forks.', focus: ['Checkout aislado', 'Reglas seguras para forks', 'Límites explícitos'] },
    ja: { h1: '検証できるセキュリティ境界を備えたAIコードレビュー。', description: '最小権限のGitHubワークフローでJurorを実行し、信頼できないフォークからシークレットを守ります。', summary: 'Jurorは専用のセキュリティスキャナーを置き換えるものではありません。オープンソースのワークフローにより、チェックアウト、権限、キー、フォーク規則を監査できます。', focus: ['隔離されたレビュー環境', 'フォークに安全な規則', '明示的な制約'] },
    'pt-BR': { h1: 'Revisão de código com IA e limites de segurança verificáveis.', description: 'Execute o Juror com permissões mínimas do GitHub e mantenha segredos fora de forks não confiáveis.', summary: 'O Juror não substitui um scanner de segurança. Seu fluxo aberto torna checkout, permissões, chaves e regras de fork auditáveis.', focus: ['Checkout isolado', 'Regras seguras para forks', 'Limites explícitos'] },
  },
  enterprise: {
    de: { h1: 'Open-Source-KI-Review für Teams mit Kontrollbedarf.', description: 'Halte Richtlinien, Modellauswahl, Kosten und Evidenz im GitHub-Workflow deiner Organisation sichtbar.', summary: 'Juror versteckt kein Enterprise-Versprechen hinter vagen Compliance-Behauptungen. Teams können Action und CLI gegen ihre eigenen Kontrollen prüfen.', focus: ['Konfiguration im Repository', 'Direkte Provider-Beziehung', 'Prüfbare Artefakte'] },
    fr: { h1: 'Une revue IA open source pour les équipes qui ont besoin de contrôle.', description: 'Gardez les règles, les modèles, les coûts et les preuves visibles dans le workflow GitHub de votre organisation.', summary: 'Juror ne masque pas une promesse entreprise derrière des affirmations vagues. Les équipes peuvent évaluer l’Action et la CLI selon leurs contrôles.', focus: ['Configuration dans le dépôt', 'Fournisseurs directs', 'Artefacts auditables'] },
    es: { h1: 'Revisión de IA abierta para equipos que necesitan control.', description: 'Mantenga políticas, modelos, costes y evidencia visibles en el flujo de GitHub de su organización.', summary: 'Juror no oculta una promesa empresarial tras afirmaciones vagas. Los equipos pueden evaluar la Action y la CLI con sus propios controles.', focus: ['Configuración en el repositorio', 'Proveedores directos', 'Artefactos auditables'] },
    ja: { h1: '制御を必要とするチームのためのオープンソースAIレビュー。', description: '組織のGitHubワークフローで、ポリシー、モデル、コスト、根拠を可視化します。', summary: 'Jurorは曖昧な企業向けの約束を隠しません。チームは自らの統制に照らしてActionとCLIを評価できます。', focus: ['リポジトリ内の設定', 'プロバイダーとの直接関係', '監査可能な成果物'] },
    'pt-BR': { h1: 'Revisão com IA aberta para equipes que precisam de controle.', description: 'Mantenha política, modelos, custos e evidências visíveis no fluxo do GitHub da organização.', summary: 'O Juror não esconde uma promessa empresarial em alegações vagas. As equipes podem avaliar a Action e a CLI com seus próprios controles.', focus: ['Configuração no repositório', 'Provedores diretos', 'Artefatos auditáveis'] },
  },
  reports: {
    de: { h1: 'Berichte für Teams, die KI-Code-Review bewerten.', description: 'Praxisnahe Forschungsnotizen und Bewertungsleitfäden für fundierte Entscheidungen.', summary: 'Ein Bericht ist nützlich, wenn Methode, Evidenz und Grenzen sichtbar sind. Juror konzentriert sich auf reproduzierbare Bewertung statt Anbieterbehauptungen.', focus: ['Bewertungsmethoden', 'Offene Evidenz', 'Entscheidungsrahmen'] },
    fr: { h1: 'Des rapports pour évaluer la revue de code IA.', description: 'Des notes de recherche et guides pratiques pour décider avec rigueur.', summary: 'Un rapport est utile lorsque sa méthode, ses preuves et ses limites sont visibles. Juror privilégie une évaluation reproductible aux promesses d’un fournisseur.', focus: ['Méthodes d’évaluation', 'Preuves ouvertes', 'Cadres de décision'] },
    es: { h1: 'Informes para equipos que evalúan revisión de código con IA.', description: 'Notas de investigación y guías prácticas para decisiones fundamentadas.', summary: 'Un informe sirve cuando muestra método, evidencia y límites. Juror se centra en evaluación reproducible, no en promesas de proveedores.', focus: ['Métodos de evaluación', 'Evidencia abierta', 'Marcos de decisión'] },
    ja: { h1: 'AIコードレビューを評価するチームのためのレポート。', description: '根拠ある意思決定のための実践的な調査ノートと評価ガイドです。', summary: '手法、根拠、制約が見えるレポートに価値があります。Jurorはベンダー主導の主張ではなく、再現可能な評価を重視します。', focus: ['評価手法', '公開された根拠', '意思決定の枠組み'] },
    'pt-BR': { h1: 'Relatórios para equipes que avaliam revisão de código com IA.', description: 'Notas de pesquisa e guias práticos para decisões fundamentadas.', summary: 'Um relatório é útil quando método, evidência e limites estão visíveis. O Juror prioriza avaliação reproduzível, não promessas de fornecedores.', focus: ['Métodos de avaliação', 'Evidência aberta', 'Estruturas de decisão'] },
  },
  state_of_ai_coding: {
    de: { h1: 'Der Stand des KI-Codings: Validierung ist der Engpass.', description: 'KI erzeugt mehr Pull Requests, als Teams sicher prüfen können; der Engpass sind Evidenz, Ownership und Merge-Vertrauen.', summary: 'Die Frage ist nicht mehr, ob KI Code schreibt. Entscheidend ist, ob Review ohne Black Box oder Kostenfalle mithalten kann.', focus: ['Mehr Code-Änderungen', 'Review-Kapazität', 'Evidenzbasierte Validierung'] },
    fr: { h1: 'L’état du code IA : la validation est devenue le goulot d’étranglement.', description: 'L’IA produit plus de pull requests qu’une équipe ne peut relire en sécurité ; le défi est la preuve, la responsabilité et la confiance avant fusion.', summary: 'La question n’est plus de savoir si l’IA écrit du code, mais si la revue peut suivre sans devenir une boîte noire ou une facture opaque.', focus: ['Volume de changements', 'Capacité de revue', 'Validation fondée sur des preuves'] },
    es: { h1: 'El estado de la programación con IA: validar es el cuello de botella.', description: 'La IA produce más pull requests de los que un equipo puede revisar con seguridad; el reto es evidencia, responsabilidad y confianza al fusionar.', summary: 'La pregunta ya no es si la IA escribe código, sino si la revisión puede seguir el ritmo sin convertirse en una caja negra o una factura opaca.', focus: ['Más cambios', 'Capacidad de revisión', 'Validación basada en evidencia'] },
    ja: { h1: 'AIコーディングの現状：ボトルネックは検証へ移りました。', description: 'AIが生むプルリクエストは安全にレビューできる量を超えています。課題は根拠、責任、マージへの信頼です。', summary: 'AIがコードを書くかどうかはもはや問題ではありません。ブラックボックスや不透明な請求にせず、レビューが追随できるかが重要です。', focus: ['増える変更量', 'レビュー能力', '根拠に基づく検証'] },
    'pt-BR': { h1: 'O estado da codificação com IA: validar virou o gargalo.', description: 'A IA produz mais pull requests do que uma equipe pode revisar com segurança; o desafio é evidência, responsabilidade e confiança no merge.', summary: 'A questão não é mais se a IA escreve código, mas se a revisão acompanha sem virar uma caixa-preta ou uma conta opaca.', focus: ['Mais mudanças', 'Capacidade de revisão', 'Validação baseada em evidências'] },
  },
  careers: {
    de: { h1: 'Hilf mit, den Open-Source-Review-Workflow zu bauen.', description: 'Juror entsteht öffentlich; im Quellcode, in Issues und Diskussionen ist sichtbar, wohin sich das Projekt bewegt.', summary: 'Hier stehen keine erfundenen Stellenversprechen. Wer KI-Code-Review nachvollziehbarer machen will, kann den Code prüfen, ein Issue eröffnen oder eine getestete Verbesserung beitragen.', focus: ['Öffentlicher Quellcode', 'Offene Issues und Diskussionen', 'Beiträge mit Evidenz'] },
    fr: { h1: 'Contribuez au workflow de revue open source.', description: 'Juror est construit en public : le code, les issues et les discussions montrent l’avancée du projet.', summary: 'Cette page ne contient aucune promesse d’embauche inventée. Pour rendre la revue de code IA plus responsable, examinez le code, ouvrez une issue ou proposez une amélioration testée.', focus: ['Code source public', 'Issues et discussions ouvertes', 'Contributions étayées'] },
    es: { h1: 'Ayuda a construir el flujo de revisión abierto.', description: 'Juror se desarrolla en público; el código, los issues y las conversaciones muestran cómo avanza el proyecto.', summary: 'Aquí no hay promesas de contratación inventadas. Para hacer más responsable la revisión con IA, revise el código, abra un issue o contribuya una mejora probada.', focus: ['Código público', 'Issues y conversaciones abiertas', 'Contribuciones con evidencia'] },
    ja: { h1: 'オープンソースのレビューワークフローを一緒に作りましょう。', description: 'Jurorは公開で開発されています。ソース、Issue、議論からプロジェクトの進み方を確認できます。', summary: '架空の採用情報は載せません。AIコードレビューの説明責任を高めたい方は、ソースを確認し、Issueを開くか、テスト済みの改善を提案してください。', focus: ['公開ソース', '公開Issueと議論', '根拠のある貢献'] },
    'pt-BR': { h1: 'Ajude a criar o fluxo de revisão open source.', description: 'O Juror é construído em público; código, issues e discussões mostram para onde o projeto vai.', summary: 'Não há promessas de contratação inventadas aqui. Para tornar a revisão de código com IA mais responsável, examine o código, abra uma issue ou contribua com uma melhoria testada.', focus: ['Código público', 'Issues e discussões abertas', 'Contribuições com evidências'] },
  },
  design: {
    de: { h1: 'Entworfen, damit sich KI-Reviews hinterfragen lassen.', description: 'Juror zeigt Evidenz, Unsicherheit und Kosten eines Befunds, damit Teams schnell entscheiden können.', summary: 'Ein Reviewergebnis soll leichter zu prüfen sein, als ihm blind zu vertrauen. Befunde bleiben verankert, Überschneidungen sichtbar und Unsicherheit wird nicht versteckt.', focus: ['Lesbare Befunde', 'Sichtbare Unsicherheit', 'Evidenz vor Überredung'] },
    fr: { h1: 'Conçu pour remettre en question une revue IA.', description: 'Juror présente les preuves, l’incertitude et le coût d’un signalement pour permettre une décision rapide.', summary: 'Un résultat de revue doit être plus facile à examiner qu’à croire aveuglément. Les constats restent ancrés, les recouvrements visibles et l’incertitude n’est pas masquée.', focus: ['Constats lisibles', 'Incertitude visible', 'Preuve avant persuasion'] },
    es: { h1: 'Diseñado para cuestionar una revisión con IA.', description: 'Juror muestra evidencia, incertidumbre y coste detrás de cada hallazgo para que los equipos decidan rápido.', summary: 'Un resultado de revisión debe ser más fácil de inspeccionar que de creer a ciegas. Los hallazgos permanecen anclados, los solapamientos se ven y la incertidumbre no se oculta.', focus: ['Hallazgos legibles', 'Incertidumbre visible', 'Evidencia antes que persuasión'] },
    ja: { h1: 'AIレビューを検証しやすくするデザイン。', description: 'Jurorは指摘の根拠、不確実性、コストを示し、エンジニアが素早く判断できるようにします。', summary: 'レビュー結果は盲信するより検査しやすいべきです。指摘は根拠に結び付き、重複が見え、不確実性も隠しません。', focus: ['読みやすい指摘', '見える不確実性', '説得より根拠'] },
    'pt-BR': { h1: 'Feito para questionar uma revisão com IA.', description: 'O Juror mostra evidência, incerteza e custo por trás de cada achado para que equipes decidam rápido.', summary: 'Um resultado de revisão deve ser mais fácil de inspecionar do que de confiar cegamente. Achados ficam ancorados, sobreposições são visíveis e a incerteza não é escondida.', focus: ['Achados legíveis', 'Incerteza visível', 'Evidência antes de persuasão'] },
  },
  partners: {
    de: { h1: 'Gemeinsam einen nachvollziehbaren KI-Review-Workflow bauen.', description: 'Juror ist Open Source und lässt sich über GitHub, Provider-Konfiguration und einen gehosteten MCP-Endpunkt integrieren.', summary: 'Es gibt kein erfundenes Partnerverzeichnis oder Zertifizierungsprogramm. Teams können die veröffentlichten Schnittstellen und den Quellcode nutzen, um zu integrieren, zu bewerten oder beizutragen.', focus: ['GitHub Action', 'Provider-Konfiguration', 'MCP-Integration'] },
    fr: { h1: 'Construisons ensemble une revue IA plus responsable.', description: 'Juror est open source et s’intègre via GitHub, la configuration des fournisseurs et un point de terminaison MCP hébergé.', summary: 'Il n’existe ni annuaire de partenaires ni programme de certification inventé. Les équipes peuvent s’appuyer sur les interfaces publiées et le code source pour intégrer, évaluer ou contribuer.', focus: ['GitHub Action', 'Configuration des fournisseurs', 'Intégration MCP'] },
    es: { h1: 'Construyamos juntos una revisión con IA más responsable.', description: 'Juror es abierto y se integra mediante GitHub, configuración de proveedores y un endpoint MCP alojado.', summary: 'No hay directorio de socios ni programa de certificación inventados. Los equipos pueden usar las interfaces publicadas y el código para integrar, evaluar o contribuir.', focus: ['GitHub Action', 'Configuración de proveedores', 'Integración MCP'] },
    ja: { h1: '説明可能なAIレビューワークフローを共に作る。', description: 'Jurorはオープンソースで、GitHub、プロバイダー設定、ホスト型MCPエンドポイントを通じて連携できます。', summary: '架空のパートナー一覧や認定制度はありません。チームは公開インターフェースとソースを利用して、連携、評価、貢献を始められます。', focus: ['GitHub Action', 'プロバイダー設定', 'MCP連携'] },
    'pt-BR': { h1: 'Vamos criar juntos uma revisão de IA mais responsável.', description: 'O Juror é open source e integra pelo GitHub, pela configuração de provedores e por um endpoint MCP hospedado.', summary: 'Não há diretório de parceiros ou programa de certificação inventados. Equipes podem usar interfaces publicadas e o código para integrar, avaliar ou contribuir.', focus: ['GitHub Action', 'Configuração de provedores', 'Integração MCP'] },
  },
  ai_code_review_leaderboard: {
    de: { h1: 'KI-Code-Review bewerten – jenseits einer Rangliste.', description: 'Vergleiche Reviewer anhand repräsentativer Pull Requests mit sichtbaren Fällen, Fehlalarmen, Kosten und Konfiguration.', summary: 'Ein einzelner Rang ist keine Kaufentscheidung. Juror bietet eine Scorecard, mit der Teams den tatsächlichen Workflow und sein überprüfbares Material bewerten können.', focus: ['Repräsentative Fälle', 'Erfassung von Fehlalarmen', 'Reproduzierbare Konfiguration'] },
    fr: { h1: 'Évaluer la revue de code IA au-delà d’un classement.', description: 'Comparez les outils sur des pull requests représentatives avec cas, faux positifs, coût et configuration visibles.', summary: 'Un rang unique ne permet pas de décider. Juror propose une approche par tableau de bord pour évaluer le workflow réellement utilisé avec des éléments vérifiables.', focus: ['Cas représentatifs', 'Prise en compte des faux positifs', 'Configuration reproductible'] },
    es: { h1: 'Evalúa revisión de código con IA más allá de una clasificación.', description: 'Compare revisores en pull requests representativos, con casos, falsos positivos, costes y configuración visibles.', summary: 'Una única posición no sirve para decidir una compra. Juror propone una tarjeta de evaluación para que los equipos valoren el flujo que realmente ejecutarán con material verificable.', focus: ['Casos representativos', 'Registro de falsos positivos', 'Configuración reproducible'] },
    ja: { h1: 'ランキングを超えてAIコードレビューを評価する。', description: '代表的なプルリクエストを用い、事例、見逃し、誤検知、コスト、設定を可視化してレビューアーを比較します。', summary: '順位だけでは導入を決められません。Jurorは、実際に運用するワークフローを検証可能な資料で評価するためのスコアカードを提供します。', focus: ['代表的な事例', '誤検知の記録', '再現可能な設定'] },
    'pt-BR': { h1: 'Avalie revisão de código com IA além de um ranking.', description: 'Compare revisores em pull requests representativos com casos, falsos positivos, custo e configuração visíveis.', summary: 'Uma colocação isolada não decide uma compra. O Juror oferece uma abordagem de scorecard para avaliar o fluxo que a equipe de fato executará com material verificável.', focus: ['Casos representativos', 'Registro de falsos positivos', 'Configuração reproduzível'] },
  },
  customer_stories: {
    de: { h1: 'Evidenz vor Kundenlogo-Theater.', description: 'Juror veröffentlicht Kundengeschichten erst, wenn Kunde, Bedingungen und Evidenz benannt und geprüft werden können.', summary: 'Bis dahin sind Quellcode, Benchmark-Korpus, Beispiele und Release-Historie der ehrliche Maßstab. Eine Logo-Wand verrät nicht, ob ein KI-Reviewer bei deinen Pull Requests hilft.', focus: ['Öffentlicher Quellcode', 'Reproduzierbare Beispiele', 'Benchmark-Evidenz'] },
    fr: { h1: 'La preuve avant le théâtre des logos clients.', description: 'Juror publiera des témoignages clients seulement lorsque le client, les conditions et les preuves pourront être nommés et vérifiés.', summary: 'D’ici là, le code source, le corpus de benchmark, les exemples et l’historique des versions restent la manière honnête d’évaluer Juror. Un mur de logos ne dit pas si un outil vous aidera sur vos pull requests.', focus: ['Code source public', 'Exemples reproductibles', 'Preuves de benchmark'] },
    es: { h1: 'Evidencia antes que teatro de logotipos.', description: 'Juror solo publicará historias de clientes cuando se puedan nombrar y comprobar el cliente, las condiciones y la evidencia.', summary: 'Hasta entonces, el código, el corpus de benchmarks, los ejemplos y el historial de versiones son la forma honesta de evaluar Juror. Una pared de logotipos no dice si un revisor servirá para sus pull requests.', focus: ['Código público', 'Ejemplos reproducibles', 'Evidencia de benchmark'] },
    ja: { h1: 'ロゴの演出より検証できる根拠を。', description: 'Jurorは、顧客、条件、根拠を明記し検証できる場合にのみ顧客事例を公開します。', summary: 'それまでは、ソースコード、ベンチマークコーパス、例、リリース履歴がJurorを評価する正直な方法です。ロゴの一覧では、AIレビューアーが自分のプルリクエストで役立つかは分かりません。', focus: ['公開ソース', '再現可能な例', 'ベンチマークの根拠'] },
    'pt-BR': { h1: 'Evidência antes de mural de logotipos.', description: 'O Juror só publicará histórias de clientes quando cliente, condições e evidências puderem ser identificados e verificados.', summary: 'Até lá, código-fonte, corpus de benchmark, exemplos e histórico de versões são a forma honesta de avaliar o Juror. Um mural de logos não mostra se um revisor de IA funcionará nos seus pull requests.', focus: ['Código público', 'Exemplos reproduzíveis', 'Evidências de benchmark'] },
  },
  podcast: {
    de: { h1: 'Gespräche über nachvollziehbare KI-Code-Reviews.', description: 'Die Ideen hinter Juror stehen im öffentlichen Quellcode, in Issues, Dokumentation und Release Notes – nicht in einem erfundenen Episodenkatalog.', summary: 'Wer verstehen möchte, wie Juror heute funktioniert, sollte mit den produktnahen Materialien beginnen: Repository, Dokumentation, Benchmarks und öffentlichen Issues.', focus: ['Diskussionen im Quellcode', 'Release Notes', 'Technische Dokumentation'] },
    fr: { h1: 'Des échanges sur une revue de code IA responsable.', description: 'Les idées derrière Juror vivent dans le code public, les discussions, la documentation et les notes de version, pas dans un catalogue d’épisodes inventé.', summary: 'Pour comprendre le fonctionnement actuel de Juror, commencez par les éléments qui évoluent avec le produit : dépôt, documentation, benchmarks et issues publiques.', focus: ['Discussions du code source', 'Notes de version', 'Documentation technique'] },
    es: { h1: 'Conversaciones sobre revisión de código con IA responsable.', description: 'Las ideas detrás de Juror están en el código, las discusiones, la documentación y las notas de versión públicas, no en un catálogo de episodios inventado.', summary: 'Para entender cómo funciona Juror hoy, empiece con el material que cambia con el producto: repositorio, documentación, benchmarks e issues públicos.', focus: ['Conversaciones sobre el código', 'Notas de versión', 'Documentación técnica'] },
    ja: { h1: '説明可能なAIコードレビューについての対話。', description: 'Jurorの考え方は、架空のエピソード一覧ではなく、公開ソース、Issueの議論、ドキュメント、リリースノートにあります。', summary: '現在のJurorの仕組みを知るには、製品とともに変化する資料、すなわちリポジトリ、ドキュメント、ベンチマーク、公開Issueから始めてください。', focus: ['ソース上の議論', 'リリースノート', '技術ドキュメント'] },
    'pt-BR': { h1: 'Conversas sobre revisão de código com IA responsável.', description: 'As ideias por trás do Juror vivem no código público, nas discussões, na documentação e nas notas de versão, não em um catálogo de episódios inventado.', summary: 'Para entender como o Juror funciona hoje, comece pelo material que muda com o produto: repositório, documentação, benchmarks e issues públicas.', focus: ['Discussões sobre o código', 'Notas de versão', 'Documentação técnica'] },
  },
  review_standards: {
    de: { h1: 'Standards für KI-Review ohne Black Box.', description: 'Halte Review-Regeln, Eskalationswege und Ausnahmen in versionierter Konfiguration und Pull-Request-Richtlinien fest.', summary: 'Teams brauchen keinen Anbieter, der Präferenzen stillschweigend lernt. Juror macht Review-Erwartungen neben dem Code explizit, prüfbar und veränderbar.', focus: ['Versionierte Richtlinien', 'Sichtbare Ausnahmen', 'Menschliche Verantwortung'] },
    fr: { h1: 'Des standards de revue IA sans boîte noire.', description: 'Placez les règles de revue, les voies d’escalade et les exceptions dans une configuration versionnée et une politique de pull request.', summary: 'Les équipes n’ont pas besoin d’un fournisseur qui apprend leurs préférences en silence. Juror rend les attentes de revue explicites, vérifiables et modifiables avec le code.', focus: ['Politique versionnée', 'Exceptions visibles', 'Responsabilité humaine'] },
    es: { h1: 'Estándares de revisión con IA sin caja negra.', description: 'Guarde reglas de revisión, vías de escalado y excepciones en configuración versionada y políticas de pull requests.', summary: 'Los equipos no necesitan que un proveedor aprenda sus preferencias en silencio. Juror hace explícitas, revisables y modificables las expectativas junto al código.', focus: ['Política versionada', 'Excepciones visibles', 'Responsabilidad humana'] },
    ja: { h1: 'ブラックボックスにしないAIレビュー基準。', description: 'レビュー規則、エスカレーション経路、例外を、バージョン管理された設定とプルリクエストポリシーに記録します。', summary: 'チームが必要とするのは、ベンダーが黙って好みを学習することではありません。Jurorはレビューへの期待をコードとともに明示し、検査・変更可能にします。', focus: ['バージョン管理されたポリシー', '見える例外', '人が責任を持つ'] },
    'pt-BR': { h1: 'Padrões de revisão com IA sem caixa-preta.', description: 'Coloque regras de revisão, caminhos de escalonamento e exceções em configuração versionada e políticas de pull request.', summary: 'Equipes não precisam de um fornecedor que aprenda preferências em silêncio. O Juror torna expectativas de revisão explícitas, verificáveis e alteráveis junto com o código.', focus: ['Política versionada', 'Exceções visíveis', 'Responsabilidade humana'] },
  },
};

type LocaleCopy = {
  nav: Record<'product' | 'security' | 'solutions' | 'resources' | 'docs' | 'pricing', string>;
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
    nav: { product: 'Product', security: 'Security', solutions: 'Solutions', resources: 'Resources', docs: 'Docs', pricing: 'Pricing' },
    typeLabel: { core: 'Product guide', feature: 'Feature', solution: 'Solution', integration: 'Integration', comparison: 'Comparison', resource: 'Resource', template: 'Template', docs: 'Documentation', legal: 'Legal' },
    homeTitle: PAGE_SPECS.home.h1, overview: 'Overview', directAnswer: 'Direct answer', whatYouGet: 'What this covers', implementation: 'How it works', limitations: 'Limits to keep in view', related: 'Continue reading', sources: 'Sources and provenance', reviewed: 'Last reviewed', language: 'Language', install: 'Add to GitHub', cloud: 'Get started', docs: 'Read the docs', viewOnGitHub: 'View on GitHub', copy: 'Copy', copied: 'Copied', prerequisites: 'Before you start', steps: 'Steps', next: 'Next task', chooseJuror: 'Choose Juror if', chooseAlternative: 'Choose the alternative if', statusConfirmed: 'Confirmed', statusUnknown: 'Not evaluated', footer: 'Evidence-led multi-model review for GitHub pull requests.', editorialNotice: 'This locale is awaiting the review recorded in the route manifest and remains out of search indexing.', skipToContent: 'Skip to content', homeAriaLabel: 'Juror home', primaryNavigation: 'Primary navigation', breadcrumb: 'Breadcrumb'
  },
  de: {
    nav: { product: 'Produkt', security: 'Sicherheit', solutions: 'Lösungen', resources: 'Ressourcen', docs: 'Dokumentation', pricing: 'Preise' },
    typeLabel: { core: 'Produktleitfaden', feature: 'Funktion', solution: 'Lösung', integration: 'Integration', comparison: 'Vergleich', resource: 'Ressource', template: 'Vorlage', docs: 'Dokumentation', legal: 'Rechtliches' },
    homeTitle: 'Die KI-Code-Review-Jury für GitHub-Pull-Requests.', overview: 'Überblick', directAnswer: 'Kurzantwort', whatYouGet: 'Das wird behandelt', implementation: 'So funktioniert es', limitations: 'Wichtige Grenzen', related: 'Weiterlesen', sources: 'Quellen und Herkunft', reviewed: 'Zuletzt geprüft', language: 'Sprache', install: 'Zu GitHub hinzufügen', cloud: 'Jetzt starten', docs: 'Dokumentation lesen', viewOnGitHub: 'Auf GitHub ansehen', copy: 'Kopieren', copied: 'Kopiert', prerequisites: 'Vor dem Start', steps: 'Schritte', next: 'Nächste Aufgabe', chooseJuror: 'Juror wählen, wenn', chooseAlternative: 'Alternative wählen, wenn', statusConfirmed: 'Bestätigt', statusUnknown: 'Nicht bewertet', footer: 'Evidenzbasierte Multi-Model-Code-Reviews für GitHub-Pull-Requests.', editorialNotice: 'Diese Übersetzung wartet noch auf die im Routenmanifest vermerkte Prüfung und wird nicht indexiert.', skipToContent: 'Zum Inhalt springen', homeAriaLabel: 'Juror-Startseite', primaryNavigation: 'Hauptnavigation', breadcrumb: 'Navigationspfad'
  },
  fr: {
    nav: { product: 'Produit', security: 'Sécurité', solutions: 'Solutions', resources: 'Ressources', docs: 'Documentation', pricing: 'Tarifs' },
    typeLabel: { core: 'Guide produit', feature: 'Fonctionnalité', solution: 'Solution', integration: 'Intégration', comparison: 'Comparaison', resource: 'Ressource', template: 'Modèle', docs: 'Documentation', legal: 'Mentions légales' },
    homeTitle: 'Le jury de revue de code par IA pour les pull requests GitHub.', overview: 'Vue d’ensemble', directAnswer: 'Réponse directe', whatYouGet: 'Ce que cette page couvre', implementation: 'Fonctionnement', limitations: 'Limites à connaître', related: 'À lire ensuite', sources: 'Sources et provenance', reviewed: 'Dernière révision', language: 'Langue', install: 'Ajouter à GitHub', cloud: 'Commencer', docs: 'Lire la documentation', viewOnGitHub: 'Voir sur GitHub', copy: 'Copier', copied: 'Copié', prerequisites: 'Avant de commencer', steps: 'Étapes', next: 'Tâche suivante', chooseJuror: 'Choisissez Juror si', chooseAlternative: 'Choisissez l’alternative si', statusConfirmed: 'Confirmé', statusUnknown: 'Non évalué', footer: 'Revue multi-modèle fondée sur des preuves pour les pull requests GitHub.', editorialNotice: 'Cette traduction attend la révision indiquée dans le manifeste des routes et n’est pas indexée.', skipToContent: 'Aller au contenu', homeAriaLabel: 'Accueil Juror', primaryNavigation: 'Navigation principale', breadcrumb: 'Fil d’Ariane'
  },
  es: {
    nav: { product: 'Producto', security: 'Seguridad', solutions: 'Soluciones', resources: 'Recursos', docs: 'Documentación', pricing: 'Precios' },
    typeLabel: { core: 'Guía de producto', feature: 'Función', solution: 'Solución', integration: 'Integración', comparison: 'Comparación', resource: 'Recurso', template: 'Plantilla', docs: 'Documentación', legal: 'Legal' },
    homeTitle: 'El jurado de revisión de código con IA para pull requests de GitHub.', overview: 'Resumen', directAnswer: 'Respuesta directa', whatYouGet: 'Qué cubre esta página', implementation: 'Cómo funciona', limitations: 'Límites importantes', related: 'Sigue leyendo', sources: 'Fuentes y procedencia', reviewed: 'Última revisión', language: 'Idioma', install: 'Añadir a GitHub', cloud: 'Empezar', docs: 'Leer la documentación', viewOnGitHub: 'Ver en GitHub', copy: 'Copiar', copied: 'Copiado', prerequisites: 'Antes de empezar', steps: 'Pasos', next: 'Siguiente tarea', chooseJuror: 'Elige Juror si', chooseAlternative: 'Elige la alternativa si', statusConfirmed: 'Confirmado', statusUnknown: 'No evaluado', footer: 'Revisión multimodelo basada en evidencia para pull requests de GitHub.', editorialNotice: 'Esta traducción espera la revisión indicada en el manifiesto de rutas y no se indexa.', skipToContent: 'Saltar al contenido', homeAriaLabel: 'Inicio de Juror', primaryNavigation: 'Navegación principal', breadcrumb: 'Ruta de navegación'
  },
  ja: {
    nav: { product: '製品', security: 'セキュリティ', solutions: 'ソリューション', resources: 'リソース', docs: 'ドキュメント', pricing: '料金' },
    typeLabel: { core: '製品ガイド', feature: '機能', solution: 'ソリューション', integration: '連携', comparison: '比較', resource: 'リソース', template: 'テンプレート', docs: 'ドキュメント', legal: '法務' },
    homeTitle: 'GitHubプルリクエストのためのAIコードレビュー・ジュリー。', overview: '概要', directAnswer: '要点', whatYouGet: 'このページの内容', implementation: '仕組み', limitations: '確認すべき制約', related: '関連コンテンツ', sources: '出典と根拠', reviewed: '最終確認日', language: '言語', install: 'GitHub に追加', cloud: '今すぐ始める', docs: 'ドキュメントを読む', viewOnGitHub: 'GitHub で見る', copy: 'コピー', copied: 'コピーしました', prerequisites: '始める前に', steps: '手順', next: '次のタスク', chooseJuror: 'Juror を選ぶ場面', chooseAlternative: '別の選択肢を選ぶ場面', statusConfirmed: '確認済み', statusUnknown: '未評価', footer: 'GitHubプルリクエスト向けの、根拠を重視したマルチモデルレビュー。', editorialNotice: 'この翻訳はルートマニフェストに記録されたレビュー待ちのため、検索には登録されません。', skipToContent: '本文へ移動', homeAriaLabel: 'Juror ホーム', primaryNavigation: 'メインナビゲーション', breadcrumb: 'パンくずリスト'
  },
  'pt-BR': {
    nav: { product: 'Produto', security: 'Segurança', solutions: 'Soluções', resources: 'Recursos', docs: 'Documentação', pricing: 'Preços' },
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
  if (isCompanyPage(page.id)) return COMPANY_COPY[locale].titles[page.id];
  if (locale === 'en') return PAGE_SPECS[page.id].h1;
  const translated = LOCALIZED_LANDING_SPECS[page.id]?.[locale];
  if (translated?.h1) return translated.h1;
  if (page.id === 'home') return COPY[locale].homeTitle;
  const readableSegment = decodeURIComponent(page.paths[locale].split('/').filter(Boolean).at(-1) || '')
    .replace(/[-_]/g, ' ')
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
  return `${COPY[locale].typeLabel[page.contentType]}: ${readableSegment}`;
}

export function pageDescription(page: PageRecord, locale: Locale): string {
  if (isCompanyPage(page.id)) return COMPANY_COPY[locale].summaries[page.id];
  if (locale === 'en') return PAGE_SPECS[page.id].description;
  const translated = LOCALIZED_LANDING_SPECS[page.id]?.[locale];
  if (translated?.description) return translated.description;
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
  if (isCompanyPage(page.id)) return COMPANY_COPY[locale].summaries[page.id];
  if (locale === 'en') return PAGE_SPECS[page.id].summary;
  const translated = LOCALIZED_LANDING_SPECS[page.id]?.[locale];
  if (translated?.summary) return translated.summary;
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
  const translated = LOCALIZED_LANDING_SPECS[page.id]?.[locale];
  if (translated?.focus) return translated.focus;
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
