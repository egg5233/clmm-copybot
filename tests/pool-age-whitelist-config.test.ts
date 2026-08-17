import assert from 'assert';
import { applyPoolAgeWhitelistConfig } from '../src/utils/pool-age-whitelist';

function fakeConfig(initial: string[] = []) {
  return { poolAgeWhitelist: new Set(initial) };
}

{
  const cfg = fakeConfig();
  const envUpdates: Record<string, string> = {};
  const result = applyPoolAgeWhitelistConfig(
    { poolAgeWhitelist: [' mintA ', '', 'mintB', 'mintA'] },
    cfg,
    envUpdates,
  );

  assert.deepEqual(Array.from(cfg.poolAgeWhitelist), ['mintA', 'mintB'], 'helper should trim, filter, and dedupe');
  assert.equal(envUpdates.POOL_AGE_WHITELIST, 'mintA,mintB', 'helper should persist normalized list');
  assert.equal(result, envUpdates, 'helper should return the envUpdates object it mutated');
}

{
  const cfg = fakeConfig(['mintA']);
  const envUpdates: Record<string, string> = {};
  applyPoolAgeWhitelistConfig({ poolAgeWhitelist: [] }, cfg, envUpdates);

  assert.deepEqual(Array.from(cfg.poolAgeWhitelist), [], 'empty array should clear whitelist');
  assert.equal(envUpdates.POOL_AGE_WHITELIST, '', 'empty array should persist an empty env value');
}

{
  const cfg = fakeConfig(['mintA']);
  const envUpdates: Record<string, string> = {};
  applyPoolAgeWhitelistConfig({}, cfg, envUpdates);

  assert.deepEqual(Array.from(cfg.poolAgeWhitelist), ['mintA'], 'missing field should not mutate config');
  assert.deepEqual(envUpdates, {}, 'missing field should not mutate env updates');
}

