import 'dotenv/config';
import * as forge from 'node-forge';

/**
 * READ-ONLY probe of the Cantonloop email-challenge auth (the method the working
 * Python reference uses, instead of loop-sdk's dead /pair/apikey epoch flow).
 *
 * Does ONLY: sign-in -> sign challenge -> verify. No deposit, no tx. Confirms
 * whether email-auth returns tokens for this account today.
 *
 *   CANTON_EMAIL=you@example.com npx tsx src/probe-login.ts
 *   (or add CANTON_EMAIL to .env)
 */

const BASE = 'https://cantonloop.com';

function normalizePk(pk: string): string {
  const c = pk.trim().toLowerCase().replace(/0x/g, '').replace(/[^0-9a-f]/g, '');
  if (c.length === 64) return c;
  if (c.length === 128) return c.slice(0, 64);
  throw new Error(`bad private key length ${c.length} (need 64 or 128 hex)`);
}

const email = process.env.CANTON_EMAIL ?? process.env.TEMPLE_EMAIL ?? '';
const pkHex = process.env.LOOP_PRIVATE_KEY ?? process.env.CANTON_PRIVATE_KEY ?? '';
if (!email) throw new Error('Set CANTON_EMAIL (your cantonloop.com account email)');
if (!pkHex) throw new Error('Set LOOP_PRIVATE_KEY / CANTON_PRIVATE_KEY');

const seed = Buffer.from(normalizePk(pkHex), 'hex');
const kp = forge.pki.ed25519.generateKeyPair({ seed });
const publicKeyHex = Buffer.from(kp.publicKey).toString('hex');

const headers = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/plain, */*',
  Origin: BASE,
  Referer: BASE + '/dashboard',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
};

console.log('email     :', email);
console.log('publicKey :', publicKeyHex);

const r1 = await fetch(`${BASE}/api/v1/auth/sign-in`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ email }),
});
console.log(`\nsign-in   -> HTTP ${r1.status} ${r1.statusText}`);
const t1 = await r1.text();
if (!r1.ok) {
  console.log('body:', t1);
  process.exit(1);
}
const challenge = JSON.parse(t1).challenge as string;
console.log('challenge :', challenge.slice(0, 32), '...');

const sig = forge.pki.ed25519.sign({
  message: Buffer.from(challenge, 'hex'),
  privateKey: kp.privateKey,
});
const signedHex = Buffer.from(sig).toString('hex');

const r2 = await fetch(`${BASE}/api/v1/auth/verify?continue=/dashboard`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ email, challenge, public_key: publicKeyHex, signed: signedHex }),
});
console.log(`\nverify    -> HTTP ${r2.status} ${r2.statusText}`);
const t2 = await r2.text();
try {
  const j = JSON.parse(t2);
  const at = j.access_token?.token ?? j.access_token;
  console.log('access_token present:', Boolean(at));
  console.log('keys:', Object.keys(j).join(', '));
  if (at) console.log('\n✅ EMAIL-AUTH WORKS. Porting deposit to TS is viable.');
} catch {
  console.log('body:', t2.slice(0, 400));
}
