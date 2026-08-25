/**
 * Reads a required env var, throwing a clear error if unset - no
 * hardcoded fallback anywhere. Used for model IDs specifically so a
 * missing/stale config fails loudly at call time instead of silently
 * falling back to whatever string happened to be hardcoded at write
 * time (see the earlier openai.client.ts fix for the failure mode
 * this avoids).
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}
