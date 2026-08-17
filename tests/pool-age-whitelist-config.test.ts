import { describe, expect, it } from 'vitest';

import { applyPoolAgeWhitelistConfig } from '../src/utils/pool-age-whitelist';

function fakeConfig(initial: string[] = []) {
  return { poolAgeWhitelist: new Set(initial) };
}

describe('applyPoolAgeWhitelistConfig', () => {
  it('trims, filters, and dedupes the incoming list, then persists it to env updates', () => {
    const cfg = fakeConfig();
    const envUpdates: Record<string, string> = {};

    const result = applyPoolAgeWhitelistConfig(
      { poolAgeWhitelist: [' mintA ', '', 'mintB', 'mintA'] },
      cfg,
      envUpdates,
    );

    expect(Array.from(cfg.poolAgeWhitelist)).toEqual(['mintA', 'mintB']);
    expect(envUpdates.POOL_AGE_WHITELIST).toBe('mintA,mintB');
    expect(result).toBe(envUpdates);
  });

  it('clears the whitelist and persists an empty env value for an empty array', () => {
    const cfg = fakeConfig(['mintA']);
    const envUpdates: Record<string, string> = {};

    applyPoolAgeWhitelistConfig({ poolAgeWhitelist: [] }, cfg, envUpdates);

    expect(Array.from(cfg.poolAgeWhitelist)).toEqual([]);
    expect(envUpdates.POOL_AGE_WHITELIST).toBe('');
  });

  it('leaves config and env updates untouched when the field is missing', () => {
    const cfg = fakeConfig(['mintA']);
    const envUpdates: Record<string, string> = {};

    applyPoolAgeWhitelistConfig({}, cfg, envUpdates);

    expect(Array.from(cfg.poolAgeWhitelist)).toEqual(['mintA']);
    expect(envUpdates).toEqual({});
  });
});
