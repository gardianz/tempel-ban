import { chromium } from 'playwright';
import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Opens a REAL headed Chromium (WSLg) at the Temple trade app so the user can
 * log in. Captures every request to the Temple app's auth endpoints and to
 * cantonloop.com (especially /.connect/pair/* and /tickets/*), including the
 * Authorization Bearer token and request/response bodies — so we can see EXACTLY
 * how a real deposit authenticates, and port it.
 *
 * Captures are appended to capture/network.ndjson. The auth token is masked in
 * the console but written in full to capture/token.txt (gitignored) for reuse.
 *
 *   npx tsx src/capture-browser.ts
 */

const OUTDIR = resolve(process.cwd(), 'capture');
mkdirSync(OUTDIR, { recursive: true });
const LOG = resolve(OUTDIR, 'network.ndjson');
const TOKEN_FILE = resolve(OUTDIR, 'token.txt');
writeFileSync(LOG, '');

const INTEREST = (url: string) =>
  url.includes('cantonloop.com') ||
  url.includes('/.connect/') ||
  url.includes('/api/auth/') ||
  url.includes('/api/v1/auth/') ||
  url.includes('templedigitalgroup.com/api/');

const mask = (t?: string) => (t ? t.slice(0, 12) + '…' + t.slice(-6) + ` (len ${t.length})` : '(none)');

let lastToken = '';

const ctx = await chromium.launchPersistentContext(resolve(OUTDIR, 'userdata'), {
  headless: false,
  viewport: { width: 1400, height: 900 },
  args: ['--disable-blink-features=AutomationControlled'],
});

ctx.on('request', (req) => {
  const url = req.url();
  if (!INTEREST(url)) return;
  const auth = req.headers()['authorization'];
  if (auth?.startsWith('Bearer ')) {
    const tok = auth.slice(7);
    if (tok !== lastToken) {
      lastToken = tok;
      writeFileSync(TOKEN_FILE, tok);
      console.log(`\n🔑 Bearer captured on ${new URL(url).host}: ${mask(tok)} → saved capture/token.txt`);
    }
  }
  let postData: string | undefined;
  try {
    postData = req.postData() ?? undefined;
  } catch {
    /* binary */
  }
  appendFileSync(
    LOG,
    JSON.stringify({
      t: new Date().toISOString(),
      kind: 'req',
      method: req.method(),
      url,
      authorization: auth ? 'Bearer ' + auth.slice(7) : undefined, // full token, local file only
      postData: postData?.slice(0, 4000),
    }) + '\n',
  );
});

ctx.on('response', async (res) => {
  const url = res.url();
  if (!INTEREST(url)) return;
  let body = '';
  try {
    body = (await res.text()).slice(0, 4000);
  } catch {
    /* ignore */
  }
  const path = new URL(url).pathname;
  appendFileSync(
    LOG,
    JSON.stringify({ t: new Date().toISOString(), kind: 'res', status: res.status(), url, body }) + '\n',
  );
  // Surface the interesting deposit/auth endpoints live.
  if (/\.connect\/(pair|tickets)|auth\/(verify|sign-in|login|mfa)/.test(path)) {
    console.log(`← ${res.status()}  ${path}`);
  }
});

const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto('https://app.templedigitalgroup.com/trade', { waitUntil: 'domcontentloaded' }).catch(() => {});

console.log('\n=== BROWSER OPEN ===');
console.log('1. Login ke Temple app di jendela browser (email + password + MFA).');
console.log('2. Buka panel DEPOSIT, lakukan 1 deposit kecil (mis. USDA) sampai SELESAI.');
console.log('   Semua request auth + cantonloop /.connect/* terekam ke capture/network.ndjson');
console.log('   Token Bearer tersimpan ke capture/token.txt');
console.log('3. Selesai? Tutup jendela browser (atau Ctrl+C) untuk berhenti.\n');

await new Promise<void>((done) => {
  ctx.on('close', () => done());
});
console.log('Browser closed. Captures in capture/network.ndjson');
