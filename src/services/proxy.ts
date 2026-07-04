import { readFileSync } from 'node:fs';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import { HttpsProxyAgent } from 'https-proxy-agent';
import axios from 'axios';

/**
 * Route ALL outbound HTTP through a proxy. Required on this host: the
 * Cantonloop auth endpoint (/pair/apikey) returns 403 "expired epoch" from
 * datacenter IPs, but succeeds through a residential proxy. Two transports:
 *  - fetch (loop-sdk wallet auth + tx submit) → undici global dispatcher
 *  - axios (temple-canton-js REST: disclosures, factory, submit) → httpsAgent
 *
 * Both libraries import their default singletons, so configuring the global
 * dispatcher and axios.defaults here affects the SDKs too.
 */
let applied: string | undefined;
let appliedScope: ProxyScope = 'wallet';

/**
 * - 'wallet': proxy ONLY fetch (loop-sdk → cantonloop auth + tx submit). Temple
 *   REST (axios: trading, balances, disclosures) goes direct. Minimal proxy
 *   bandwidth; trading is the high-volume traffic and does not need a proxy.
 * - 'all': also route axios (Temple REST) through the proxy. Use if Temple's
 *   trading API ever IP-blocks this host too.
 */
export type ProxyScope = 'wallet' | 'all';

export function applyProxy(url: string | undefined, scope: ProxyScope = 'wallet'): void {
  if (!url) return;
  // fetch (loop-sdk / cantonloop) — always proxied; this is what needs it.
  setGlobalDispatcher(new ProxyAgent(url));
  if (scope === 'all') {
    const agent = new HttpsProxyAgent(url);
    axios.defaults.httpsAgent = agent;
    axios.defaults.httpAgent = agent;
    axios.defaults.proxy = false; // use our agent for HTTPS CONNECT
  }
  applied = url;
  appliedScope = scope;
}

export function maskedProxy(): string {
  return applied ? `${applied.replace(/\/\/[^@]*@/, '//***@')} [scope=${appliedScope}]` : '(none)';
}

/** Mask credentials in a proxy URL for logging. */
export function maskProxy(url: string): string {
  return url.replace(/\/\/[^@]*@/, '//***@');
}

/** Parse PROXY_LIST (newline/comma separated) into entries; PROXY_URL is single. */
export function parseProxyList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Load a proxy pool from a plain text file (one proxy URL per line) — the easy
 * way to manage proxies without cramming them into an env var. Blank lines and
 * lines starting with `#` (comments) are ignored. A missing file yields []
 * (proxies are optional; trading runs direct). NEVER commit this file: it holds
 * proxy credentials and the repo is public — keep proxy.txt in .gitignore.
 */
export function loadProxyFile(path: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((l) => l && !l.startsWith('#'));
}
