import { PAGES, SITE_ORIGIN, isIndexable } from '../lib/site';

export function GET() {
  const releaseReady = PAGES.every(isIndexable);
  const body = releaseReady
    ? `User-agent: *\nAllow: /\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`
    : 'User-agent: *\nDisallow: /\n';
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
