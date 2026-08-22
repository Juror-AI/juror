import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const manifestPath = join(repositoryRoot, 'docs', 'seo-route-manifest.csv');
const siteOrigin = process.env.SITE_ORIGIN || '';

function fail(message) {
  throw new Error(`Marketing production release is blocked: ${message}`);
}

if (process.env.CONTENT_RELEASE !== 'approved') {
  fail('set CONTENT_RELEASE=approved only after all editorial, technical, legal, and evidence signoffs are recorded.');
}

let origin;
try {
  origin = new URL(siteOrigin);
} catch {
  fail('set SITE_ORIGIN to the final https custom-domain origin.');
}

if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash) {
  fail('SITE_ORIGIN must be an https origin with no path, query, or hash.');
}
if (origin.hostname.endsWith('.example') || origin.hostname.endsWith('.workers.dev') || origin.hostname === 'localhost') {
  fail('SITE_ORIGIN must be the final custom production domain, not an example, localhost, or workers.dev hostname.');
}

const [header, ...lines] = readFileSync(manifestPath, 'utf8').trim().split(/\r?\n/);
const columns = header.split(',');
const statusIndex = columns.indexOf('localization_status');
if (statusIndex < 0) fail('route manifest is missing localization_status.');
const pending = lines
  .map((line) => line.split(','))
  .filter((fields) => !fields[statusIndex]?.startsWith('approved_'))
  .map((fields) => fields[0]);

if (pending.length > 0) {
  fail(`${pending.length} manifest records are not approved (${pending.slice(0, 5).join(', ')}${pending.length > 5 ? ', …' : ''}).`);
}

console.log(`Production release gate passed for ${origin.origin}: all ${lines.length} route records are approved.`);
