import { chromium } from 'playwright';

const browser = await chromium.launch({
  headless: true,
  channel: 'chromium',
  chromiumSandbox: true,
});

try {
  const page = await browser.newPage();
  await page.goto('chrome://sandbox');
  const status = await page.locator('body').innerText();
  if (!/Seccomp-BPF sandbox\s+Yes/.test(status) || !status.includes('You are adequately sandboxed.')) {
    throw new Error('Chromium started without the required namespace and seccomp sandbox');
  }
  console.log(`sandboxed Chromium ${browser.version()}`);
} finally {
  await browser.close();
}
