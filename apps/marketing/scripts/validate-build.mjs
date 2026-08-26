import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const distRoot = join(appRoot, 'dist');
const manifestPath = join(repositoryRoot, 'docs', 'seo-route-manifest.csv');
const siteOrigin = (process.env.SITE_ORIGIN || 'https://juror.example').replace(/\/$/, '');
const contentRelease = process.env.CONTENT_RELEASE || 'draft';
const cloudSignInUrl = 'https://app.juror.dev/signin';
const localeColumns = [
  ['en', 'en_path', 'en'],
  ['de', 'de_path', 'de'],
  ['fr', 'fr_path', 'fr'],
  ['es', 'es_path', 'es'],
  ['ja', 'ja_path', 'ja'],
  ['pt-BR', 'pt_br_path', 'pt-BR'],
];

function fail(message) {
  throw new Error(`Marketing build validation failed: ${message}`);
}

if (!existsSync(distRoot) || !statSync(distRoot).isDirectory()) fail('dist directory does not exist. Run the static build first.');

const [header, ...lines] = readFileSync(manifestPath, 'utf8').trim().split(/\r?\n/);
const columns = header.split(',');
const records = lines.map((line) => Object.fromEntries(columns.map((column, index) => [column, line.split(',')[index] ?? ''])));
if (!records.length) fail('route manifest has no records');

const siteUrl = new URL(siteOrigin);
const productionOrigin = siteUrl.protocol === 'https:'
  && !siteUrl.hostname.endsWith('.example')
  && !siteUrl.hostname.endsWith('.workers.dev')
  && siteUrl.hostname !== 'localhost';
const releaseReady = contentRelease === 'approved'
  && productionOrigin
  && records.every((record) => record.localization_status.startsWith('approved_'));
const expectedRobots = releaseReady ? 'index, follow' : 'noindex, nofollow';

const paths = records.flatMap((record) => localeColumns.map(([, column]) => record[column]));
const expectedPathCount = records.length * localeColumns.length;
if (paths.length !== expectedPathCount || new Set(paths).size !== expectedPathCount) fail(`manifest does not have ${expectedPathCount} unique localized routes`);
const publicRoutePaths = new Set(paths.map((routePath) => `${routePath}/`));
const titlesByLocale = new Map(localeColumns.map(([locale]) => [locale, new Map()]));
const descriptionsByLocale = new Map(localeColumns.map(([locale]) => [locale, new Map()]));

function htmlPath(routePath) {
  return join(distRoot, ...decodeURIComponent(routePath).split('/').filter(Boolean), 'index.html');
}

for (const record of records) {
  const englishHtml = readFileSync(htmlPath(record.en_path), 'utf8');
  for (const [locale, column, htmlLang] of localeColumns) {
    const routePath = record[column];
    const output = htmlPath(routePath);
    if (!existsSync(output)) fail(`missing output for ${routePath}`);
    const html = readFileSync(output, 'utf8');
    if (!html.includes(`<html lang="${htmlLang}">`)) fail(`${routePath} does not use ${htmlLang} on html lang`);
    if ((html.match(/<h1(?:\s[^>]*)?>/g) ?? []).length !== 1) fail(`${routePath} does not contain exactly one H1`);
    if (!html.includes(`<link rel="canonical" href="${siteOrigin}${routePath}/">`)) fail(`${routePath} has an incorrect canonical URL`);
    const title = html.match(/<title>([^<]+)<\/title>/)?.[1];
    if (!title) fail(`${routePath} has no title metadata`);
    if (titlesByLocale.get(locale).has(title)) fail(`${routePath} duplicates the ${locale} title used by ${titlesByLocale.get(locale).get(title)}`);
    titlesByLocale.get(locale).set(title, routePath);
    const description = html.match(/<meta name="description" content="([^"]+)"/i)?.[1];
    if (!description) fail(`${routePath} has no description metadata`);
    if (!html.match(/<meta name="twitter:image" content="[^"]+"/i)) fail(`${routePath} has no Twitter image metadata`);
    if (!html.match(/<meta property="og:locale" content="[^"]+"/i)) fail(`${routePath} has no Open Graph locale metadata`);
    if (descriptionsByLocale.get(locale).has(description)) fail(`${routePath} duplicates the ${locale} description used by ${descriptionsByLocale.get(locale).get(description)}`);
    descriptionsByLocale.get(locale).set(description, routePath);
    if (!html.includes(`name="robots" content="${expectedRobots}"`)) fail(`${routePath} does not use the expected ${expectedRobots} release policy`);
    if ((html.match(/hreflang=/g) ?? []).length !== 7) fail(`${routePath} does not have six locale alternates and x-default`);
    if (!html.includes(`href="${cloudSignInUrl}"`)) fail(`${routePath} does not link its primary CTA to Juror Cloud`);
    const schemaBlocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((match) => match[1]);
    if (schemaBlocks.length !== 1) fail(`${routePath} must have exactly one structured-data graph`);
    let schema;
    try {
      schema = JSON.parse(schemaBlocks[0]);
    } catch {
      fail(`${routePath} has invalid JSON-LD`);
    }
    {
      if (!Array.isArray(schema['@graph']) || !schema['@graph'].some((item) => item['@type'] === 'BreadcrumbList')) {
        fail(`${routePath} has an incomplete structured-data graph`);
      }
      const website = schema['@graph'].find((item) => item['@type'] === 'WebSite');
      if (website?.['@id'] !== `${siteOrigin}/#website` || website.url !== siteOrigin) {
        fail(`${routePath} has an incomplete WebSite structured-data entity`);
      }
      const webpage = schema['@graph'].find((item) => item['@type'] === 'WebPage');
      if (webpage?.isPartOf?.['@id'] !== `${siteOrigin}/#website`) {
        fail(`${routePath} does not connect WebPage structured data to WebSite`);
      }
      const breadcrumb = schema['@graph'].find((item) => item['@type'] === 'BreadcrumbList');
      const breadcrumbItems = breadcrumb?.itemListElement;
      if (!Array.isArray(breadcrumbItems) || breadcrumbItems.length === 0) fail(`${routePath} has an empty breadcrumb list`);
      if (record.page_id === 'home' && breadcrumbItems.length !== 1) fail(`${routePath} home breadcrumb must contain only Juror`);
      if (breadcrumbItems.some((item, index) => index > 0 && item.item === breadcrumbItems[index - 1].item)) {
        fail(`${routePath} has duplicate consecutive breadcrumb destinations`);
      }
      if (record.content_type === 'docs' && schema['@graph'].some((item) => item['@type'] === 'HowTo')) {
        fail(`${routePath} uses HowTo schema without a verified visible step model`);
      }
      if (schema['@graph'].some((item) => item['@type'] === 'SoftwareApplication' && ('softwareVersion' in item || 'license' in item))) {
        fail(`${routePath} puts non-visible release facts into SoftwareApplication schema`);
      }
    }
    for (const href of [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1])) {
      if (!href.startsWith('/') || href.startsWith('/_astro/')) continue;
      const normalizedHref = `${decodeURIComponent(href.split(/[?#]/)[0]).replace(/\/$/, '')}/`;
      if (!publicRoutePaths.has(normalizedHref)) fail(`${routePath} links to an unknown internal route: ${href}`);
    }
    if (locale !== 'en') {
      const localH1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1];
      const englishH1 = englishHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1];
      if (!localH1 || localH1 === englishH1) fail(`${routePath} uses the English H1 fallback`);
    }
    for (const image of html.matchAll(/<img\b[^>]*>/g)) {
      if (!/\balt="[^"]*"/.test(image[0])) fail(`${routePath} has an image without alt text`);
    }
  }
}

for (const asset of ['sitemap.xml', 'sitemap-en.xml', 'sitemap-de.xml', 'sitemap-fr.xml', 'sitemap-es.xml', 'sitemap-ja.xml', 'sitemap-pt-BR.xml', 'robots.txt', '_headers', '_redirects']) {
  if (!existsSync(join(distRoot, asset))) fail(`missing generated deployment artifact: ${asset}`);
}

const sitemap = readFileSync(join(distRoot, 'sitemap.xml'), 'utf8');
if (!sitemap.includes('<sitemapindex')) fail('sitemap.xml is not a sitemap index');
const robots = readFileSync(join(distRoot, 'robots.txt'), 'utf8');
const redirects = readFileSync(join(distRoot, '_redirects'), 'utf8');
if (!redirects.includes('/ /en/ 301')) fail('root redirect must permanently consolidate to the English default locale');
for (const [locale] of localeColumns) {
  const childSitemap = readFileSync(join(distRoot, `sitemap-${locale}.xml`), 'utf8');
  if (childSitemap.includes('<lastmod>')) fail(`${locale} sitemap publishes an unverified static lastmod date`);
}
if (releaseReady) {
  if (!robots.includes('Allow: /') || !robots.includes(`Sitemap: ${siteOrigin}/sitemap.xml`)) fail('approved release must allow crawling and reference its sitemap');
  for (const [locale] of localeColumns) {
    const childSitemap = readFileSync(join(distRoot, `sitemap-${locale}.xml`), 'utf8');
    if ((childSitemap.match(/<url>/g) ?? []).length !== records.length) fail(`approved ${locale} sitemap does not contain all manifest routes`);
  }
} else {
  if (!robots.includes('Disallow: /')) fail('draft or preview releases must create a non-indexable robots file');
  if ((sitemap.match(/<loc>/g) ?? []).length !== 0) fail('draft or preview releases must not publish sitemap entries');
}

const notFound = readFileSync(join(distRoot, '404.html'), 'utf8');
if (!notFound.includes('name="robots" content="noindex, nofollow"')) fail('404 must always be noindex');
if (notFound.includes('<link rel="canonical"')) fail('404 must not canonicalize to a public page');
if (notFound.includes('application/ld+json')) fail('404 must not publish structured data');

console.log(`Validated ${paths.length} static locale pages, metadata, hreflang, schemas, links, and ${releaseReady ? 'production' : 'preview-safe'} crawl rules.`);
