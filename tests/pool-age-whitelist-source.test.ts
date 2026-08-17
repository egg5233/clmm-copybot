import assert from 'assert';
import fs from 'fs';
import path from 'path';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf-8');
}

const configSource = read('src/config.ts');
const serverSource = read('src/dashboard/server.ts');
const uiSource = read('public/index.html');
const byrealSource = read('src/executor/byreal-position.ts');

assert.ok(configSource.includes("import { parseMintSet } from './utils/pool-age-whitelist'"), 'config should import parseMintSet');
assert.ok(configSource.includes("poolAgeWhitelist: parseMintSet(process.env.POOL_AGE_WHITELIST || '')"), 'config should parse POOL_AGE_WHITELIST');

assert.ok(serverSource.includes("applyPoolAgeWhitelistConfig"), 'server should use pool age whitelist helper');
assert.ok(serverSource.includes("from '../utils/pool-age-whitelist'"), 'server should import helper from env-free utility');
assert.ok(serverSource.includes('poolAgeWhitelist: Array.from(config.poolAgeWhitelist)'), 'GET /api/config should expose poolAgeWhitelist string array');
assert.ok(serverSource.includes('poolAgeWhitelist'), 'PATCH /api/config should destructure poolAgeWhitelist');
assert.ok(serverSource.includes('applyPoolAgeWhitelistConfig({ poolAgeWhitelist }, config, envUpdates)'), 'PATCH /api/config should persist pool age whitelist via helper');

assert.ok(uiSource.includes('var currentPoolAgeWhitelist = []'), 'UI should track pool age whitelist state');
assert.ok(uiSource.includes('c.poolAgeWhitelist'), 'UI loadConfig should read poolAgeWhitelist');
assert.ok(uiSource.includes('poolAgeWhitelist: poolAgeWhitelist'), 'UI saveConfig should send poolAgeWhitelist');
assert.ok(uiSource.includes('poolAgeWhitelistCount'), 'UI should render pool age whitelist count');

const minAgeIdx = uiSource.indexOf('cfgMinPoolAgeDays');
const poolAgeInputIdx = uiSource.indexOf('poolAgeWlMintInput');
const byrealCapIdx = uiSource.indexOf('cfgByrealMaxOpenPositions');
assert.ok(minAgeIdx >= 0 && poolAgeInputIdx > minAgeIdx, 'pool age whitelist controls should appear after min pool age input');
assert.ok(byrealCapIdx >= 0 && poolAgeInputIdx < byrealCapIdx, 'pool age whitelist controls should appear before Byreal position cap');
assert.ok(uiSource.indexOf('function addToPoolAgeWhitelist') < uiSource.indexOf('function saveConfig'), 'pool age add helper should be defined before saveConfig');
assert.ok(uiSource.indexOf('function renderPoolAgeWhitelistDisplay') < uiSource.indexOf('function saveConfig'), 'pool age render helper should be defined before saveConfig');

assert.ok(byrealSource.includes("import { isPoolAgeWhitelisted } from '../utils/pool-age-whitelist'"), 'Byreal executor should import whitelist helper');
const guard = 'config.minPoolAgeDays > 0 && !isPoolAgeWhitelisted(mintAStr, mintBStr, config.poolAgeWhitelist)';
assert.equal((byrealSource.match(new RegExp(guard.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 2, 'Byreal age guard should be applied to OPEN and INCREASE only');

for (const block of byrealSource.split(guard).slice(1)) {
  const ageBlock = block.slice(0, block.indexOf('//') >= 0 ? block.indexOf('//') : 800);
  assert.ok(ageBlock.includes('getPoolInfo(mintAStr)'), 'each guarded age block should include getPoolInfo');
  assert.ok(ageBlock.includes('pool too new'), 'each guarded age block should contain the pool age skip');
}

assert.ok(byrealSource.includes('config.poolTvlWhitelist.has(mint)'), 'Byreal TVL checks should still use poolTvlWhitelist');
for (const line of byrealSource.split(/\r?\n/)) {
  if (line.includes('TVL') || line.includes('poolTvlWhitelist')) {
    assert.ok(!line.includes('poolAgeWhitelist'), 'TVL-related lines should not use poolAgeWhitelist');
  }
}

for (const file of [
  'src/executor/orca-position.ts',
  'src/executor/meteora-position.ts',
  'src/executor/pancakeswap-position.ts',
  'src/executor/dammv2-position.ts',
]) {
  assert.ok(!read(file).includes('poolAgeWhitelist'), `${file} should not reference poolAgeWhitelist`);
}

