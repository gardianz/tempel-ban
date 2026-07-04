import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { Config } from '../config/index.js';

/** Symbols currently marked enabled in the config. */
function enabledSymbols(config: Config): string[] {
  return config.pairs.filter((p) => p.enabled).map((p) => p.symbol);
}

/** Set which pairs are enabled by symbol (case-insensitive); everything else off. */
function applySelection(config: Config, symbols: Set<string>): void {
  for (const p of config.pairs) p.enabled = symbols.has(p.symbol.toUpperCase());
}

/**
 * Interactive pair picker shown at startup: lists the configured pairs and lets
 * the user choose which to run this session (mutates `config.pairs[].enabled`).
 *
 * Non-interactive fallbacks (so scripted/headless runs still work):
 *  - `PAIRS` env (comma/space-separated symbols) → use those, skip the prompt.
 *  - no TTY → keep the config's `enabled` flags as-is.
 *  - empty answer → keep config; `all` → every pair; a number list → those pairs.
 *
 * Returns the list of symbols that end up enabled.
 */
export async function selectPairsInteractive(config: Config): Promise<string[]> {
  // 1. PAIRS env override (automation): match by symbol, skip the prompt.
  const pre = process.env.PAIRS?.trim();
  if (pre) {
    const want = new Set(pre.split(/[,\s]+/).filter(Boolean).map((s) => s.toUpperCase()));
    applySelection(config, want);
    return enabledSymbols(config);
  }

  // 2. Headless / non-TTY: nothing to prompt — use the config flags.
  if (!input.isTTY || !output.isTTY) return enabledSymbols(config);

  const rl = createInterface({ input, output });
  try {
    output.write('\n=== TEMPLE BOT — pilih pair yang dijalankan ===\n');
    config.pairs.forEach((p, i) => {
      const tags = [
        p.side,
        p.pingpong ? 'pingpong' : 'single',
        p.orderType ?? 'limit',
        p.quantityPerOrder !== undefined ? `qty ${p.quantityPerOrder}` : 'budget',
      ].join(', ');
      output.write(`  ${i + 1}) ${p.symbol.padEnd(12)} (${tags}) [config: ${p.enabled ? 'on' : 'off'}]\n`);
    });

    const ans = (await rl.question("Pilih (mis. 1,2  /  'all'  /  Enter = pakai config): ")).trim().toLowerCase();

    if (ans === '') {
      const en = enabledSymbols(config);
      output.write(`→ pakai config: ${en.join(', ') || '(tidak ada)'}\n\n`);
      return en;
    }
    if (ans === 'all') {
      for (const p of config.pairs) p.enabled = true;
    } else {
      const idxs = new Set(
        ans
          .split(/[,\s]+/)
          .map((s) => Number.parseInt(s, 10) - 1)
          .filter((n) => Number.isInteger(n) && n >= 0 && n < config.pairs.length),
      );
      if (idxs.size === 0) {
        const en = enabledSymbols(config);
        output.write(`input tak valid → pakai config: ${en.join(', ') || '(tidak ada)'}\n\n`);
        return en;
      }
      config.pairs.forEach((p, i) => (p.enabled = idxs.has(i)));
    }

    const en = enabledSymbols(config);
    output.write(`→ dijalankan: ${en.join(', ') || '(tidak ada — bot idle)'}\n\n`);
    return en;
  } finally {
    rl.close();
  }
}
