export function parseMintSet(raw: string): Set<string> {
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

export function isPoolAgeWhitelisted(
  mintA: string,
  mintB: string,
  whitelist: Set<string>,
): boolean {
  return whitelist.has(mintA) || whitelist.has(mintB);
}

export function applyPoolAgeWhitelistConfig(
  body: Record<string, any>,
  targetConfig: { poolAgeWhitelist: Set<string> },
  envUpdates: Record<string, string> = {},
): Record<string, string> {
  if (!Array.isArray(body.poolAgeWhitelist)) return envUpdates;

  const normalized = new Set(
    body.poolAgeWhitelist.map((s: unknown) => String(s).trim()).filter((s: string) => s.length > 0),
  );

  targetConfig.poolAgeWhitelist.clear();
  for (const mint of normalized) targetConfig.poolAgeWhitelist.add(mint);
  envUpdates.POOL_AGE_WHITELIST = Array.from(normalized).join(',');
  return envUpdates;
}
