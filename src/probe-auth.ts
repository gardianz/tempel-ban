import 'dotenv/config';
import { getSigner } from '../node_modules/@fivenorth/loop-sdk/dist/server/signer.js';
import { loadEnv } from './config/index.js';

const env = loadEnv();
const signer = getSigner(env.LOOP_PRIVATE_KEY, env.LOOP_PARTY_ID);
const publicKey = signer.getPublicKey();
const epoch = Date.now();
const signature = signer.signMessageAsHex(`Exchange API Key for ${signer.getPartyId()}\nTimestamp: ${epoch}`);

console.log('partyId   :', signer.getPartyId());
console.log('publicKey :', publicKey.slice(0, 40), '...');

async function tryAuth(label: string, ep: number, sig: string) {
  const res = await fetch('https://cantonloop.com/api/v1/.connect/pair/apikey', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ public_key: publicKey, signature: sig, epoch: ep }),
  });
  console.log(`\n[${label}] epoch=${ep} -> HTTP ${res.status} ${res.statusText}`);
  console.log('  body:', await res.text());
}

// A) exactly what the SDK does: epoch = ms, signature over ms
await tryAuth('SDK ms', epoch, signature);

// B) epoch = seconds, signature over seconds
const epochSec = Math.floor(epoch / 1000);
const sigSec = signer.signMessageAsHex(`Exchange API Key for ${signer.getPartyId()}\nTimestamp: ${epochSec}`);
await tryAuth('seconds', epochSec, sigSec);

// C) epoch = seconds, but signature still over ms (mismatch test)
await tryAuth('sec epoch / ms sig', epochSec, signature);

// D) FUTURE epoch (ms): if accepted, the server wants epoch >= its own clock
for (const ahead of [3000, 10000, 30000]) {
  const ep = Date.now() + ahead;
  const sig = signer.signMessageAsHex(`Exchange API Key for ${signer.getPartyId()}\nTimestamp: ${ep}`);
  await tryAuth(`ms +${ahead}ms future`, ep, sig);
}
