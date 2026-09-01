import { readFileSync } from 'node:fs';

import { chromium } from 'playwright';

const processStatus = readFileSync('/proc/self/status', 'utf8');
if (
  process.getuid?.() === 0 ||
  !/^CapEff:\s+0+$/m.test(processStatus) ||
  !/^NoNewPrivs:\s+1$/m.test(processStatus) ||
  !/^Seccomp:\s+2$/m.test(processStatus)
) {
  throw new Error('QA browser process is missing its required outer container isolation');
}

const browser = await chromium.launch({
  headless: true,
  channel: 'chromium',
  // Ubuntu 23.10+ can forbid Chromium user namespaces based on host AppArmor
  // policy. The Action instead supplies a non-root, zero-capability, read-only,
  // no-new-privileges, seccomp-confined container around this trusted E2E target.
  chromiumSandbox: false,
});

try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><title>juror-browser-smoke</title>');
  if (await page.title() !== 'juror-browser-smoke') throw new Error('Chromium page smoke failed');
  console.log(`container-isolated Chromium ${browser.version()}`);
} finally {
  await browser.close();
}
