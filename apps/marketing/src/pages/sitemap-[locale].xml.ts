import { LOCALES, PAGES, SITE_ORIGIN, isIndexable, pagePath, type Locale } from '../lib/site';

export function getStaticPaths() {
  return LOCALES.map((locale) => ({ params: { locale: locale.code } }));
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'\"]/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[character] ?? character);
}

export function GET({ params }: { params: { locale?: string } }) {
  const locale = params.locale as Locale;
  const urls = PAGES
    .filter(isIndexable)
    .map((page) => `  <url><loc>${escapeXml(`${SITE_ORIGIN}${pagePath(page, locale)}`)}</loc><lastmod>2026-08-22</lastmod></url>`)
    .join('\n');
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
}
