import 'dotenv/config';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import { loadEnv } from './config/index.js';
import { parseProxyList } from './services/proxy.js';

/**
 * Discover the server's rate-limit headers. Hits a READ endpoint (no orders)
 * and dumps every response header; many APIs return X-RateLimit-Limit /
 * -Remaining / -Reset and Retry-After. Then fires a quick burst to try to
 * surface a 429 and its headers.
 */
const env = loadEnv();
const proxy = env.PROXY_URL ?? parseProxyList(env.PROXY_LIST)[0];
if (proxy) setGlobalDispatcher(new ProxyAgent(proxy));

const BASE = 'https://api.templedigitalgroup.com';
const headers = { 'X-API-Key': env.TEMPLE_API_KEY, 'Content-Type': 'application/json' };
const url = `${BASE}/api/v1/market/orderbook?symbol=${encodeURIComponent('CBTC/USDA')}`;

function dumpHeaders(label: string, h: Headers) {
  console.log(`\n[${label}] headers:`);
  for (const [k, v] of h.entries()) {
    if (/rate|limit|retry|quota|remaining|reset/i.test(k)) console.log(`  ★ ${k}: ${v}`);
    else console.log(`    ${k}: ${v}`);
  }
}

const r1 = await fetch(url, { headers });
console.log(`single GET orderbook -> HTTP ${r1.status}`);
dumpHeaders('single', r1.headers);

console.log('\n--- burst to provoke 429 ---');
let got429 = false;
for (let i = 0; i < 80 && !got429; i++) {
  const r = await fetch(url, { headers });
  if (r.status === 429) {
    got429 = true;
    console.log(`\n429 after ${i + 1} rapid requests`);
    dumpHeaders('429', r.headers);
    console.log('429 body:', (await r.text()).slice(0, 300));
  }
}
if (!got429) console.log('No 429 in 80 rapid requests (read endpoint limit higher, or no per-min cap on reads).');
