const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function stableHash(text: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

export function pickPromptForDate(prompts: readonly string[], dateKey: string): string {
  if (prompts.length === 0) return "";
  const index = stableHash(dateKey) % prompts.length;
  return prompts[index] ?? "";
}

export function nextPromptAfter(current: string, pool: readonly string[]): string {
  if (pool.length === 0) return "";
  const index = pool.indexOf(current);
  if (index === -1) return pool[0] ?? "";
  return pool[(index + 1) % pool.length] ?? "";
}
