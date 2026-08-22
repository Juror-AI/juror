# Juror marketing site — Cloudflare implementation plan

Status: static implementation completed in `apps/marketing` and deployed to `juror.dev`. Indexing remains intentionally blocked until the documented human approval gates are complete.
Date: 2026-08-22
Companion artifacts: [SEO and content plan](seo-content-plan.md), [localized route manifest](seo-route-manifest.csv), [keyword backlog](seo-keyword-backlog.csv).

## 1. Outcome and non-negotiable constraints

Build a static-first Juror marketing and documentation site that deploys globally on Cloudflare, presents a restrained Vercel-inspired interface without copying Vercel’s trade dress, and publishes every planned route as an independently indexable localized page.

The initial architecture must generate:

- **91 logical pages** from the approved content plan.
- **546 public, unique locale URLs**: `en`, `de`, `fr`, `es`, `ja`, and `pt-BR` for every logical page.
- A static HTML response for every public SEO/GEO page; no client-side rendering is required to discover the primary content, navigation, metadata, or structured data.
- One source of truth for page IDs and routes: [`seo-route-manifest.csv`](seo-route-manifest.csv). A missing, duplicate, or unreviewed locale record is a release failure.

“100% SEO/GEO optimized” is treated here as **100% coverage of controllable technical, editorial, and evidence gates**. No responsible implementation can guarantee rankings, indexation, traffic, or an answer-engine citation, because those are determined by Google, other search engines, and LLM products. The release process below must prove that every controllable gate passes before a page is eligible for indexation.

### Acceptance statement

The marketing release is ready only when all 546 routes build to static HTML, their localized metadata/canonical/hreflang/schema are correct, their content is human-approved, the live response passes crawl/security/performance checks, and preview/production environments follow the deployment rules in this plan.

## 2. Platform decision

### Recommended stack: Astro static output on Cloudflare Workers Static Assets

Use **Astro in static-site-generation mode** and deploy the generated `dist` directory through **Cloudflare Workers Static Assets**. Cloudflare’s current Workers guidance recommends Static Assets for new static and full-stack projects; it deploys assets and any edge logic together, while Astro is purpose-built for content-heavy sites and emits minimal client JavaScript by default. [Cloudflare Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/), [Astro on Workers](https://developers.cloudflare.com/workers/framework-guides/web-apps/astro/), and [Static Assets](https://developers.cloudflare.com/workers/static-assets/) support this choice.

| Decision | Use | Why |
| --- | --- | --- |
| Rendering | Astro SSG; every public route pre-rendered at build time | Maximum crawlability, predictable canonicals, very low JS, and deterministic localized output. |
| Hosting | Cloudflare Workers Static Assets | Current Cloudflare recommendation for new sites; edge delivery plus a future-safe path for limited endpoint logic. |
| Edge code | None for content page rendering initially | Locale, route, metadata, and content must be build-time deterministic. Dynamic rendering adds SEO and cache risk without a user benefit. |
| Dynamic endpoints | One small Worker only if/when contact submission is live | Keeps form verification, rate controls, and provider secrets off the browser while leaving public pages static. |
| Content | Git-backed MDX/content collections plus CSV manifests | Requires reviewable, versioned, source-cited claims and allows PR previews. Do not begin with a headless CMS. |
| Images | Local optimized source assets; Cloudflare Images only when a real media library warrants it | Avoids a premature runtime dependency. If enabled, use responsive `srcset`/`width=auto` delivery. [Cloudflare responsive-image guidance](https://developers.cloudflare.com/images/optimization/make-responsive-images/) applies. |
| Data stores | No D1, KV, Durable Objects, R2, Vectorize, or Workers AI at launch | A 546-page content site has no runtime data requirement. Add a store only for a documented product need, never for SEO theater. |
| Deployment | Cloudflare Workers Builds connected to GitHub | Builds and preview URLs are created for changes without promoting them to production. [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) and [preview URLs](https://developers.cloudflare.com/workers/versions-and-deployments/preview-urls/) are the deployment primitive. |

### Why not Cloudflare Pages as the primary recommendation?

Cloudflare Pages can deploy Astro and offers Git deployments and previews, so it is an acceptable operational fallback if the organization already standardizes on Pages. But new Cloudflare guidance directs new static sites toward Workers Static Assets, where current optimizations and features are focused. Do not deploy the same site independently to both platforms: it creates canonical, redirect, and cache ambiguity. [Pages’ Astro guide](https://developers.cloudflare.com/pages/framework-guides/deploy-an-astro-site/) is the fallback reference.

### Architecture at launch

```text
GitHub pull request
        │
        ├─ content + manifest + visual + SEO checks
        ├─ Astro static build → 546 localized HTML routes + assets + sitemaps
        └─ Cloudflare Workers preview version (robots noindex)

main branch
        │
        └─ Cloudflare Workers production deployment
                 ├─ global static-asset delivery
                 ├─ optional /api/contact endpoint only
                 ├─ security headers / redirects
                 └─ Cloudflare Web Analytics + Workers observability
```

No page will select a language from `Accept-Language` at the edge. Each language has a stable, static URL. A client may offer a non-blocking locale suggestion, but it must never redirect a crawler or replace the requested localized page.

## 3. Repository and content architecture

Keep the website isolated from the existing GitHub Action package so a marketing dependency or deployment cannot change the released Action. The target layout is a nested app, not a rewrite of the current package.

```text
apps/marketing/
  src/
    components/          shared UI primitives and composed sections
    layouts/             marketing, resource, comparison, docs, legal layouts
    pages/               route generation entry points only
    styles/              design tokens, reset, global styles
    lib/                 route, metadata, schema, sitemap, and validation helpers
  content/
    pages/{locale}/      commercial and solution MDX
    resources/{locale}/  guides, templates, comparisons, benchmark narratives
    docs/{locale}/       localized task documentation
    data/                evidence, FAQ, navigation, logos/assets metadata
  public/                static files, icons, social-image fallback, robots assets
  tests/                 route, metadata, link, schema, accessibility, visual checks
  wrangler.jsonc         Workers Static Assets deployment configuration
  astro.config.*         static-output configuration
docs/
  seo-route-manifest.csv
  seo-keyword-backlog.csv
  seo-content-plan.md
  cloudflare-site-implementation-plan.md
```

### Content model

Every content record carries these required fields. Content cannot be published merely because its body exists.

| Field | Required behavior |
| --- | --- |
| `page_id` | Exact ID from `seo-route-manifest.csv`; immutable after launch. |
| `locale` and `path` | Exact corresponding manifest fields; no slug derivation at request time. |
| `content_type` | One of core, feature, solution, integration, comparison, resource, template, docs, legal. Drives layout/schema/QA. |
| `title`, `description`, `h1` | Native-language, distinct, visible, and within the keyword owner’s search intent. |
| `summary_answer` | A 40–70 word direct answer in the reader’s language; required on guides, comparisons, and feature pages for GEO. |
| `body` | Original localized MDX, including rendered headings, examples, and visual captions. No English fallback body. |
| `primary_keyword_cluster` | One row in `seo-keyword-backlog.csv`; prevents overlapping ownership. |
| `evidence` | Claim IDs pointing to source URL/file, editor, calculation/date, and review due date. Required where a measurable statement appears. |
| `author` and `reviewed_at` | Visible on guides, benchmarks, comparisons, and technical documentation. |
| `translations` | The five alternate locale page IDs and complete locale display names. |
| `robots` | `index` only for complete production content. Preview, draft, tag/filter, internal search, and incomplete translations are `noindex`. |

### Source-of-truth rules

1. The route manifest owns URLs, locale coverage, and page count.
2. MDX owns page copy and visible structure.
3. The evidence registry owns factual/numeric claims and source freshness.
4. A generated route map joins all three. A content page cannot override a manifest URL.
5. Documentation code examples may source from the action repository, but snippets are copied/generated during the build and versioned with the release. Do not retrieve snippets live at request time.
6. Raw competitor comparisons are editorial records with a revalidation date; no competitor feature/pricing statement is evergreen.

## 4. Interface implementation: Vercel-inspired, not Vercel-cloned

### Design intent

The site should feel calm, technical, fast, and rigorously composed: dense information, short copy, crisp typography, subtle borders, and product artifacts as the visual focus. It must not use Vercel’s logo, illustrations, gradients, exact type treatment, copy, screenshot composition, or page-specific interactions.

### Design-token system

| Layer | Decision |
| --- | --- |
| Grid | 12 columns desktop, 6 tablet, 4 mobile; 1,200–1,280px max page width; 24px desktop gutter, 16px mobile gutter. |
| Spacing | Four-point scale with section spacing that contracts gracefully from desktop to mobile. Establish tokens once; do not embed arbitrary pixel values in pages. |
| Typography | Neutral licensed/system sans for UI and prose; readable monospace for code/review artifacts. Use a 1.1–1.15 display line-height, 1.5–1.7 body line-height, and fluid type clamp rules. Do not use Vercel branding as a type shortcut. |
| Color | Black/near-white and white/near-black themes, neutral border scale, one Juror accent, semantic severity colors plus text/icon labels. Theme choice persists locally but never changes canonical content. |
| Surfaces | 1px hairline borders, modest 8–12px radius, no ornamental shadows, high contrast, generous empty space around key proof. |
| Motion | 150–220ms transitions only; no video LCP dependency; `prefers-reduced-motion` disables movement without removing meaning. |
| Icons | Original/simple open-license icon set only; labels always accompany severity/status symbols. |

### Component inventory

Build primitives first, then page templates. No landing page owns an un-reusable special component unless it becomes a documented shared primitive.

| Component | Used by | SEO/accessibility requirement |
| --- | --- | --- |
| `SiteHeader`, `SiteFooter`, `LocaleSwitcher` | Every public page | Locale switcher links directly to equivalent paths; keyboard complete; no JS-only navigation. |
| `Hero`, `Eyebrow`, `CTAGroup` | Core/commercial pages | Single page H1, stable CTA target, no text embedded in hero images. |
| `ReviewArtifact` | Home/product/features | Selectable DOM text; static fallback; semantic severity labels; never a canvas-only marketing mockup. |
| `PipelineDiagram` | Home/how-it-works/features | SVG or DOM with textual sequence/accessible alternative. |
| `EvidenceCard`, `SourceList`, `BenchmarkTable` | Examples/benchmarks/comparisons | Claim ID, source, date, limitations, responsive table/card layout. |
| `FeatureGrid`, `SolutionChooser`, `ComparisonTable` | Hub/commercial pages | Cards use real links; tables retain headers and relations on mobile. |
| `CodeBlock`, `CopyButton` | Docs/templates/integrations | Server-rendered code; copy enhancement optional; no secret values. |
| `TOC`, `Breadcrumbs`, `RelatedContent` | Resources/docs/comparisons | Server-rendered internal links and correct `BreadcrumbList` schema. |
| `FAQ`, `Callout`, `DecisionMatrix` | Relevant pages | Visible text must exactly match any structured data. |
| `ContactForm` | Contact only | Progressive enhancement; server-side Turnstile validation; clear error/success state. |

### Five page templates

| Template | Applies to | Above-the-fold implementation |
| --- | --- | --- |
| Marketing | Home, product, features, solutions, integrations, pricing | H1 + concise answer + primary/secondary CTA + product evidence artifact. |
| Comparison | Hub and 10 comparison pages | Neutral decision answer, update/source note, comparison matrix, “choose them if / choose Juror if.” |
| Resource | Guides, checklists, benchmarks, templates | Answer-first summary, TOC, author/review date, original examples, citations, relevant CTA after value. |
| Docs | Docs index and task guides | Task title, prerequisite note, copyable steps, version/source, next task; no marketing chrome overload. |
| Legal | Privacy and terms | Quiet text-first layout, locale/version selector, effective date. |

### Every-route visual delivery plan

The existing page inventory is the implementation backlog. It maps to templates as follows:

| Content type | Logical pages | Localized deliveries | Primary implementation pattern |
| --- | ---: | ---: | --- |
| Core and legal | 19 | 114 | Marketing/legal templates; launch hero, product, setup, trust, and company pages. |
| Feature hubs and pages | 8 | 48 | Feature index + proof diagrams/artifacts. |
| Solution hubs and pages | 9 | 54 | Solution selector + problem/workflow/use-case proof. |
| Integration hub and pages | 6 | 36 | Setup cards, docs handoff, exact supported-configuration table. |
| Comparison hub and pages | 11 | 66 | Evidence-first comparison template; full source and freshness panel. |
| Resources and templates | 28 | 168 | Article/template layout with internal linking and downloadable source content. |
| Documentation | 10 | 60 | Task-first docs layout and versioned snippets. |
| **Total** | **91** | **546** | Static, locale-specific HTML generated from the route manifest. |

## 5. SEO, internationalization, and GEO implementation

### SEO rendering contract

For each localized route, the build emits all of the following in the initial HTML response:

1. Correct `<html lang>` (`pt-BR` is correctly cased in BCP 47 markup), title, meta description, viewport, canonical, Open Graph, and X/Twitter metadata.
2. One visible H1 and logical heading hierarchy; no duplicated desktop/mobile headings.
3. Self-referencing canonical. German, French, Spanish, Japanese, and Brazilian Portuguese pages canonically reference themselves—not English.
4. Complete alternate set: `en`, `de`, `fr`, `es`, `ja`, `pt-BR`, and `x-default`. Each alternate must be a published, 200, indexable equivalent.
5. Route-specific `BreadcrumbList`; `SoftwareApplication` only where the visible product facts support it; `Article` for editorial pages; `HowTo` only for visible step-by-step tasks; `FAQPage` only for visible unique FAQs. Never add self-serving Review/aggregate-rating schema.
6. A crawlable internal-link graph: global hubs → children; child → parent/two siblings/relevant product/docs task; no important link depends on client-side hydration.
7. Meaningful alt text, captions, explicit image dimensions, and no text essential to the search result locked into an image.

### Sitemap, robots, and redirects

| Artifact | Production requirement |
| --- | --- |
| `/sitemap.xml` | Sitemap index generated at build. It points to locale/content-type child sitemaps and has only canonical 200 production URLs. |
| Locale sitemaps | Six locale sitemaps, split further by content type if a sitemap approaches operational limits. Each contains URLs that match the manifest exactly. |
| `robots.txt` | Allows public content and references sitemap index; blocks or `noindex`s preview, internal search, draft, contact confirmation, filter, and parameterized routes. |
| Preview responses | `noindex, nofollow` in visible metadata and HTTP response headers; no production canonical. Preview URLs never enter a sitemap. |
| Redirect registry | Version-controlled 301 map for legacy/renamed URLs, http→https, apex/www decision, and any retired localized slugs. Query preservation is explicit. |
| 404 | Localized static 404 with resource navigation, no soft-404 behavior, and no redirect to home. |

The initial domain and apex/www policy are a launch decision. Until that is selected, use `SITE_ORIGIN` as one production value everywhere; never embed a preview, staging, or `workers.dev` hostname in a canonical or schema URL.

### GEO: Generative Engine Optimization

GEO is not a separate trick or a promise of being quoted by LLMs. It is a content-quality and machine-readable-evidence practice that makes Juror useful to people and answer engines.

| GEO requirement | Build/content rule |
| --- | --- |
| Direct answers | Every guide, comparison, and feature page opens with a localized 40–70 word direct answer before detailed explanation. |
| Atomic facts | Product facts, benchmark metrics, limitations, pricing semantics, and setup facts are presented in short tables/lists with source IDs and reviewed dates. |
| First-party evidence | `/benchmarks`, `/examples`, and docs link to raw corpus/methodology/release source where public. Do not cite a marketing page as evidence for itself. |
| Source transparency | Comparison pages show product version/date, source links, contributor/editor, limitations, and a correction mechanism. |
| Entity clarity | Establish Juror as one entity consistently: name, GitHub Marketplace link, MIT project facts, product category, and same canonical site identity in `Organization`/`SoftwareApplication` schema. |
| Retrieval-friendly structure | Accurate H2 question headings, tables with headers, descriptive anchors, meaningful summaries, stable URL slugs, and server-rendered primary content. |
| Freshness | Changelog/review date/evidence source metadata are visible. Comparison facts revalidate quarterly; benchmark claims have an explicit expiry or recheck event. |
| `llms.txt` | Publish only after the docs/product canonical set is stable. It is a concise, maintained map with source links and must not replace sitemaps, HTML, or documentation. |
| Citation quality | No invented metrics, customer logos, or “best” claims. A content build fails when a required evidence record is absent or overdue. |

### Localization implementation gates

1. The route manifest is parsed at build time and produces one route for every locale/page pair.
2. Build fails if count ≠ `91 × 6`, any path duplicates, any localized body is missing, or a page uses English as an unreviewed fallback.
3. Every translation receives native technical-editor signoff. The current registry’s `pending_native_technical_review` and legal statuses are work queue states, not permission to publish.
4. Localized metadata is independently written and reviewed; translation does not simply copy English title/description.
5. Technical identifiers (Juror, GitHub, YAML keys, environment variables, commands, pinned SHAs) stay exact; explanatory text and non-brand slugs are localized.
6. Japanese Unicode paths are retained as declared in the manifest, correctly escaped in XML/HTTP contexts, and tested in browsers, sitemaps, canonicals, alternate links, analytics, and social metadata.

### Performance requirements

| Budget | Gate |
| --- | --- |
| JavaScript | Zero client JavaScript by default. Hydrate only locale suggestion, copy controls, tab-like nonessential demo control, and contact form behavior. |
| LCP | Hero copy and review artifact are server-rendered DOM; no autoplay video or large image above the fold. p75 mobile LCP target ≤2.5s. |
| INP | Avoid framework-wide hydration and large third-party scripts. p75 INP target ≤200ms. |
| CLS | Reserve image/font/embed dimensions; no late announcement bar. p75 CLS target ≤0.1. |
| Fonts | Self-host one subsetted sans/mono pair or use system fonts. Preload only the font used by first paint; `font-display: swap`. |
| Images | AVIF/WebP where supported, explicit width/height, responsive `srcset` or Cloudflare `width=auto`, no decorative image that delays content. |
| Third parties | No tag-manager or chat widget at launch. Add analytics/privacy-reviewed scripts through a budgeted, consent-aware integration. |

Cloudflare Web Analytics can break Core Web Vitals down by URL, browser, country, and element, so use it with Search Console and lab tests to prioritize regressions. [Cloudflare Web Analytics Core Web Vitals](https://developers.cloudflare.com/web-analytics/data-metrics/core-web-vitals/).

## 6. Cloudflare configuration, security, and operations

### Resources to provision

| Resource | Launch use | Owner / note |
| --- | --- | --- |
| Cloudflare zone + custom domain | Canonical public domain, DNS, TLS, redirects, security settings | Domain owner chooses apex/www convention once. |
| `juror-marketing` Worker | Static Asset deployment; optional tiny endpoint middleware | No Durable Object and no runtime page rendering. |
| Workers Builds | GitHub-connected production and preview build pipeline | Main deploys production; branches upload preview versions. |
| Cloudflare Web Analytics | Privacy-reviewed traffic and CWV view | Use consent policy appropriate to the selected analytics configuration. |
| Workers Logs / observability | Error diagnosis for Worker/endpoint/redirect code | Sample production appropriately; do not log personal form contents. |
| Turnstile (conditional) | Contact form abuse protection | Client widget plus mandatory server-side Siteverify validation. |
| Cloudflare Images (conditional) | Large/reused product screenshot and case-study library | Do not provision for a handful of versioned local assets. |

### Security baseline

1. Use Cloudflare-managed TLS; redirect HTTP to HTTPS; enable HSTS only after all subdomains are HTTPS-safe.
2. Set a strict, tested Content Security Policy; no wildcard script sources. Add nonces/hashes only where required by actual integrations.
3. Set `X-Content-Type-Options: nosniff`, frame-ancestors via CSP, `Referrer-Policy: strict-origin-when-cross-origin`, and restrictive `Permissions-Policy` for unused browser capabilities.
4. Enable Cloudflare WAF managed rules and rate limits only for dynamic endpoints; test them against preview and contact submission to avoid blocking legitimate users.
5. A contact form, if implemented, validates Turnstile server-side before accepting/submitting data. Client-side widget completion alone is not protection. [Turnstile Siteverify](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/).
6. Store all provider keys in Cloudflare secrets/CI secret storage. Never expose API keys in `PUBLIC_*` variables, MDX, example code, previews, or logs.
7. Use a data-minimizing contact flow. No PII in analytics events, URL parameters, Worker logs, or Error reports.
8. Add a documented vulnerability/security contact on the site once it is operational; security claims remain aligned with the existing Juror product, not the website host.

### Cache and response policy

- Hashed CSS/JS/font/image assets receive long immutable caching. HTML is cacheable at the edge but must revalidate predictably after production content updates; avoid an application-level cache that can serve stale localized metadata.
- Public static assets are served directly by the Cloudflare assets layer. Do not make every hit execute Worker code merely to add a header unless a platform test proves that is required.
- Redirects are deterministic, permanent only when the replacement is permanent, and tested for locale preservation.
- No cache key varies by browser language, cookie, A/B test, or geolocation for indexable content.

### Observability and growth metrics

| Signal | Tool / action | Alert or review rule |
| --- | --- | --- |
| Deploy/runtime errors | Workers Logs and Workers metrics | Investigate any post-deploy error-rate increase; logs are sampled/minimized. |
| Request health | Workers metrics and zone analytics | Review 4xx/5xx, redirect volume, and top missing routes weekly after launch. |
| Page performance | Cloudflare Web Analytics + Lighthouse/CrUX | Revert or fix any production CWV regression on priority pages. |
| Search | Search Console, submitted sitemap index | Monitor index coverage, alternate-language issues, rich-result errors, query/page cannibalization. |
| GEO/content evidence | Quarterly source and claim audit | Remove or update expired claims before they become stale. |
| Conversion | Privacy-compliant marketplace/install/doc events | CTA click ≠ install; define activation separately. |

Workers Logs and Analytics Engine can provide application-specific observability, but Analytics Engine is not needed until a real custom metric requires it; its writes are non-blocking if adopted. [Cloudflare observability](https://developers.cloudflare.com/workers/observability/) and [Analytics Engine guidance](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/).

## 7. CI/CD and quality gates

### Environments

| Environment | Trigger | URL/indexing policy | Content/data rule |
| --- | --- | --- | --- |
| Local | Developer branch | Local only | Fixture data and locally generated full route set. |
| Pull request preview | Every PR / content change | Cloudflare preview URL, `noindex,nofollow`, preview canonical omitted or self-preview only; never production canonical | Full production-shaped build; sanitized contact endpoint. |
| Staging (optional) | Release candidate | Protected subdomain, `noindex,nofollow` | Final content/translation/legal checks. |
| Production | Protected `main` after all checks | Canonical custom domain, indexable sitemap/robots | Only approved production content and evidence. |

Workers Builds’ standard preview flow uploads a preview version for non-production branches without promoting it. PR URLs and checks are available through the Git integration. [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/) and [GitHub integration](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/).

### Required checks on every pull request

| Gate | Proof required |
| --- | --- |
| Manifest integrity | 91 page IDs; six locales each; 546 unique paths; every public route exists exactly once. |
| Content completeness | Required frontmatter, source citations, author/review date, approved localized metadata/body, no unsupported claims. |
| Static build | All public routes output HTML and do not rely on runtime worker rendering. |
| Crawlability | Every route returns 200; no broken internal links; canonical/hreflang reciprocal and correct; sitemap parity test passes. |
| Structured data | JSON-LD parses and matches visible content; no prohibited/misleading schema. |
| SEO hygiene | One H1; title/description uniqueness; heading order; alt text; no accidental `noindex`; keyword owner in backlog. |
| GEO quality | Answer-first summary, sourced facts, limitations, author/review date, and useful internal sources on applicable pages. |
| Accessibility | Automated axe test plus keyboard/manual review of header, locale menu, tabs, copy buttons, FAQ, tables, and contact form. |
| Visual/UI | Screenshot regression desktop/mobile in light/dark for all five templates and the homepage; no layout overflow or theme contrast failure. |
| Performance | Mobile/desktop Lighthouse with budgets; bundle-size diff; LCP artifact review. |
| Security | Header/CSP checks, no secrets in build output, contact endpoint/Turnstile tests where enabled, preview robots check. |

### Release gates

1. Native editorial signoff for all six locales in the release batch.
2. Legal/security owner signoff for legal, pricing, security, data-flow, and competitor-comparison changes.
3. Benchmark/research owner signoff for any performance claim or graph.
4. A real PR preview review against the content checklist—not only a green build.
5. Production smoke verifies home, one page per template, one page per locale, sitemap, robots, canonical/hreflang, 404, a redirect, and optional contact endpoint.
6. Publish sitemap in Search Console only after the full parity/smoke check passes.

## 8. Implementation sequence

### Phase A — foundation and governance

Deliver before writing public page components:

1. Choose production domain, domain ownership, apex/www policy, consent/analytics policy, legal owner, and translation vendors/editors.
2. Create the isolated `apps/marketing` app structure, static Astro build, Worker Static Assets configuration, and Workers Builds connection.
3. Implement content schema, route-manifest parser, evidence registry, localized navigation, redirect registry, and sitemap/robots generators.
4. Implement CI checks before importing content. The build must prove 546 paths even when pages contain placeholder draft content.
5. Establish the design tokens and component primitives; approve visual direction with a homepage wireframe and one docs/resource/comparison example.

Exit criteria: preview deployment exists, all manifests parse, static output count validates, and no public preview is indexable.

### Phase B — core conversion release (21 logical pages / 126 localized pages)

Implement the core pages already prioritized in the SEO plan: home, category, product, mechanism, GitHub setup, multi-model/consensus/cost/post-merge capability, benchmarks/examples, pricing/security/open-source, GitHub integrations, key docs, and legal pages.

Deliver the real product artifacts before design polish: example GitHub review, dedupe lifecycle, receipt, configuration snippet, and benchmark methodology. If a proof artifact is not ready, do not replace it with synthetic outcome claims.

Exit criteria: full production-ready homepage; all six locale equivalents; core SEO/GEO fields valid; mobile visual and CWV gate pass.

### Phase C — navigation hubs, feature/solution/integration coverage

Implement the four hubs (Features, Solutions, Integrations, Compare), remaining feature/solution/integration pages, and full internal-link graph. Add navigation only when its destination set is live; no dead menu paths.

Exit criteria: every commercial page has a parent hub, task docs handoff, product proof, and locale-equivalent navigation.

### Phase D — comparison and authority content

Implement the ten comparison pages with their source/freshness record, then the resource/template library. Build the comparison layout and source component before producing comparison copy so evidence requirements are structural rather than editorial afterthoughts.

Exit criteria: every competitor claim has a primary source and review date; resource pages have original examples and non-duplicative keyword ownership.

### Phase E — documentation, observability, and hardening

Implement task documentation, changelog automation/content policy, optional contact endpoint, analytics dashboards, monitoring runbooks, and quarterly research review process. Activate Cloudflare Images only when media usage meets the threshold established by the design team.

Exit criteria: documentation codes/steps have release provenance, post-launch dashboards exist, 404/redirect paths are tested, and incident/rollback runbook is rehearsed.

## 9. Launch checklist

- [ ] Production domain/redirect convention decided; TLS, DNS, and owner verified.
- [ ] Workers Static Assets deployment is the sole public origin; Pages is not serving a duplicate.
- [ ] 91 pages × 6 locales = 546 unique static routes in the build artifact.
- [ ] Every manifest route has correct localized HTML, canonical, hreflang set, title, description, H1, and social data.
- [ ] Sitemap index and children exactly match indexable canonical production URLs.
- [ ] Preview/staging cannot be indexed or canonically compete with production.
- [ ] Route, link, schema, accessibility, visual, Lighthouse, and security checks pass.
- [ ] Content claim/evidence registry is complete; legal/technical/native-editor approvals recorded.
- [ ] Home/product/comparison/resource/docs templates work on mobile, keyboard, reduced motion, and both color themes.
- [ ] Cloudflare Web Analytics/Workers Logs configured with privacy/data minimization decisions documented.
- [ ] Search Console and Bing Webmaster Tools have verified ownership and submitted production sitemap.
- [ ] First 30-day review dates are scheduled: index coverage, localized errors, CWV, source freshness, and conversion quality.

## 10. Decisions intentionally deferred

| Decision | Why it is deferred | Decision trigger |
| --- | --- | --- |
| Headless CMS | Git-backed content is safer for initial technical/evidence review. | Multiple non-Git editors require managed publishing workflow. |
| D1/KV/R2/DO | No runtime content/state is needed for a static marketing site. | A concrete feature needs persistent data, not a speculative dashboard. |
| Workers AI/RAG chat | It risks generic answers, privacy burden, JS cost, and confused SEO intent. | Documented user need, curated corpus, answer quality evaluation, and privacy approval. |
| Cloudflare Images | Local responsive assets are sufficient at launch. | Repeated media transformation/editor workflow exceeds local build benefit. |
| Contact CRM/email vendor | Must follow data-protection and ownership decisions. | Approved contact workflow and provider selection. |
| `llms.txt` | Useful only if maintained and never a substitute for canonical HTML/docs. | Stable docs release and named content owner. |

## 11. Source references

- [Cloudflare Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [Cloudflare Workers best practices — static assets for new projects](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [Astro on Cloudflare Workers](https://developers.cloudflare.com/workers/framework-guides/web-apps/astro/)
- [Cloudflare Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)
- [Cloudflare preview URLs](https://developers.cloudflare.com/workers/versions-and-deployments/preview-urls/)
- [Cloudflare Web Analytics — Core Web Vitals](https://developers.cloudflare.com/web-analytics/data-metrics/core-web-vitals/)
- [Cloudflare Turnstile server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
- [Cloudflare Images responsive delivery](https://developers.cloudflare.com/images/optimization/make-responsive-images/)
