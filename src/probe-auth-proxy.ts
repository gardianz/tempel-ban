import 'dotenv/config';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import forge from 'node-forge';
import { getSigner } from '../node_modules/@fivenorth/loop-sdk/dist/server/signer.js';

/**
 * Test whether routing the Cantonloop auth (/pair/apikey) through a PROXY
 * changes the "expired epoch" 403 — i.e. whether the rejection is IP-based.
 *
 *   PROXY_URL=http://user:pass@host:port npx tsx src/probe-auth-proxy.ts
 *   (or pass --proxy=http://host:port)
 */

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`${name}=`));
  return hit?.split('=').slice(1).join('=');
}

const proxy = process.env.PROXY_URL ?? arg('--proxy');
if (!proxy) throw new Error('Set PROXY_URL or --proxy=http://user:pass@host:port');
setGlobalDispatcher(new ProxyAgent(proxy));
console.log('proxy     :', proxy.replace(/\/\/[^@]*@/, '//***@'));

// Confirm the proxy is actually carrying our traffic.
try {
  const ipRes = await fetch('https://api.ipify.org?format=json');
  console.log('exit IP   :', await ipRes.text());
} catch (e) {
  console.log('exit IP   : (ip check failed:', (e as Error).message, ')');
}

const pk = (process.env.LOOP_PRIVATE_KEY ?? '').trim();
const party = process.env.LOOP_PARTY_ID ?? '';
const signer = getSigner(pk, party);
const publicKey = signer.getPublicKey();
const epoch = Date.now();
const signature = signer.signMessageAsHex(`Exchange API Key for ${signer.getPartyId()}\nTimestamp: ${epoch}`);

const r = await fetch('https://cantonloop.com/api/v1/.connect/pair/apikey', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ public_key: publicKey, signature, epoch }),
});
console.log(`\n/pair/apikey -> HTTP ${r.status} ${r.statusText}`);
const body = await r.text();
console.log('body:', body);
if (r.ok) {
  try {
    const j = JSON.parse(body);
    if (j.api_key) console.log('\n✅ PROXY UNBLOCKS AUTH — api_key received. Loop path viable via proxy.');
  } catch {
    /* ignore */
  }
} else {
  console.log('\n❌ Still rejected via proxy → not IP-based (epoch/signature/account issue).');
}
