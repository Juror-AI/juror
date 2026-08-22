import { LOCALES, PAGES, SITE_ORIGIN, isIndexable } from '../lib/site';

export function GET() {
  const entries = LOCALES
    .filter(() => PAGES.some((page) => isIndexable(page)))
    .map((locale) => `  <sitemap><loc>${SITE_ORIGIN}/sitemap-${locale.code}.xml</loc></sitemap>`)
    .join('\n');
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</sitemapindex>\n`;
  return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
}
