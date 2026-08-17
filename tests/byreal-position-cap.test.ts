import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.RPC_URL ||= 'http://127.0.0.1:8899';
process.env.WS_URL ||= 'ws://127.0.0.1:8900';
process.env.BOT2_WALLET ||= '11111111111111111111111111111111';

const { normalizeByrealMaxOpenPositions } = require('../src/config') as typeof import('../src/config');
const { PositionMap } = require('../src/state/position-map') as typeof import('../src/state/position-map');
const { getByrealPositionCapStatus } = require('../src/executor/byreal-position') as typeof import('../src/executor/byreal-position');

assert.strictEqual(normalizeByrealMaxOpenPositions(undefined), 0);
assert.strictEqual(normalizeByrealMaxOpenPositions(''), 0);
assert.strictEqual(normalizeByrealMaxOpenPositions('abc'), 0);
assert.strictEqual(normalizeByrealMaxOpenPositions('-1'), 0);
assert.strictEqual(normalizeByrealMaxOpenPositions('12.5'), 0);
assert.strictEqual(normalizeByrealMaxOpenPositions('0'), 0);
assert.strictEqual(normalizeByrealMaxOpenPositions('1'), 1);
assert.strictEqual(normalizeByrealMaxOpenPositions('415'), 415);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'byreal-position-cap-'));
const filePath = path.join(dir, 'position-map.json');
const map = new PositionMap(filePath);

map.set('target-byreal-legacy', 'our-byreal-legacy', 'A/B', 'wallet-a');
map.set('target-byreal-tagged', 'our-byreal-tagged', 'A/B', 'wallet-b', undefined, undefined, 'byreal');
map.set('target-orca', 'our-orca', 'A/B', 'wallet-c', undefined, undefined, 'orca');
map.set('target-meteora', 'our-meteora', 'A/B', 'wallet-d', undefined, undefined, 'meteora');
map.set('target-pcs', 'our-pcs', 'A/B', 'wallet-e', undefined, undefined, 'pancakeswap');
map.set('target-dammv2', 'our-dammv2', 'A/B', 'wallet-f', undefined, undefined, 'dammv2');

assert.strictEqual(map.countByDex().byreal, 2);
assert.strictEqual(map.getByrealOpenCount(), 2);

assert.deepStrictEqual(getByrealPositionCapStatus(map, 0), { enabled: false, current: 2, cap: 0, reached: false, reason: null });
assert.deepStrictEqual(getByrealPositionCapStatus(map, 3), { enabled: true, current: 2, cap: 3, reached: false, reason: null });
assert.deepStrictEqual(getByrealPositionCapStatus(map, 2), {
  enabled: true,
  current: 2,
  cap: 2,
  reached: true,
  reason: 'Byreal position cap reached (2/2)',
});

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'executor', 'byreal-position.ts'), 'utf-8');
const guardIdx = source.indexOf('getByrealPositionCapStatus(this.positionMap, config.byrealMaxOpenPositions)');
assert.ok(guardIdx >= 0, 'copyOpenPosition should check Byreal position cap');
for (const marker of [
  'Copying position',
  'if (config.dryRun)',
  "return 'dry-run-open-position'",
  "this.acquire('copyOpenPosition')",
  'retryGetPosition(targetNft)',
  'getTokenBalance(userAddress, mintA)',
  'swapForToken(this.connection',
  'createPositionInstructions',
]) {
  const markerIdx = source.indexOf(marker, guardIdx);
  assert.ok(markerIdx > guardIdx, `Byreal cap guard should run before ${marker}`);
}

fs.rmSync(dir, { recursive: true, force: true });
