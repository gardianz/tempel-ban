import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PersistedStats } from '../state/store.js';

/**
 * Tiny JSON persistence for cumulative stats so a restart doesn't reset them.
 * All IO is best-effort: a missing/corrupt file yields `undefined`, and a failed
 * write is swallowed — stats are never allowed to break trading.
 */
export function loadStats(path: string): PersistedStats | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PersistedStats;
  } catch {
    return undefined;
  }
}

/** Atomically write stats (tmp file + rename) so a crash can't truncate it. */
export function saveStats(path: string, data: PersistedStats): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, path);
  } catch {
    /* non-fatal */
  }
}
