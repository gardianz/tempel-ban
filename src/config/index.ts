import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { configSchema, envSchema, type Config, type Env, type PairConfig } from './schema.js';

export type { Config, Env, PairConfig };
export { configSchema, envSchema };

/** Parse + validate config.json. Throws a readable error on failure. */
export function loadConfig(path = 'config.json'): Config {
  const abs = resolve(process.cwd(), path);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(abs, 'utf8'));
  } catch (e) {
    throw new Error(`Cannot read/parse config at ${abs}: ${(e as Error).message}`);
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid config.json:\n${formatZod(parsed.error)}`);
  }
  return parsed.data;
}

/** Validate process.env into a typed Env. The SDK loads .env via dotenv. */
export function loadEnv(env: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${formatZod(parsed.error)}`);
  }
  return parsed.data;
}

/** Resolve the effective budget for a pair (override or global). */
export function budgetFor(config: Config, pair: PairConfig): number {
  return pair.budgetPerOrder ?? config.budgetPerOrder;
}

function formatZod(err: import('zod').ZodError): string {
  return err.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
}
