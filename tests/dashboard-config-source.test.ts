import assert from 'assert';
import fs from 'fs';
import path from 'path';

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'server.ts'), 'utf-8');
const uiSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');
const poolAgeWhitelistSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'utils', 'pool-age-whitelist.ts'), 'utf-8');

assert.ok(
  serverSource.includes('byrealAllowSameTickWallets'),
  'dashboard config API should expose byrealAllowSameTickWallets',
);
assert.ok(
  serverSource.includes('byrealAllowOpenAfterOthersWallets'),
  'dashboard config API should expose byrealAllowOpenAfterOthersWallets',
);
assert.ok(
  serverSource.includes('BYREAL_ALLOW_SAME_TICK_WALLETS'),
  'dashboard config PATCH should persist BYREAL_ALLOW_SAME_TICK_WALLETS',
);
assert.ok(
  serverSource.includes('BYREAL_ALLOW_OPEN_AFTER_OTHERS_WALLETS'),
  'dashboard config PATCH should persist BYREAL_ALLOW_OPEN_AFTER_OTHERS_WALLETS',
);
assert.ok(
  serverSource.includes('normalizeByrealAllowSameTickWallets'),
  'dashboard config PATCH should prune allow-same-tick wallets through helper',
);
assert.ok(
  serverSource.includes('serializeWalletSet'),
  'dashboard config PATCH should serialize allow-same-tick wallets through helper',
);
assert.ok(
  serverSource.includes('byrealMaxOpenPositions'),
  'dashboard config API should expose byrealMaxOpenPositions',
);
assert.ok(
  serverSource.includes('BYREAL_MAX_OPEN_POSITIONS'),
  'dashboard config PATCH should persist BYREAL_MAX_OPEN_POSITIONS',
);
assert.ok(
  serverSource.includes('poolAgeWhitelist'),
  'dashboard config API should expose poolAgeWhitelist',
);
assert.ok(
  serverSource.includes('applyPoolAgeWhitelistConfig') &&
    poolAgeWhitelistSource.includes('POOL_AGE_WHITELIST'),
  'dashboard config PATCH should persist POOL_AGE_WHITELIST through the pool age whitelist helper',
);
assert.ok(
  serverSource.includes('normalizeByrealMaxOpenPositions'),
  'dashboard config PATCH should normalize byrealMaxOpenPositions through helper',
);
assert.ok(
  serverSource.includes("BYREAL_MAX_OPEN_POSITIONS = String(normalizedByrealMaxOpenPositions)") ||
    serverSource.includes("BYREAL_MAX_OPEN_POSITIONS: String(normalizedByrealMaxOpenPositions)"),
  'dashboard config PATCH should persist invalid byrealMaxOpenPositions as normalized 0 instead of omitting the key',
);
assert.ok(
  uiSource.includes('walletAllowSameTickValues'),
  'wallet matrix UI should track allow-same-tick checkbox state',
);
assert.ok(
  uiSource.includes('cfgByrealMaxOpenPositions'),
  'dashboard UI should include cfgByrealMaxOpenPositions input',
);
assert.ok(
  uiSource.includes('currentPoolAgeWhitelist'),
  'dashboard UI should track pool age whitelist state',
);
assert.ok(
  uiSource.includes('c.poolAgeWhitelist'),
  'dashboard UI loadConfig should read poolAgeWhitelist',
);
assert.ok(
  uiSource.includes('poolAgeWhitelist: poolAgeWhitelist'),
  'dashboard UI saveConfig should send poolAgeWhitelist',
);
assert.ok(
  uiSource.includes('Pool age whitelist'),
  'dashboard UI save summary should mention pool age whitelist',
);
assert.ok(
  uiSource.includes('c.byrealMaxOpenPositions'),
  'dashboard UI loadConfig should read byrealMaxOpenPositions',
);
assert.ok(
  uiSource.includes('byrealMaxOpenPositions: byrealMaxOpenPositions'),
  'dashboard UI saveConfig should send byrealMaxOpenPositions',
);
assert.ok(
  uiSource.includes('Byreal max positions'),
  'dashboard UI save summary should mention Byreal max positions',
);
assert.ok(
  uiSource.includes('walletAllowOpenAfterOthersValues'),
  'wallet matrix UI should track allow-open-after-others checkbox state',
);
assert.ok(
  uiSource.includes('byrealAllowSameTickWallets'),
  'wallet matrix payload/load logic should include byrealAllowSameTickWallets',
);
assert.ok(
  uiSource.includes('byrealAllowOpenAfterOthersWallets'),
  'wallet matrix payload/load logic should include byrealAllowOpenAfterOthersWallets',
);
assert.ok(
  uiSource.includes('別人可開他開過的'),
  'wallet matrix should render the source-direction same-tick label',
);
assert.ok(
  uiSource.includes('他可開別人開過的'),
  'wallet matrix should render the candidate-direction same-tick label',
);
assert.ok(
  uiSource.includes('walletAllowOpenAfterOthersValues[oldAddr]'),
  'wallet address edits should migrate allow-open-after-others state',
);
assert.ok(
  uiSource.includes('delete walletAllowOpenAfterOthersValues[addr]'),
  'wallet row removal should clean allow-open-after-others state',
);
assert.ok(
  uiSource.includes('allowOpenAfterOthers') && uiSource.includes("st === 'full' ? '' : ' disabled'"),
  'new direction checkbox should be disabled unless Byreal full-copy is selected',
);
assert.ok(
  uiSource.includes('allowOpenAfterOthersCount'),
  'save summary should count allow-open-after-others wallets separately',
);
