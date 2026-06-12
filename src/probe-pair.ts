import 'dotenv/config';

/**
 * READ-ONLY check: does a browser-extracted Cantonloop token authenticate the
 * /.connect/pair/* endpoints (the ones deposit needs)? No tx, no deposit.
 *
 * Set CANTON_PAIR_TOKEN in .env (see instructions), then:
 *   npx tsx src/probe-pair.ts
 */

const BASE = 'https://cantonloop.com';
const token = (process.env.CANTON_PAIR_TOKEN ?? '').trim();
if (!token) throw new Error('Set CANTON_PAIR_TOKEN in .env (Bearer token from your logged-in cantonloop.com browser session)');

const headers = {
  Accept: 'application/json',
  Authorization: `Bearer ${token}`,
  Origin: 'https://app.templedigitalgroup.com',
  Referer: 'https://app.templedigitalgroup.com/trade',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
};

async function get(path: string) {
  const r = await fetch(`${BASE}${path}`, { headers });
  const body = await r.text();
  console.log(`\nGET ${path} -> HTTP ${r.status} ${r.statusText}`);
  console.log('  body:', body.slice(0, 400));
  return { status: r.status, body };
}

const acct = await get('/api/v1/.connect/pair/account');
if (acct.status === 200) {
  try {
    const j = JSON.parse(acct.body);
    console.log('\n✅ TOKEN WORKS. party_id =', j.party_id ?? '(check body)');
    console.log('→ Deposit port is viable. Next: fetch UTXOs + build allocation.');
  } catch {
    console.log('200 but non-JSON body.');
  }
} else {
  console.log('\n❌ Token rejected. Re-extract a fresh token from the browser (it may be short-lived).');
}
